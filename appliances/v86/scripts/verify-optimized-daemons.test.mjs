// @vitest-environment node
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFile = promisify(execFileCallback);
const temporaryDirectories = [];
const verifier = resolve(import.meta.dirname, 'verify-optimized-daemons.sh');
const postBuild = resolve(import.meta.dirname, '../buildroot/board/post-build.sh');
const frrProgramBuildPaths = {
  babeld: 'babeld/babeld',
  bfdd: 'bfdd/bfdd',
  bgpd: 'bgpd/bgpd',
  eigrpd: 'eigrpd/eigrpd',
  fabricd: 'isisd/fabricd',
  fpm_listener: 'zebra/fpm_listener',
  isisd: 'isisd/isisd',
  ldpd: 'ldpd/ldpd',
  mgmtd: 'mgmtd/mgmtd',
  ospf6d: 'ospf6d/ospf6d',
  ospfd: 'ospfd/ospfd',
  pathd: 'pathd/pathd',
  pbrd: 'pbrd/pbrd',
  pim6d: 'pimd/pim6d',
  pimd: 'pimd/pimd',
  ripd: 'ripd/ripd',
  ripngd: 'ripngd/ripngd',
  ssd: 'tools/ssd',
  staticd: 'staticd/staticd',
  vrrpd: 'vrrpd/vrrpd',
  watchfrr: 'watchfrr/watchfrr',
  zebra: 'zebra/zebra',
  vtysh: 'vtysh/vtysh',
};
const frrLibraryBuildPaths = {
  'lib/libfrr.so.0.0.0': 'lib/.libs/libfrr.so.0.0.0',
  'lib/frr/modules/dplane_fpm_nl.so': 'zebra/.libs/dplane_fpm_nl.so',
  'lib/frr/modules/pathd_pcep.so': 'pathd/.libs/pathd_pcep.so',
  'lib/frr/modules/zebra_cumulus_mlag.so': 'zebra/.libs/zebra_cumulus_mlag.so',
  'lib/frr/modules/zebra_fpm.so': 'zebra/.libs/zebra_fpm.so',
};
const frrElfPaths = [
  ...Object.keys(frrProgramBuildPaths)
    .filter((program) => program !== 'vtysh')
    .map((program) => `target/usr/sbin/${program}`),
  'target/usr/bin/vtysh',
  ...Object.keys(frrLibraryBuildPaths).map((library) => `target/usr/${library}`),
];
const frrBuildElfPaths = [
  ...Object.values(frrProgramBuildPaths),
  ...Object.values(frrLibraryBuildPaths),
];

async function optimizedFixture(mode) {
  const base = await mkdtemp(resolve(tmpdir(), 'anycast-optimized-daemons-'));
  temporaryDirectories.push(base);
  const output = resolve(base, 'output');
  const birdProfile = resolve(base, 'profiles/bird.profdata');
  const frrProfile = resolve(base, 'profiles/frr.profdata');
  const profileFlags = mode === 'generate'
    ? '-fprofile-generate=/tmp/anycast-pgo -fprofile-update=atomic'
    : mode === 'use'
      ? `-fprofile-use=PROFILE -Werror=profile-instr-out-of-date`
      : '';
  for (const [name, version] of [
    ['bird', '2.15.1'],
    ['frr', '10.5.1'],
  ]) {
    const directory = resolve(output, `build/${name}-${version}`);
    await mkdir(directory, { recursive: true });
    const flags = profileFlags.replace('PROFILE', name === 'bird' ? birdProfile : frrProfile);
    await writeFile(resolve(directory, 'config.log'), [
      `CC='${output}/host/bin/clang --target=i686-buildroot-linux-gnu --sysroot=${output}/host/i686-buildroot-linux-gnu/sysroot --gcc-install-dir=${output}/host/lib/gcc/i686-buildroot-linux-gnu/14.3.0 --ld-path=${output}/host/bin/ld.lld'`,
      `CFLAGS='-march=pentiumpro -O3 -flto=thin ${flags}'`,
      `LDFLAGS='-O3 -flto=thin -fuse-ld=lld ${flags}'`,
    ].join('\n'));
  }
  const files = [
    'target/usr/sbin/bird',
    'target/usr/sbin/birdc',
    'target/usr/sbin/birdcl',
    ...frrElfPaths,
    'build/bird-2.15.1/bird',
    'build/bird-2.15.1/birdc',
    'build/bird-2.15.1/birdcl',
    ...frrBuildElfPaths.map((path) => `build/frr-10.5.1/${path}`),
  ];
  for (const file of files) {
    const path = resolve(output, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'elf');
    await chmod(path, 0o755);
  }
  const frrServiceScript = resolve(output, 'target/usr/sbin/frr');
  await writeFile(frrServiceScript, '#!/bin/sh\n');
  await chmod(frrServiceScript, 0o755);
  if (mode === 'generate') {
    const marker = resolve(output, 'target/etc/anycastlab/pgo-generate');
    await mkdir(dirname(marker), { recursive: true });
    await writeFile(marker, 'llvm-ir-pgo-generate-v1\n');
  }
  const tools = resolve(base, 'tools');
  await mkdir(tools);
  const readelf = resolve(tools, 'readelf');
  const nm = resolve(tools, 'llvm-nm');
  await writeFile(readelf, fakeReadelf());
  await writeFile(nm, '#!/bin/sh\nif [ "${FAKE_PROFILE_RUNTIME:-0}" = 1 ]; then echo "0001 T __llvm_profile_runtime"; fi\n');
  await chmod(readelf, 0o755);
  await chmod(nm, 0o755);
  return { base, output, birdProfile, frrProfile, readelf, nm };
}

async function runVerifier(fixture, mode, environment = {}) {
  return execFile('/bin/sh', [
    verifier,
    fixture.output,
    '2.15.1',
    '10.5.1',
    '21.1.8',
    mode,
    mode === 'use' ? fixture.birdProfile : '',
    mode === 'use' ? fixture.frrProfile : '',
  ], {
    env: {
      ...process.env,
      READELF: fixture.readelf,
      LLVM_NM: fixture.nm,
      FAKE_PGO_MODE: mode,
      FAKE_PROFILE_RUNTIME: mode === 'generate' ? '1' : '0',
      ...environment,
    },
  });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('optimized daemon shell verifier', () => {
  it.each(['none', 'generate', 'use'])('accepts complete %s provenance', async (mode) => {
    const fixture = await optimizedFixture(mode);
    await expect(runVerifier(fixture, mode)).resolves.toMatchObject({
      stdout: expect.stringContaining(`PGO mode ${mode}`),
    });
  });

  it('rejects missing O3/ThinLTO configuration evidence', async () => {
    const fixture = await optimizedFixture('none');
    const path = resolve(fixture.output, 'build/bird-2.15.1/config.log');
    await writeFile(path, (await readFile(path, 'utf8')).replaceAll('-O3', '-O2'));
    await expect(runVerifier(fixture, 'none')).rejects.toMatchObject({ stderr: expect.stringContaining('-O3') });
  });

  it('verifies independently linked FRR daemons beyond bgpd and zebra', async () => {
    const fixture = await optimizedFixture('use');
    await expect(runVerifier(fixture, 'use', { FAKE_BAD_FILE: 'ospfd' })).rejects.toBeTruthy();
  });

  it('verifies the FRR control client but does not treat its service script as ELF', async () => {
    const fixture = await optimizedFixture('use');
    await expect(runVerifier(fixture, 'use')).resolves.toBeTruthy();
    await expect(runVerifier(fixture, 'use', { FAKE_BAD_FILE: 'vtysh' })).rejects.toBeTruthy();
  });

  it('requires and independently verifies every pinned FRR executable and shared ELF', async () => {
    const badModule = await optimizedFixture('use');
    await expect(runVerifier(badModule, 'use', { FAKE_BAD_FILE: 'zebra_fpm.so' })).rejects.toBeTruthy();

    const missing = await optimizedFixture('use');
    await rm(resolve(missing.output, 'target/usr/sbin/ripd'));
    await expect(runVerifier(missing, 'use')).rejects.toMatchObject({
      stderr: expect.stringContaining('Missing expected FRR executable'),
    });
  });

  it('rejects missing generate runtime and runtime retained by a use build', async () => {
    const generate = await optimizedFixture('generate');
    await expect(runVerifier(generate, 'generate', { FAKE_PROFILE_RUNTIME: '0' })).rejects.toMatchObject({
      stderr: expect.stringContaining('lacks compiler-rt profile runtime'),
    });
    const use = await optimizedFixture('use');
    await expect(runVerifier(use, 'use', { FAKE_PROFILE_RUNTIME: '1' })).rejects.toMatchObject({
      stderr: expect.stringContaining('unexpectedly retains profile runtime'),
    });
  });

  it('rejects host compiler-rt leakage and incorrect generate markers', async () => {
    const leaked = await optimizedFixture('use');
    const runtime = resolve(leaked.output, 'target/usr/lib/libclang_rt.profile-i386.a');
    await mkdir(dirname(runtime), { recursive: true });
    await writeFile(runtime, 'leak');
    await expect(runVerifier(leaked, 'use')).rejects.toMatchObject({
      stderr: expect.stringContaining('leaked into the target'),
    });

    const marker = await optimizedFixture('none');
    const path = resolve(marker.output, 'target/etc/anycastlab/pgo-generate');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'unexpected\n');
    await expect(runVerifier(marker, 'none')).rejects.toBeTruthy();
  });
});

describe('post-build PGO marker', () => {
  it.each([
    ['generate', true],
    ['none', false],
    ['use', false],
  ])('applies mode %s with marker=%s', async (mode, expected) => {
    const target = await postBuildFixture();
    await execFile('/bin/sh', [postBuild, target], { env: { ...process.env, ANYCAST_PGO_MODE: mode } });
    const marker = resolve(target, 'etc/anycastlab/pgo-generate');
    if (expected) await expect(readFile(marker, 'utf8')).resolves.toBe('llvm-ir-pgo-generate-v1\n');
    else await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('replaces an existing read-only generate marker on repeated builds', async () => {
    const target = await postBuildFixture();
    const environment = { ...process.env, ANYCAST_PGO_MODE: 'generate' };
    await execFile('/bin/sh', [postBuild, target], { env: environment });
    await execFile('/bin/sh', [postBuild, target], { env: environment });
    await expect(readFile(resolve(target, 'etc/anycastlab/pgo-generate'), 'utf8'))
      .resolves.toBe('llvm-ir-pgo-generate-v1\n');
  });

  it('fails closed for an unknown mode', async () => {
    const target = await postBuildFixture();
    await expect(execFile('/bin/sh', [postBuild, target], {
      env: { ...process.env, ANYCAST_PGO_MODE: 'surprise' },
    })).rejects.toMatchObject({ stderr: expect.stringContaining('Unsupported ANYCAST_PGO_MODE') });
  });
});

async function postBuildFixture() {
  const base = await mkdtemp(resolve(tmpdir(), 'anycast-post-build-'));
  temporaryDirectories.push(base);
  const files = [
    'etc/init.d/S50frr',
    'etc/init.d/S20anycastlab',
    'usr/libexec/anycastlab-agent',
    'usr/libexec/anycastlab-shell',
  ];
  for (const file of files) {
    const path = resolve(base, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '#!/bin/sh\n');
  }
  await writeFile(resolve(base, 'etc/inittab'), 'ttyS0::respawn:/sbin/getty -L -n -l /bin/sh ttyS0 115200 vt100\n');
  return base;
}

function fakeReadelf() {
  return `#!/bin/sh
for file do :; done
grep -Fxq elf "$file" || exit 3
case "$1" in
  -h)
    echo '  Class:                             ELF32'
    echo '  Machine:                           Intel 80386'
    ;;
  -p)
    if [ "\${FAKE_BAD_FILE:-}" = "\${file##*/}" ]; then
      echo '  GCC: (GNU) 14.3.0'
    else
      echo '  Linker: LLD 21.1.8'
      echo '  clang version 21.1.8'
    fi
    ;;
  --wide)
    case "$2" in
      --dyn-syms)
        echo '  __anycast_clang_21_1_8'
        echo '  __anycast_o3_thinlto'
        echo "  __anycast_pgo_\${FAKE_PGO_MODE}"
        ;;
      --sections)
        if [ "\${FAKE_PGO_MODE}" = generate ]; then echo '  [10] __llvm_prf_cnts PROGBITS'; fi
        ;;
      *) exit 2 ;;
    esac
    ;;
  *) exit 2 ;;
esac
`;
}
