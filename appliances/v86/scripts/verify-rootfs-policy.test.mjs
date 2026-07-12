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
const verifier = resolve(import.meta.dirname, 'verify-rootfs-policy.sh');
const postBuild = resolve(import.meta.dirname, '../buildroot/board/post-build.sh');
const postFakeroot = resolve(import.meta.dirname, '../buildroot/board/post-fakeroot.sh');
const temporaryDirectories = [];

const requiredExecutables = [
  'bin/bash',
  'bin/busybox',
  'bin/stty',
  'sbin/bridge',
  'sbin/ip',
  'sbin/ss',
  'sbin/tc',
  'usr/bin/tcpdump',
  'usr/bin/traceroute',
  'usr/bin/vtysh',
  'usr/libexec/anycastlab-frr',
  'usr/sbin/anycast-labd',
  'usr/sbin/bgpd',
  'usr/sbin/bird',
  'usr/sbin/birdc',
  'usr/sbin/birdcl',
  'usr/sbin/frrinit.sh',
  'usr/sbin/frrcommon.sh',
  'usr/sbin/frr',
  'usr/sbin/ospfd',
  'usr/sbin/watchfrr.sh',
  'usr/sbin/zebra',
];

const bashScripts = new Set([
  'usr/sbin/frrinit.sh',
  'usr/sbin/frrcommon.sh',
  'usr/sbin/frr',
  'usr/sbin/watchfrr.sh',
]);

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

async function makeExecutable(path, contents = '#!/bin/sh\n') {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
  await chmod(path, 0o755);
}

async function rootfsFixture() {
  const base = await mkdtemp(resolve(tmpdir(), 'anycast-rootfs-policy-'));
  temporaryDirectories.push(base);
  const output = resolve(base, 'output');
  const target = resolve(output, 'target');
  const archive = resolve(output, 'images/rootfs.cpio');
  const readelf = resolve(base, 'readelf');

  for (const executable of requiredExecutables) {
    await makeExecutable(
      resolve(target, executable),
      bashScripts.has(executable) ? '#!/bin/bash\n' : '#!/bin/sh\n',
    );
  }
  await symlink('busybox', resolve(target, 'bin/sh'));
  await symlink('busybox', resolve(target, 'bin/ping'));
  await symlink('busybox', resolve(target, 'bin/ping6'));
  await makeExecutable(resolve(target, 'etc/init.d/S01syslogd'));
  await makeExecutable(resolve(target, 'etc/init.d/S20anycastlab'));
  await mkdir(resolve(target, 'etc/default'), { recursive: true });
  await writeFile(
    resolve(target, 'etc/default/syslogd'),
    'SYSLOGD_ARGS="-O /run/messages -s 64 -b 1"\n',
  );
  await mkdir(resolve(target, 'tmp'), { recursive: true });
  await mkdir(resolve(target, 'var/tmp'), { recursive: true });
  await mkdir(resolve(target, 'etc'), { recursive: true });
  await writeFile(
    resolve(target, 'etc/inittab'),
    '::sysinit:/etc/init.d/rcS\n',
  );

  await makeExecutable(readelf, `#!/bin/sh
action=$1
for file do :; done
case "$action" in
  --dynamic)
    sed -n 's/^elf-needs=\\(.*\\)$/ 0x00000001 (NEEDED) Shared library: [\\1]/p' "$file"
    ;;
  --program-headers)
    sed -n 's|^elf-interpreter=\\(.*\\)$|      [Requesting program interpreter: \\1]|p' "$file"
    ;;
  --sections)
    grep -Fxq command-section "$file" && echo '  [11] .GCC.command.line PROGBITS'
    ;;
  *) exit 2 ;;
esac
`);

  async function pack() {
    await mkdir(dirname(archive), { recursive: true });
    await execFile('/bin/sh', [
      '-c',
      'find . -print | LC_ALL=C cpio --quiet -o -H newc > "$1"',
      'pack-rootfs',
      archive,
    ], { cwd: target });
  }

  async function run() {
    return execFile('/bin/sh', [verifier, output], {
      env: { ...process.env, READELF: readelf },
    });
  }

  await pack();
  return { base, output, target, archive, readelf, pack, run };
}

describe('rootfs policy verifier', () => {
  it('pins the external-root and curated BusyBox build contract', async () => {
    const defconfig = await readFile(
      resolve(import.meta.dirname, '../buildroot/configs/anycast_lab_v86_defconfig'),
      'utf8',
    );
    const busybox = await readFile(
      resolve(import.meta.dirname, '../buildroot/board/busybox-shared.config'),
      'utf8',
    );
    const buildImage = await readFile(
      resolve(import.meta.dirname, 'build-image.sh'),
      'utf8',
    );
    for (const disabledFilesystem of ['INITRAMFS', 'CPIO', 'TAR']) {
      expect(defconfig).toContain(`# BR2_TARGET_ROOTFS_${disabledFilesystem} is not set`);
      expect(defconfig).not.toMatch(new RegExp(`^BR2_TARGET_ROOTFS_${disabledFilesystem}=y$`, 'm'));
    }
    expect(defconfig).toContain('BR2_PACKAGE_BASH=y');
    expect(defconfig).toContain('BR2_ROOTFS_POST_FAKEROOT_SCRIPT=');
    expect(defconfig).toContain('# BR2_TARGET_GENERIC_REMOUNT_ROOTFS_RW is not set');
    for (const applet of ['INIT', 'MOUNT', 'UMOUNT', 'STTY', 'PING', 'PING6']) {
      expect(busybox).toMatch(new RegExp(`^CONFIG_${applet}=y$`, 'm'));
    }
    for (const removedApplet of ['TAR', 'BASE64', 'GZIP', 'GUNZIP', 'ZCAT']) {
      expect(busybox).toContain(`# CONFIG_${removedApplet} is not set`);
    }
    expect(busybox).toContain('# CONFIG_FEATURE_SUID is not set');
    expect(busybox).toContain('# CONFIG_GETTY is not set');
    expect(busybox).toContain('CONFIG_FEATURE_ROTATE_LOGFILE=y');

    const staleCpioCleanup = buildImage.indexOf('"$OUTPUT/images/rootfs.cpio".*');
    const staleTarCleanup = buildImage.indexOf('"$OUTPUT/images/rootfs.tar".*');
    const policyVerification = buildImage.indexOf('"$ROOT/scripts/verify-rootfs-policy.sh"');
    expect(staleCpioCleanup).toBeGreaterThan(-1);
    expect(staleTarCleanup).toBeGreaterThan(-1);
    expect(policyVerification).toBeGreaterThan(staleCpioCleanup);
    expect(policyVerification).toBeGreaterThan(staleTarCleanup);
  });

  it('accepts a complete current/external-root userspace with preserved FRR Bash scripts', async () => {
    const fixture = await rootfsFixture();
    await expect(fixture.run()).resolves.toMatchObject({
      stdout: expect.stringContaining('Verified curated, dependency-complete, non-setuid appliance rootfs'),
    });
  });

  it('accepts the external-root-only build without manufacturing a redundant cpio', async () => {
    const fixture = await rootfsFixture();
    await rm(fixture.archive);
    await expect(fixture.run()).resolves.toMatchObject({
      stdout: expect.not.stringContaining('cpio artifact'),
    });
  });

  it('rejects missing ELF dependencies, script interpreters, and FRR Bash drift', async () => {
    const missingLibrary = await rootfsFixture();
    await writeFile(
      resolve(missingLibrary.target, 'usr/sbin/bgpd'),
      '#!/bin/sh\nelf-needs=libmissing.so.1\n',
    );
    await expect(missingLibrary.run()).rejects.toMatchObject({
      stderr: expect.stringContaining('target runtime dependency closure is incomplete'),
    });

    const missingInterpreter = await rootfsFixture();
    await writeFile(resolve(missingInterpreter.target, 'usr/bin/vtysh'), '#!/missing-shell\n');
    await expect(missingInterpreter.run()).rejects.toMatchObject({
      stderr: expect.stringContaining('unavailable shebang interpreter'),
    });

    const bashDrift = await rootfsFixture();
    await writeFile(resolve(bashDrift.target, 'usr/sbin/frrinit.sh'), '#!/bin/sh\n');
    await expect(bashDrift.run()).rejects.toMatchObject({
      stderr: expect.stringContaining('lost its Bash contract'),
    });
  });

  it('rejects writable-root boot, a host serial shell, and unbounded persistent logging', async () => {
    const writableRoot = await rootfsFixture();
    await writeFile(
      resolve(writableRoot.target, 'etc/inittab'),
      '::sysinit:/bin/mount -o remount,rw /\n',
    );
    await expect(writableRoot.run()).rejects.toMatchObject({
      stderr: expect.stringContaining('writable-root action survived'),
    });

    const hostShell = await rootfsFixture();
    await writeFile(
      resolve(hostShell.target, 'etc/inittab'),
      'ttyS0::respawn:/bin/sh\n',
    );
    await expect(hostShell.run()).rejects.toMatchObject({
      stderr: expect.stringContaining('host serial shell survived'),
    });

    const unboundedLog = await rootfsFixture();
    await writeFile(
      resolve(unboundedLog.target, 'etc/default/syslogd'),
      'SYSLOGD_ARGS="-O /var/log/messages"\n',
    );
    await expect(unboundedLog.run()).rejects.toMatchObject({
      stderr: expect.stringContaining('syslog is not bounded to writable tmpfs'),
    });
  });

  it('allows dependency-backed companion libraries but rejects dead survivors', async () => {
    const used = await rootfsFixture();
    await mkdir(resolve(used.target, 'usr/lib'), { recursive: true });
    await writeFile(resolve(used.target, 'usr/lib/libform.so.6'), 'library\n');
    await writeFile(
      resolve(used.target, 'usr/sbin/bgpd'),
      '#!/bin/sh\nelf-needs=libform.so.6\n',
    );
    await expect(used.run()).resolves.toBeTruthy();

    const dead = await rootfsFixture();
    await mkdir(resolve(dead.target, 'usr/lib'), { recursive: true });
    await writeFile(resolve(dead.target, 'usr/lib/libmenu.so.6'), 'library\n');
    await expect(dead.run()).rejects.toMatchObject({
      stderr: expect.stringContaining('unreferenced companion library survived'),
    });
  });

  it('checks final cpio metadata and contents, not only the staging tree', async () => {
    const privileged = await rootfsFixture();
    const privilegedFile = resolve(privileged.target, 'bin/privileged');
    await makeExecutable(privilegedFile);
    await chmod(privilegedFile, 0o4755);
    await privileged.pack();
    await chmod(privilegedFile, 0o755);
    await expect(privileged.run()).rejects.toMatchObject({
      stderr: expect.stringContaining('cpio artifact contains setuid or setgid files'),
    });

    const scratch = await rootfsFixture();
    await writeFile(resolve(scratch.target, 'tmp/stale-profile'), 'leak\n');
    await scratch.pack();
    await rm(resolve(scratch.target, 'tmp/stale-profile'));
    await expect(scratch.run()).rejects.toMatchObject({
      stderr: expect.stringContaining('cpio artifact contains stale scratch files'),
    });
  });
});

describe('rootfs build hooks', () => {
  it('strips fakeroot privilege bits from the final archive input', async () => {
    const base = await mkdtemp(resolve(tmpdir(), 'anycast-post-fakeroot-'));
    temporaryDirectories.push(base);
    const file = resolve(base, 'bin/busybox');
    await makeExecutable(file);
    await chmod(file, 0o6755);
    await execFile('/bin/sh', [postFakeroot, base]);
    await expect((await import('node:fs/promises')).stat(file).then((entry) => entry.mode & 0o6000))
      .resolves.toBe(0);
  });

  it('retains a newly needed optional library and prunes an unreferenced one', async () => {
    const fixture = await rootfsFixture();
    const host = resolve(fixture.base, 'host');
    const targetReadelf = resolve(host, 'bin/i686-buildroot-linux-gnu-readelf');
    const targetObjcopy = resolve(host, 'bin/i686-buildroot-linux-gnu-objcopy');
    await mkdir(dirname(targetReadelf), { recursive: true });
    await writeFile(targetReadelf, await readFile(fixture.readelf, 'utf8'));
    await chmod(targetReadelf, 0o755);
    await makeExecutable(targetObjcopy, '#!/bin/sh\nexit 0\n');

    await mkdir(resolve(fixture.target, 'usr/lib'), { recursive: true });
    await writeFile(resolve(fixture.target, 'usr/lib/libform.so.6'), 'library\n');
    await writeFile(resolve(fixture.target, 'usr/lib/libmenu.so.6'), 'library\n');
    await writeFile(
      resolve(fixture.target, 'usr/sbin/bgpd'),
      '#!/bin/sh\nelf-needs=libform.so.6\n',
    );
    await makeExecutable(resolve(fixture.target, 'etc/init.d/S50frr'));

    await execFile('/bin/sh', [postBuild, fixture.target], {
      env: { ...process.env, HOST_DIR: host, ANYCAST_PGO_MODE: 'none' },
    });
    await expect(readFile(resolve(fixture.target, 'usr/lib/libform.so.6')))
      .resolves.toBeTruthy();
    await expect(readFile(resolve(fixture.target, 'usr/lib/libmenu.so.6')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(resolve(fixture.target, 'usr/libexec/anycastlab-frr'), 'utf8'))
      .resolves.toContain('#!/bin/sh');
  });
});
