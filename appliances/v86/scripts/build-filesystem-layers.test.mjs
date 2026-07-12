// @vitest-environment node
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildFilesystemLayers } from './build-filesystem-layers.mjs';
import {
  FILESYSTEM_LAYER_DEFINITIONS,
  FILESYSTEM_LAYOUT,
  validateFilesystemMetadata,
} from './filesystem-layout.mjs';

const temporaryDirectories = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(resolve(tmpdir(), 'anycast-filesystem-layers-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function createFile(root, path, contents = path) {
  const destination = resolve(root, path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, contents);
}

async function createPackageManifest(build, packageName, paths) {
  const directory = resolve(build, `${packageName}-fixture`);
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, '.stamp_target_installed'), '');
  await writeFile(
    resolve(directory, '.files-list.txt'),
    `${paths.map((path) => `${packageName},./${path}`).join('\n')}\n`,
  );
}

async function createFixture(root) {
  const target = resolve(root, 'target');
  const build = resolve(root, 'build');
  await mkdir(target, { recursive: true });
  const base = [
    'bin/busybox',
    'etc/init.d/S20anycastlab',
    'lib/libc.so',
    'sbin/init',
    'usr/sbin/anycast-labd',
  ];
  const bird = ['usr/sbin/bird', 'usr/sbin/birdc', 'usr/sbin/birdcl'];
  const frr = [
    'usr/bin/vtysh',
    'usr/lib/libfrr.so',
    'usr/lib/libfrr.so.0',
    'usr/lib/libmgmt_be_nb.so',
    'usr/lib/libmgmt_be_nb.so.0',
    'usr/lib/frr/modules/dplane.so',
    'usr/sbin/bgpd',
    'usr/sbin/ospfd',
    'usr/sbin/staticd',
    'usr/sbin/zebra',
    'usr/share/yang/frr-bgp.yang',
    'usr/share/yang/ietf-interfaces.yang',
  ];
  const toolboxPackages = {
    libpcap: ['usr/lib/libpcap.so'],
    tcpdump: ['usr/bin/tcpdump'],
    traceroute: ['usr/bin/traceroute'],
  };
  for (const path of [...base, ...bird, ...frr, ...Object.values(toolboxPackages).flat()]) {
    await createFile(target, path);
  }
  await symlink('busybox', resolve(target, 'bin/sh'));
  await symlink('busybox', resolve(target, 'bin/ping'));
  await symlink('busybox', resolve(target, 'bin/ping6'));
  await createFile(target, 'bin/bash');
  await createFile(target, 'etc/bird.conf', 'router id 192.0.2.1;\n');
  await createFile(target, 'etc/frr/frr.conf', 'frr defaults traditional\n');
  await createFile(target, 'etc/frr/vtysh.conf', 'service integrated-vtysh-config\n');
  await createFile(target, 'usr/libexec/anycastlab-frr', '#!/bin/sh\n');
  await mkdir(resolve(target, 'var/run/frr'), { recursive: true });
  await createPackageManifest(build, 'bird', bird);
  await createPackageManifest(build, 'bash', ['bin/bash']);
  await createPackageManifest(build, 'frr', frr);
  for (const [packageName, paths] of Object.entries(toolboxPackages)) {
    await createPackageManifest(build, packageName, paths);
  }
  return { build, target };
}

async function createFakeMksquashfs(root, { injectPrivilegedEntry = false } = {}) {
  const executable = resolve(
    root,
    injectPrivilegedEntry ? 'fake-mksquashfs-privileged.mjs' : 'fake-mksquashfs.mjs',
  );
  await writeFile(executable, `#!/usr/bin/env node
import { lstat, readFile, readdir, readlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const [source, destination, ...options] = process.argv.slice(2);
if (
  process.env.SOURCE_DATE_EPOCH !== undefined &&
  options.some((option) => ['-mkfs-time', '-fstime', '-all-time'].includes(option))
) {
  throw new Error('SOURCE_DATE_EPOCH conflicts with explicit timestamp options');
}
const entries = [];
async function visit(directory, parent = '') {
  const children = (await readdir(directory)).sort();
  for (const name of children) {
    const path = parent === '' ? name : parent + '/' + name;
    const absolute = resolve(directory, name);
    const metadata = await lstat(absolute);
    if (metadata.isDirectory()) {
      entries.push({ path, type: 'directory', mode: metadata.mode & 0o7777 });
      await visit(absolute, path);
    } else if (metadata.isSymbolicLink()) {
      entries.push({
        path,
        type: 'symlink',
        mode: metadata.mode & 0o7777,
        target: await readlink(absolute),
      });
    } else {
      entries.push({
        path,
        type: 'file',
        mode: metadata.mode & 0o7777,
        contents: (await readFile(absolute)).toString('base64'),
      });
    }
  }
}
if (${JSON.stringify(injectPrivilegedEntry)}) {
  entries.push({ path: 'injected-setuid', type: 'file', mode: 0o4755, contents: '' });
}
await visit(source);
await writeFile(destination, JSON.stringify({ entries, options }));
`);
  await chmod(executable, 0o755);
  return executable;
}

async function createFakeUnsquashfs(root) {
  const executable = resolve(root, 'fake-unsquashfs.mjs');
  await writeFile(executable, `#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const artifact = JSON.parse(await readFile(process.argv.at(-1), 'utf8'));
const modeString = (entry) => {
  const kind = entry.type === 'directory' ? 'd' : entry.type === 'symlink' ? 'l' : '-';
  const mode = entry.mode ?? (entry.type === 'directory' ? 0o755 : 0o777);
  const bit = (mask, character) => (mode & mask) !== 0 ? character : '-';
  const ownerExecute = (mode & 0o4000) !== 0
    ? ((mode & 0o100) !== 0 ? 's' : 'S')
    : bit(0o100, 'x');
  const groupExecute = (mode & 0o2000) !== 0
    ? ((mode & 0o010) !== 0 ? 's' : 'S')
    : bit(0o010, 'x');
  return kind + bit(0o400, 'r') + bit(0o200, 'w') + ownerExecute +
    bit(0o040, 'r') + bit(0o020, 'w') + groupExecute +
    bit(0o004, 'r') + bit(0o002, 'w') + bit(0o001, 'x');
};
process.stdout.write('drwxr-xr-x 0/0 0 2026-06-16 00:00 squashfs-root\\n');
for (const entry of artifact.entries) {
  process.stdout.write(modeString(entry) + ' 0/0 0 2026-06-16 00:00 squashfs-root/' + entry.path + '\\n');
}
`);
  await chmod(executable, 0o755);
  return executable;
}

async function createFakeReadelf(root) {
  const executable = resolve(root, 'fake-readelf.mjs');
  await writeFile(executable, `#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const bytes = await readFile(process.argv.at(-1));
if (!bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) process.exit(1);
const payload = bytes.subarray(4).toString('utf8');
for (const match of payload.matchAll(/^needed=(.+)$/gm)) {
  process.stdout.write(' 0x00000001 (NEEDED) Shared library: [' + match[1] + ']\\n');
}
for (const match of payload.matchAll(/^interpreter=(.+)$/gm)) {
  process.stdout.write('      [Requesting program interpreter: ' + match[1] + ']\\n');
}
`);
  await chmod(executable, 0o755);
  return executable;
}

async function snapshotTree(root, parent = '') {
  const paths = [];
  const names = (await readdir(resolve(root, parent))).sort();
  for (const name of names) {
    const path = parent === '' ? name : `${parent}/${name}`;
    const metadata = await lstat(resolve(root, path));
    if (metadata.isDirectory()) {
      paths.push({ path, type: 'directory', mode: metadata.mode & 0o7777 });
      paths.push(...await snapshotTree(root, path));
    } else if (metadata.isSymbolicLink()) {
      paths.push({
        path,
        type: 'symlink',
        mode: metadata.mode & 0o7777,
        target: await readlink(resolve(root, path)),
      });
    } else {
      paths.push({
        path,
        type: 'file',
        mode: metadata.mode & 0o7777,
        contents: (await readFile(resolve(root, path))).toString('base64'),
      });
    }
  }
  return paths;
}

async function build(
  root,
  fixture,
  mksquashfs,
  name,
  unsquashfs = undefined,
  readelf = undefined,
) {
  return buildFilesystemLayers({
    targetDirectory: fixture.target,
    outputDirectory: resolve(root, `${name}-output`),
    workDirectory: resolve(root, `${name}-work`),
    buildrootBuildDirectory: fixture.build,
    mksquashfs,
    unsquashfs: unsquashfs ?? await createFakeUnsquashfs(root),
    readelf,
    sourceDateEpoch: 1_781_643_617,
  });
}

async function layerContents(root, name, layer) {
  const artifact = JSON.parse(await readFile(
    resolve(root, `${name}-output`, layer.file),
    'utf8',
  ));
  return {
    entries: artifact.entries,
    paths: artifact.entries.filter((entry) => entry.type !== 'directory').map((entry) => entry.path),
    options: artifact.options,
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('filesystem layer assembly', () => {
  it('reapplies board hardening after Buildroot package permission tables', async () => {
    const wrapper = await readFile(
      resolve(import.meta.dirname, 'build-filesystem-layers.sh'),
      'utf8',
    );
    const makedevs = wrapper.indexOf('"$MAKEDEVS" -d "$DEVICE_TABLE" "$TARGET"');
    const postFakeroot = wrapper.indexOf('post-fakeroot.sh" "$TARGET"');
    const builder = wrapper.indexOf('build-filesystem-layers.mjs');
    expect(makedevs).toBeGreaterThan(-1);
    expect(postFakeroot).toBeGreaterThan(makedevs);
    expect(builder).toBeGreaterThan(postFakeroot);
    expect(wrapper).toContain('--unsquashfs "$UNSQUASHFS"');
    expect(wrapper).toContain('--readelf "$READELF"');
  });

  it('keeps complete, BIRD, whole-FRR and diagnostic contents in deterministic mount units', async () => {
    const root = await temporaryDirectory();
    const fixture = await createFixture(root);
    const mksquashfs = await createFakeMksquashfs(root);
    const result = await build(root, fixture, mksquashfs, 'first');

    expect(result.filesystem.layers.map((layer) => layer.id))
      .toEqual(FILESYSTEM_LAYER_DEFINITIONS.map((layer) => layer.id));
    expect(Object.fromEntries(FILESYSTEM_LAYER_DEFINITIONS.map((layer) => [layer.id, layer.packages])))
      .toEqual({
        complete: [],
        base: [],
        bird: ['bird'],
        frr: ['bash', 'frr'],
        toolbox: ['libpcap', 'tcpdump', 'traceroute'],
      });
    expect(validateFilesystemMetadata(result.filesystem)).toEqual(result.filesystem);
    const contents = Object.fromEntries(await Promise.all(result.filesystem.layers.map(async (layer) => (
      [layer.id, await layerContents(root, 'first', layer)]
    ))));
    expect(contents.complete.paths).toEqual(expect.arrayContaining([
      'sbin/init',
      'usr/sbin/bird',
      'usr/sbin/bgpd',
      'usr/bin/tcpdump',
    ]));
    expect(contents.base.paths).toEqual(expect.arrayContaining(['lib/libc.so', 'sbin/init']));
    expect(contents.base.paths).toEqual(expect.arrayContaining([
      'bin/busybox',
      'bin/sh',
      'etc/init.d/S20anycastlab',
      'usr/sbin/anycast-labd',
    ]));
    expect(contents.base.paths).not.toContain('bin/bash');
    expect(contents.base.paths).not.toContain('usr/sbin/bird');
    expect(contents.bird.paths).toEqual(expect.arrayContaining([
      'etc/bird.conf',
      'usr/sbin/bird',
      'usr/sbin/birdc',
      'usr/sbin/birdcl',
    ]));
    expect(contents.frr.paths).toEqual(expect.arrayContaining([
      'bin/bash',
      'etc/frr/frr.conf',
      'usr/bin/vtysh',
      'usr/lib/frr/modules/dplane.so',
      'usr/lib/libfrr.so',
      'usr/lib/libmgmt_be_nb.so',
      'usr/libexec/anycastlab-frr',
      'usr/sbin/bgpd',
      'usr/sbin/ospfd',
      'usr/sbin/staticd',
      'usr/sbin/zebra',
      'usr/share/yang/frr-bgp.yang',
      'usr/share/yang/ietf-interfaces.yang',
    ]));
    expect(contents.toolbox.paths).toEqual(expect.arrayContaining([
      'bin/ping',
      'usr/bin/tcpdump',
      'usr/bin/traceroute',
      'usr/lib/libpcap.so',
    ]));

    // Apart from directory scaffolding, optional units are disjoint. A path
    // must never be silently copied into two independently mounted layers.
    const specializedPaths = ['base', 'bird', 'frr', 'toolbox'].flatMap((id) => (
      contents[id].paths.map((path) => [path, id])
    ));
    const owners = new Map();
    for (const [path, id] of specializedPaths) {
      expect(owners.get(path), `duplicate non-directory path ${path}`).toBeUndefined();
      owners.set(path, id);
    }

    // `complete` is a transitional boot root, not merely another overlay: it
    // has byte-for-byte path coverage of the finalized Buildroot target.
    const expectedComplete = await snapshotTree(fixture.target);
    expect(contents.complete.entries).toEqual(expectedComplete);
    for (const { options } of Object.values(contents)) {
      expect(options).toEqual(expect.arrayContaining([
        '-noappend',
        '-comp', 'zstd',
        '-b', String(FILESYSTEM_LAYOUT.blockSize),
        '-processors', '1',
        '-reproducible',
        '-mkfs-time', '1781643617',
        '-all-time', '1781643617',
      ]));
    }
  });

  it('reuses unchanged layer digests and invalidates the aggregate cache key on a local change', async () => {
    const root = await temporaryDirectory();
    const fixture = await createFixture(root);
    const mksquashfs = await createFakeMksquashfs(root);
    const first = (await build(root, fixture, mksquashfs, 'first')).filesystem;
    const second = (await build(root, fixture, mksquashfs, 'second')).filesystem;
    expect(second).toEqual(first);

    await createFile(fixture.target, 'usr/sbin/bird', 'changed BIRD bytes');
    const changed = (await build(root, fixture, mksquashfs, 'changed')).filesystem;
    const digests = (filesystem) => Object.fromEntries(
      filesystem.layers.map((layer) => [layer.id, layer.sha256]),
    );
    expect(digests(changed)).toMatchObject({
      base: digests(first).base,
      frr: digests(first).frr,
      toolbox: digests(first).toolbox,
    });
    expect(digests(changed).bird).not.toBe(digests(first).bird);
    expect(digests(changed).complete).not.toBe(digests(first).complete);
    expect(changed.cache.key).not.toBe(first.cache.key);
  });

  it('fails closed on missing package provenance and malformed cache or mount metadata', async () => {
    const root = await temporaryDirectory();
    const fixture = await createFixture(root);
    const mksquashfs = await createFakeMksquashfs(root);
    await rm(resolve(fixture.build, 'frr-fixture', '.stamp_target_installed'));
    await expect(build(root, fixture, mksquashfs, 'missing'))
      .rejects.toThrow('one installed Buildroot file manifest for frr');

    await writeFile(resolve(fixture.build, 'frr-fixture', '.stamp_target_installed'), '');
    const filesystem = (await build(root, fixture, mksquashfs, 'valid')).filesystem;
    const wrongCache = structuredClone(filesystem);
    wrongCache.cache.key = `sha256:${'0'.repeat(64)}`;
    expect(() => validateFilesystemMetadata(wrongCache)).toThrow('filesystem.cache.key');
    const wrongMount = structuredClone(filesystem);
    wrongMount.layers[2].mount.order = 99;
    expect(() => validateFilesystemMetadata(wrongMount)).toThrow('mount graph');
  });

  it('rejects a path claimed by two independently mounted package units', async () => {
    const root = await temporaryDirectory();
    const fixture = await createFixture(root);
    const mksquashfs = await createFakeMksquashfs(root);
    await appendFile(
      resolve(fixture.build, 'bird-fixture', '.files-list.txt'),
      'bird,./usr/sbin/bgpd\n',
    );

    await expect(build(root, fixture, mksquashfs, 'overlap'))
      .rejects.toThrow('assign usr/sbin/bgpd to both bird and frr');
  });

  it('rejects privileged metadata in either the finalized target or an emitted SquashFS', async () => {
    const root = await temporaryDirectory();
    const fixture = await createFixture(root);
    const unsquashfs = await createFakeUnsquashfs(root);
    const mksquashfs = await createFakeMksquashfs(root);
    await chmod(resolve(fixture.target, 'bin/busybox'), 0o4755);
    await expect(build(root, fixture, mksquashfs, 'source-setuid', unsquashfs))
      .rejects.toThrow('Target root contains setuid or setgid');

    await chmod(resolve(fixture.target, 'bin/busybox'), 0o755);
    const maliciousMksquashfs = await createFakeMksquashfs(root, {
      injectPrivilegedEntry: true,
    });
    await expect(build(root, fixture, maliciousMksquashfs, 'image-setuid', unsquashfs))
      .rejects.toThrow('Filesystem layer complete contains setuid or setgid');
  });

  it('rejects an ELF dependency that is present only in an inaccessible optional layer', async () => {
    const root = await temporaryDirectory();
    const fixture = await createFixture(root);
    const mksquashfs = await createFakeMksquashfs(root);
    const readelf = await createFakeReadelf(root);
    await writeFile(
      resolve(fixture.target, 'usr/sbin/bird'),
      Buffer.concat([
        Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
        Buffer.from('needed=libfrr.so\n'),
      ]),
    );

    await expect(build(root, fixture, mksquashfs, 'inaccessible-library', undefined, readelf))
      .rejects.toThrow('usr/sbin/bird requires shared library libfrr.so from inaccessible layer frr');
  });

  it('rejects an ELF whose requested interpreter is absent from its mount closure', async () => {
    const root = await temporaryDirectory();
    const fixture = await createFixture(root);
    const mksquashfs = await createFakeMksquashfs(root);
    const readelf = await createFakeReadelf(root);
    await writeFile(
      resolve(fixture.target, 'usr/sbin/bird'),
      Buffer.concat([
        Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
        Buffer.from('interpreter=/lib/ld-missing.so\n'),
      ]),
    );

    await expect(build(root, fixture, mksquashfs, 'missing-interpreter', undefined, readelf))
      .rejects.toThrow('usr/sbin/bird requires missing ELF interpreter lib/ld-missing.so');
  });
});
