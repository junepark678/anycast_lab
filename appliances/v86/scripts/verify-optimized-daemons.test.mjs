// @vitest-environment node
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
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
  mtracebis: 'pimd/mtracebis',
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
  'lib/libmgmt_be_nb.so.0.0.0': 'mgmtd/.libs/libmgmt_be_nb.so.0.0.0',
  'lib/frr/modules/dplane_fpm_nl.so': 'zebra/.libs/dplane_fpm_nl.so',
  'lib/frr/modules/pathd_pcep.so': 'pathd/.libs/pathd_pcep.so',
  'lib/frr/modules/zebra_cumulus_mlag.so': 'zebra/.libs/zebra_cumulus_mlag.so',
  'lib/frr/modules/zebra_fpm.so': 'zebra/.libs/zebra_fpm.so',
};
const frrElfPaths = [
  ...Object.keys(frrProgramBuildPaths)
    .map((program) => (
      `target/usr/${['mtracebis', 'vtysh'].includes(program) ? 'bin' : 'sbin'}/${program}`
    )),
  ...Object.keys(frrLibraryBuildPaths).map((library) => `target/usr/${library}`),
];
const frrBuildElfPaths = [
  ...Object.values(frrProgramBuildPaths),
  ...Object.values(frrLibraryBuildPaths),
];
const selectedElfPaths = new Set([
  'target/usr/sbin/bird',
  'target/usr/sbin/bgpd',
  'target/usr/sbin/ospfd',
  'target/usr/sbin/zebra',
  'target/usr/lib/libfrr.so.0.0.0',
  'target/usr/lib/libmgmt_be_nb.so.0.0.0',
  'build/bird-2.15.1/bird',
  'build/frr-10.5.1/bgpd/bgpd',
  'build/frr-10.5.1/ospfd/ospfd',
  'build/frr-10.5.1/zebra/zebra',
  'build/frr-10.5.1/lib/.libs/libfrr.so.0.0.0',
  'build/frr-10.5.1/mgmtd/.libs/libmgmt_be_nb.so.0.0.0',
]);

function selectedProfileFile(path) {
  if (path.endsWith('/bird')) return 'bird.profdata';
  if (path.endsWith('/bgpd')) return 'frr-bgpd.profdata';
  if (path.endsWith('/ospfd')) return 'frr-ospfd.profdata';
  if (path.endsWith('/zebra')) return 'frr-zebra.profdata';
  if (path.endsWith('/libfrr.so.0.0.0')) return 'frr-libfrr.profdata';
  if (path.endsWith('/libmgmt_be_nb.so.0.0.0')) return 'frr-libmgmt-be-nb.profdata';
  throw new Error(`Missing selected test profile mapping for ${path}`);
}

async function optimizedFixture(mode) {
  const base = await mkdtemp(resolve(tmpdir(), 'anycast-optimized-daemons-'));
  temporaryDirectories.push(base);
  const output = resolve(base, 'output');
  const profileDirectory = resolve(base, 'profiles');
  await mkdir(profileDirectory, { recursive: true });
  if (mode === 'use') {
    for (const profile of [
      'bird.profdata',
      'frr-libfrr.profdata',
      'frr-libmgmt-be-nb.profdata',
      'frr-bgpd.profdata',
      'frr-zebra.profdata',
      'frr-ospfd.profdata',
    ]) {
      await writeFile(resolve(profileDirectory, profile), `${profile}\n`);
    }
  }
  for (const [name, version] of [
    ['bird', '2.15.1'],
    ['frr', '10.5.1'],
  ]) {
    const directory = resolve(output, `build/${name}-${version}`);
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, 'config.log'), [
      `CC='${output}/host/bin/clang --target=i686-buildroot-linux-gnu --sysroot=${output}/host/i686-buildroot-linux-gnu/sysroot --gcc-install-dir=${output}/host/lib/gcc/i686-buildroot-linux-gnu/14.3.0 --ld-path=${output}/host/bin/ld.lld'`,
      "CFLAGS='-march=pentiumpro -O3 -flto=thin'",
      "LDFLAGS='-O3 -flto=thin -fuse-ld=lld -Wl,-z,pack-relative-relocs'",
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
    const evidence = ['elf'];
    if (selectedElfPaths.has(file)) {
      evidence.push(`pgo-marker=${mode}`);
      if (mode === 'generate') evidence.push('profile-sections', 'profile-runtime');
      if (mode === 'use') {
        evidence.push(`compile-profile=${resolve(profileDirectory, selectedProfileFile(file))}`);
      }
    }
    await writeFile(path, `${evidence.join('\n')}\n`);
    await chmod(path, 0o755);
  }
  const frrServiceScript = resolve(output, 'target/usr/sbin/frr');
  await writeFile(frrServiceScript, '#!/bin/sh\n');
  await chmod(frrServiceScript, 0o755);
  const packageFileList = [
    'target/usr/sbin/bird',
    'target/usr/sbin/birdc',
    'target/usr/sbin/birdcl',
  ].map((path) => `bird,./${path.slice('target/'.length)}`);
  packageFileList.push(
    ...frrElfPaths.map((path) => `frr,./${path.slice('target/'.length)}`),
    'frr,./usr/sbin/frr',
  );
  await writeFile(
    resolve(output, 'build/packages-file-list.txt'),
    `${packageFileList.join('\n')}\n`,
  );
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
  await writeFile(nm, '#!/bin/sh\nfor file do :; done\nif grep -Fxq profile-runtime "$file"; then echo "0001 T __llvm_profile_runtime"; fi\n');
  await chmod(readelf, 0o755);
  await chmod(nm, 0o755);
  return { base, output, profileDirectory, readelf, nm };
}

async function runVerifier(fixture, mode, environment = {}) {
  return execFile('/bin/sh', [
    verifier,
    fixture.output,
    '2.15.1',
    '10.5.1',
    '21.1.8',
    mode,
    mode === 'use' ? fixture.profileDirectory : '',
  ], {
    env: {
      ...process.env,
      READELF: fixture.readelf,
      LLVM_NM: fixture.nm,
      ...environment,
    },
  });
}

async function addEvidence(fixture, relativePath, evidence) {
  const path = resolve(fixture.output, relativePath);
  await writeFile(path, `${await readFile(path, 'utf8')}${evidence}\n`);
}

async function removeEvidence(fixture, relativePath, evidence) {
  const path = resolve(fixture.output, relativePath);
  const lines = (await readFile(path, 'utf8')).split('\n').filter((line) => line !== evidence);
  await writeFile(path, lines.join('\n'));
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

  it('requires DT_RELR packing, executable PIE, and target provenance stripping', async () => {
    const missingRelr = await optimizedFixture('none');
    await expect(runVerifier(missingRelr, 'none', { FAKE_NO_RELR_FILE: 'bird' }))
      .rejects.toMatchObject({ stderr: expect.stringContaining('packed relative relocation') });

    const nonPie = await optimizedFixture('none');
    await expect(runVerifier(nonPie, 'none', { FAKE_NON_PIE_FILE: 'birdc' }))
      .rejects.toBeTruthy();

    const commandLeak = await optimizedFixture('use');
    await addEvidence(commandLeak, 'target/usr/sbin/ospfd', 'command-section');
    await expect(runVerifier(commandLeak, 'use')).rejects.toMatchObject({
      stderr: expect.stringContaining('retains Clang command-line provenance'),
    });
  });

  it.each(['generate', 'use'])('rejects package-wide %s flags that would profile unselected ELFs', async (mode) => {
    const fixture = await optimizedFixture(mode);
    const path = resolve(fixture.output, 'build/frr-10.5.1/config.log');
    const flag = mode === 'generate'
      ? '-fprofile-generate=/tmp/anycast-pgo'
      : `-fprofile-use=${fixture.profileDirectory}/frr-bgpd.profdata`;
    await writeFile(path, `${await readFile(path, 'utf8')}\nCFLAGS='${flag}'\n`);
    await expect(runVerifier(fixture, mode)).rejects.toMatchObject({
      stderr: expect.stringContaining('Unexpected optimization evidence'),
    });

    const birdFixture = await optimizedFixture(mode);
    const birdConfig = resolve(birdFixture.output, 'build/bird-2.15.1/config.log');
    await writeFile(birdConfig, `${await readFile(birdConfig, 'utf8')}\nCFLAGS='${flag}'\n`);
    await expect(runVerifier(birdFixture, mode)).rejects.toMatchObject({
      stderr: expect.stringContaining('Unexpected optimization evidence'),
    });
  }, 15_000);

  it('requires all six regular, non-symlink use profiles', async () => {
    const missing = await optimizedFixture('use');
    await rm(resolve(missing.profileDirectory, 'frr-zebra.profdata'));
    await expect(runVerifier(missing, 'use')).rejects.toMatchObject({
      stderr: expect.stringContaining('regular, non-symlink profile'),
    });

    const linked = await optimizedFixture('use');
    await rm(resolve(linked.profileDirectory, 'frr-zebra.profdata'));
    await symlink('frr-bgpd.profdata', resolve(linked.profileDirectory, 'frr-zebra.profdata'));
    await expect(runVerifier(linked, 'use')).rejects.toMatchObject({
      stderr: expect.stringContaining('regular, non-symlink profile'),
    });
  });

  it('verifies independently linked FRR daemons beyond bgpd and zebra', async () => {
    const fixture = await optimizedFixture('use');
    await expect(runVerifier(fixture, 'use', { FAKE_BAD_FILE: 'ospfd' })).rejects.toBeTruthy();
  });

  it('verifies the FRR control client but does not treat its service script as ELF', async () => {
    const fixture = await optimizedFixture('use');
    await expect(runVerifier(fixture, 'use')).resolves.toBeTruthy();
    await expect(runVerifier(fixture, 'use', { FAKE_BAD_FILE: 'vtysh' })).rejects.toBeTruthy();
  }, 15_000);

  it('requires and independently verifies every pinned FRR executable and shared ELF', async () => {
    const badModule = await optimizedFixture('use');
    await expect(runVerifier(badModule, 'use', { FAKE_BAD_FILE: 'zebra_fpm.so' })).rejects.toBeTruthy();

    const missing = await optimizedFixture('use');
    await rm(resolve(missing.output, 'target/usr/sbin/ripd'));
    await expect(runVerifier(missing, 'use')).rejects.toMatchObject({
      stderr: expect.stringContaining('Missing expected FRR executable'),
    });

    const missingManagementLibrary = await optimizedFixture('use');
    await rm(resolve(missingManagementLibrary.output, 'target/usr/lib/libmgmt_be_nb.so.0.0.0'));
    await expect(runVerifier(missingManagementLibrary, 'use')).rejects.toMatchObject({
      stderr: expect.stringContaining('Missing expected FRR shared ELF'),
    });
  }, 15_000);

  it('rejects an unexpected package-owned BIRD or FRR ELF', async () => {
    for (const packageName of ['bird', 'frr']) {
      const fixture = await optimizedFixture('use');
      const relative = `target/usr/lib/${packageName}-unexpected.so`;
      const path = resolve(fixture.output, relative);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, 'elf\n');
      await chmod(path, 0o755);
      await writeFile(
        resolve(fixture.output, 'build/packages-file-list.txt'),
        `${await readFile(resolve(fixture.output, 'build/packages-file-list.txt'), 'utf8')}` +
          `${packageName},./${relative.slice('target/'.length)}\n`,
      );
      await expect(runVerifier(fixture, 'use')).rejects.toMatchObject({
        stderr: expect.stringContaining(`Package-owned ELF inventory drifted for ${packageName}`),
      });
    }
  }, 15_000);

  it('requires generate marker, profile sections, and runtime on every selected kind', async () => {
    const missingMarker = await optimizedFixture('generate');
    await removeEvidence(missingMarker, 'target/usr/lib/libmgmt_be_nb.so.0.0.0', 'pgo-marker=generate');
    await expect(runVerifier(missingMarker, 'generate')).rejects.toMatchObject({
      stderr: expect.stringContaining('lacks mode marker'),
    });

    const missingSections = await optimizedFixture('generate');
    await removeEvidence(missingSections, 'target/usr/sbin/ospfd', 'profile-sections');
    await expect(runVerifier(missingSections, 'generate')).rejects.toMatchObject({
      stderr: expect.stringContaining('lacks LLVM profile sections'),
    });

    const missingRuntime = await optimizedFixture('generate');
    await removeEvidence(missingRuntime, 'build/frr-10.5.1/lib/.libs/libfrr.so.0.0.0', 'profile-runtime');
    await expect(runVerifier(missingRuntime, 'generate')).rejects.toMatchObject({
      stderr: expect.stringContaining('lacks compiler-rt profile runtime'),
    });
  }, 15_000);

  it('forbids every kind of PGO evidence on unselected executables and plugins', async () => {
    const marker = await optimizedFixture('generate');
    await addEvidence(marker, 'target/usr/sbin/birdc', 'pgo-marker=generate');
    await expect(runVerifier(marker, 'generate')).rejects.toMatchObject({
      stderr: expect.stringContaining('PGO-unselected ELF unexpectedly carries an anycast PGO marker'),
    });

    const sections = await optimizedFixture('generate');
    await addEvidence(sections, 'target/usr/sbin/ripd', 'profile-sections');
    await expect(runVerifier(sections, 'generate')).rejects.toMatchObject({
      stderr: expect.stringContaining('PGO-unselected ELF unexpectedly retains LLVM profile sections'),
    });

    const runtime = await optimizedFixture('generate');
    await addEvidence(runtime, 'build/frr-10.5.1/zebra/.libs/zebra_fpm.so', 'profile-runtime');
    await expect(runVerifier(runtime, 'generate')).rejects.toMatchObject({
      stderr: expect.stringContaining('PGO-unselected ELF unexpectedly retains compiler-rt profile runtime'),
    });
  }, 15_000);

  it.each(['none', 'use'])('forbids PGO markers on unselected ELFs in %s mode', async (mode) => {
    const fixture = await optimizedFixture(mode);
    await addEvidence(fixture, 'target/usr/bin/mtracebis', `pgo-marker=${mode}`);
    await expect(runVerifier(fixture, mode)).rejects.toMatchObject({
      stderr: expect.stringContaining('PGO-unselected ELF unexpectedly carries an anycast PGO marker'),
    });
  });

  it('forbids profile-use compile flags on unselected use-mode ELFs', async () => {
    const fixture = await optimizedFixture('use');
    await addEvidence(
      fixture,
      'build/frr-10.5.1/ripd/ripd',
      `compile-profile=${resolve(fixture.profileDirectory, 'frr-bgpd.profdata')}`,
    );
    await expect(runVerifier(fixture, 'use')).rejects.toMatchObject({
      stderr: expect.stringContaining('PGO-unselected use ELF contains profile-use compile flags'),
    });
  });

  it('requires use-mode selected ELFs to contain only the use marker', async () => {
    const sections = await optimizedFixture('use');
    await addEvidence(sections, 'build/frr-10.5.1/bgpd/bgpd', 'profile-sections');
    await expect(runVerifier(sections, 'use')).rejects.toMatchObject({
      stderr: expect.stringContaining('PGO-selected ELF unexpectedly retains LLVM profile sections'),
    });

    const runtime = await optimizedFixture('use');
    await addEvidence(runtime, 'build/bird-2.15.1/bird', 'profile-runtime');
    await expect(runVerifier(runtime, 'use')).rejects.toMatchObject({
      stderr: expect.stringContaining('PGO-selected ELF unexpectedly retains compiler-rt profile runtime'),
    });

    const wrongMarker = await optimizedFixture('use');
    await addEvidence(wrongMarker, 'target/usr/sbin/zebra', 'pgo-marker=generate');
    await expect(runVerifier(wrongMarker, 'use')).rejects.toMatchObject({
      stderr: expect.stringContaining('retains an unexpected anycast PGO mode marker'),
    });

    const markerOnly = await optimizedFixture('use');
    await removeEvidence(
      markerOnly,
      'build/frr-10.5.1/ospfd/ospfd',
      `compile-profile=${resolve(markerOnly.profileDirectory, 'frr-ospfd.profdata')}`,
    );
    await expect(runVerifier(markerOnly, 'use')).rejects.toMatchObject({
      stderr: expect.stringContaining('invalid component profile set'),
    });

    const wrongSuffix = await optimizedFixture('use');
    const ospfdProfile = resolve(wrongSuffix.profileDirectory, 'frr-ospfd.profdata');
    await removeEvidence(
      wrongSuffix,
      'build/frr-10.5.1/ospfd/ospfd',
      `compile-profile=${ospfdProfile}`,
    );
    await addEvidence(
      wrongSuffix,
      'build/frr-10.5.1/ospfd/ospfd',
      `compile-profile=${ospfdProfile}.evil`,
    );
    await expect(runVerifier(wrongSuffix, 'use')).rejects.toMatchObject({
      stderr: expect.stringContaining('invalid component profile set'),
    });

    const mixed = await optimizedFixture('use');
    await addEvidence(
      mixed,
      'build/frr-10.5.1/ospfd/ospfd',
      `compile-profile=${resolve(mixed.profileDirectory, 'frr-bgpd.profdata')}`,
    );
    await expect(runVerifier(mixed, 'use')).rejects.toMatchObject({
      stderr: expect.stringContaining('invalid component profile set'),
    });
  }, 15_000);

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
  }, 15_000);
});

describe('post-build PGO marker', () => {
  it.each([
    ['generate', true],
    ['none', false],
    ['use', false],
  ])('applies mode %s with marker=%s', async (mode, expected) => {
    const fixture = await postBuildFixture();
    const { target } = fixture;
    await execFile('/bin/sh', [postBuild, target], { env: postBuildEnvironment(fixture, mode) });
    const marker = resolve(target, 'etc/anycastlab/pgo-generate');
    if (expected) await expect(readFile(marker, 'utf8')).resolves.toBe('llvm-ir-pgo-generate-v1\n');
    else await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('replaces an existing read-only generate marker on repeated builds', async () => {
    const fixture = await postBuildFixture();
    const { target } = fixture;
    const environment = postBuildEnvironment(fixture, 'generate');
    await execFile('/bin/sh', [postBuild, target], { env: environment });
    await execFile('/bin/sh', [postBuild, target], { env: environment });
    await expect(readFile(resolve(target, 'etc/anycastlab/pgo-generate'), 'utf8'))
      .resolves.toBe('llvm-ir-pgo-generate-v1\n');
  });

  it('fails closed for an unknown mode', async () => {
    const fixture = await postBuildFixture();
    await expect(execFile('/bin/sh', [postBuild, fixture.target], {
      env: postBuildEnvironment(fixture, 'surprise'),
    })).rejects.toMatchObject({ stderr: expect.stringContaining('Unsupported ANYCAST_PGO_MODE') });
  });
});

async function postBuildFixture() {
  const base = await mkdtemp(resolve(tmpdir(), 'anycast-post-build-'));
  temporaryDirectories.push(base);
  const target = resolve(base, 'target');
  const host = resolve(base, 'host');
  const files = [
    'bin/busybox',
    'etc/init.d/S50frr',
    'etc/init.d/S20anycastlab',
    'usr/sbin/anycast-labd',
    'usr/libexec/anycastlab-agent',
    'usr/libexec/anycastlab-shell',
  ];
  for (const file of files) {
    const path = resolve(target, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '#!/bin/sh\n');
  }
  await writeFile(
    resolve(target, 'etc/inittab'),
    '#ttyS0::respawn:/sbin/getty -L ttyS0 115200 vt100 # GENERIC_SERIAL\n' +
      '::sysinit:/sbin/swapon -a\n::shutdown:/sbin/swapoff -a\n',
  );
  await mkdir(resolve(host, 'bin'), { recursive: true });
  for (const tool of ['readelf', 'objcopy']) {
    const path = resolve(host, `bin/i686-buildroot-linux-gnu-${tool}`);
    await writeFile(path, tool === 'readelf'
      ? '#!/bin/sh\nexit 1\n'
      : '#!/bin/sh\nexit 0\n');
    await chmod(path, 0o755);
  }
  return { base, host, target };
}

function postBuildEnvironment(fixture, mode) {
  return { ...process.env, ANYCAST_PGO_MODE: mode, HOST_DIR: fixture.host };
}

function fakeReadelf() {
  return `#!/bin/sh
for file do :; done
grep -Fxq elf "$file" || exit 3
case "$1" in
  -h)
    echo '  Class:                             ELF32'
    if [ "\${FAKE_NON_PIE_FILE:-}" = "\${file##*/}" ]; then
      echo '  Type:                              EXEC (Executable file)'
    else
      echo '  Type:                              DYN (Position-Independent Executable file)'
    fi
    echo '  Machine:                           Intel 80386'
    ;;
  -p)
    case "$2" in
      .comment)
        if [ "\${FAKE_BAD_FILE:-}" = "\${file##*/}" ]; then
          echo '  GCC: (GNU) 14.3.0'
        else
          echo '  Linker: LLD 21.1.8'
          echo '  clang version 21.1.8'
        fi
        ;;
      .GCC.command.line)
        sed -n 's/^compile-profile=/  -fprofile-use=/p' "$file"
        ;;
      *) exit 2 ;;
    esac
    ;;
  --wide)
    case "$2" in
      --dynamic)
        if [ "\${FAKE_NO_RELR_FILE:-}" != "\${file##*/}" ]; then
          echo ' 0x00000024 (RELR)                    0x1000'
          echo ' 0x00000023 (RELRSZ)                  64 (bytes)'
          echo ' 0x00000025 (RELRENT)                 4 (bytes)'
        fi
        if [ "\${FAKE_NON_PIE_FILE:-}" != "\${file##*/}" ]; then
          echo ' 0x6ffffffb (FLAGS_1)                  Flags: NOW PIE'
        fi
        ;;
      --dyn-syms)
        echo '  __anycast_clang_21_1_8'
        echo '  __anycast_o3_thinlto'
        sed -n 's/^pgo-marker=/  __anycast_pgo_/p' "$file"
        ;;
      --sections)
        if grep -Fxq profile-sections "$file"; then echo '  [10] __llvm_prf_cnts PROGBITS'; fi
        if grep -Fxq command-section "$file"; then echo '  [11] .GCC.command.line PROGBITS'; fi
        ;;
      *) exit 2 ;;
    esac
    ;;
  *) exit 2 ;;
esac
`;
}
