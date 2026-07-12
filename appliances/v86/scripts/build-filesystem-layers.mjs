#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmod,
  chown,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, posix, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import {
  createFilesystemMetadata,
  FILESYSTEM_LAYER_DEFINITIONS,
  FILESYSTEM_LAYOUT,
} from './filesystem-layout.mjs';

const execute = promisify(execFile);
const TARGETED_PACKAGES = new Map(FILESYSTEM_LAYER_DEFINITIONS.flatMap((layer) => (
  layer.packages.map((packageName) => [packageName, layer.id])
)));

const EXPLICIT_LAYER_PATHS = new Map([
  ['etc/bird.conf', 'bird'],
  ['usr/sbin/bird', 'bird'],
  ['usr/sbin/birdc', 'bird'],
  ['usr/sbin/birdcl', 'bird'],
  ['etc/frr', 'frr'],
  ['bin/bash', 'frr'],
  ['usr/bin/vtysh', 'frr'],
  ['usr/libexec/anycastlab-frr', 'frr'],
  ['var/run/frr', 'frr'],
  ['bin/ping', 'toolbox'],
  ['bin/ping6', 'toolbox'],
  ['usr/bin/tcpdump', 'toolbox'],
  ['usr/bin/traceroute', 'toolbox'],
]);

const EXPLICIT_LAYER_PREFIXES = Object.freeze([
  ['etc/bird/', 'bird'],
  ['etc/frr/', 'frr'],
  ['usr/lib/frr/', 'frr'],
  ['usr/share/yang/', 'frr'],
]);

const REQUIRED_PATHS = Object.freeze({
  complete: Object.freeze([
    ['bin/busybox'],
    ['bin/sh'],
    ['sbin/init', 'init'],
    ['etc/init.d/S20anycastlab'],
    ['etc/bird.conf'],
    ['etc/frr/frr.conf'],
    ['usr/bin/tcpdump'],
    ['usr/bin/vtysh'],
    ['usr/sbin/bird'],
    ['usr/sbin/bgpd'],
    ['usr/sbin/zebra'],
  ]),
  base: Object.freeze([
    ['bin/busybox'],
    ['bin/sh'],
    ['sbin/init', 'init'],
    ['etc/init.d/S20anycastlab'],
    ['usr/sbin/anycast-labd'],
  ]),
  bird: Object.freeze([
    ['etc/bird.conf'],
    ['usr/sbin/bird'],
    ['usr/sbin/birdc'],
    ['usr/sbin/birdcl'],
  ]),
  frr: Object.freeze([
    ['bin/bash'],
    ['etc/frr/frr.conf'],
    ['usr/bin/vtysh'],
    ['usr/lib/libfrr.so', 'usr/lib/libfrr.so.0'],
    ['usr/lib/libmgmt_be_nb.so', 'usr/lib/libmgmt_be_nb.so.0'],
    ['usr/libexec/anycastlab-frr'],
    ['usr/sbin/bgpd'],
    ['usr/sbin/ospfd'],
    ['usr/sbin/zebra'],
  ]),
  toolbox: Object.freeze([
    ['bin/ping'],
    ['usr/bin/tcpdump'],
    ['usr/bin/traceroute'],
  ]),
});

function parseArguments(arguments_) {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const name = arguments_[index];
    if (!name.startsWith('--')) throw new Error(`Unexpected argument: ${name}`);
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value`);
    index += 1;
    switch (name) {
      case '--target': options.targetDirectory = value; break;
      case '--output': options.outputDirectory = value; break;
      case '--work': options.workDirectory = value; break;
      case '--buildroot-build': options.buildrootBuildDirectory = value; break;
      case '--mksquashfs': options.mksquashfs = value; break;
      case '--unsquashfs': options.unsquashfs = value; break;
      case '--readelf': options.readelf = value; break;
      case '--tar': options.tar = value; break;
      case '--source-date-epoch': options.sourceDateEpoch = Number(value); break;
      default: throw new Error(`Unknown argument: ${name}`);
    }
  }
  for (const [name, value] of Object.entries({
    '--target': options.targetDirectory,
    '--output': options.outputDirectory,
    '--work': options.workDirectory,
    '--buildroot-build': options.buildrootBuildDirectory,
    '--mksquashfs': options.mksquashfs,
    '--unsquashfs': options.unsquashfs,
    '--readelf': options.readelf,
    '--source-date-epoch': options.sourceDateEpoch,
  })) {
    if (value === undefined) throw new Error(`${name} is required`);
  }
  return options;
}

function isWithin(parent, candidate) {
  const path = relative(parent, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

function normalizeTargetPath(value, label) {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  let path = value;
  while (path.startsWith('./')) path = path.slice(2);
  if (
    path === '' ||
    path.includes('\0') ||
    path.includes('\n') ||
    path.includes('\r') ||
    isAbsolute(path) ||
    path === '..' ||
    path.startsWith('../') ||
    path.includes('/../')
  ) {
    throw new Error(`${label} is not a safe target-relative path: ${value}`);
  }
  return path.replaceAll('\\', '/');
}

function explicitLayer(path) {
  const exact = EXPLICIT_LAYER_PATHS.get(path);
  if (exact !== undefined) return exact;
  for (const [prefix, layer] of EXPLICIT_LAYER_PREFIXES) {
    if (path.startsWith(prefix)) return layer;
  }
  if (/^usr\/lib\/(?:libfrr|libmgmt_)/.test(path)) return 'frr';
  return undefined;
}

async function installedPackageManifests(buildrootBuildDirectory) {
  const root = resolve(buildrootBuildDirectory);
  const candidates = new Map([...TARGETED_PACKAGES.keys()].map((name) => [name, []]));
  const buildDirectories = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('host-'))
    .sort((left, right) => left.name.localeCompare(right.name, 'en'));
  for (const entry of buildDirectories) {
    const manifestPath = resolve(root, entry.name, '.files-list.txt');
    const installedStamp = resolve(root, entry.name, '.stamp_target_installed');
    try {
      await stat(installedStamp);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    let contents;
    try {
      contents = await readFile(manifestPath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    const packageNames = new Set(contents.split('\n').flatMap((line) => {
      const comma = line.indexOf(',');
      return comma <= 0 ? [] : [line.slice(0, comma)];
    }));
    for (const packageName of packageNames) {
      if (candidates.has(packageName)) candidates.get(packageName).push({ manifestPath, contents });
    }
  }
  for (const [packageName, manifests] of candidates) {
    if (manifests.length !== 1) {
      throw new Error(
        `Expected one installed Buildroot file manifest for ${packageName}; found ${manifests.length}`,
      );
    }
  }
  return candidates;
}

async function packagePathAssignments(buildrootBuildDirectory) {
  const manifests = await installedPackageManifests(buildrootBuildDirectory);
  const assignments = new Map();
  for (const [packageName, [{ manifestPath, contents }]] of manifests) {
    const layer = TARGETED_PACKAGES.get(packageName);
    for (const [lineIndex, line] of contents.split('\n').entries()) {
      if (line === '') continue;
      const comma = line.indexOf(',');
      if (comma <= 0 || line.slice(0, comma) !== packageName) continue;
      const path = normalizeTargetPath(
        line.slice(comma + 1),
        `${manifestPath}:${lineIndex + 1}`,
      );
      const previous = assignments.get(path);
      if (previous !== undefined && previous !== layer) {
        throw new Error(`Buildroot package manifests assign ${path} to both ${previous} and ${layer}`);
      }
      assignments.set(path, layer);
    }
  }
  return assignments;
}

async function targetEntries(targetDirectory) {
  const entries = [];
  async function visit(directory, parent = '') {
    const children = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const child of children) {
      const path = normalizeTargetPath(parent === '' ? child.name : `${parent}/${child.name}`, 'target path');
      const absolutePath = resolve(targetDirectory, path);
      const metadata = await lstat(absolutePath);
      if (metadata.isSocket()) throw new Error(`Target root contains a live socket: ${path}`);
      if (!metadata.isSymbolicLink() && (metadata.mode & 0o6000) !== 0) {
        throw new Error(`Target root contains setuid or setgid mode bits: ${path}`);
      }
      entries.push({
        path,
        directory: metadata.isDirectory(),
        kind: metadata.isDirectory()
          ? 'directory'
          : metadata.isSymbolicLink()
            ? 'symlink'
            : metadata.isFile()
              ? 'file'
              : 'special',
        mode: metadata.mode & 0o7777,
      });
      if (metadata.isDirectory()) await visit(absolutePath, path);
    }
  }
  await visit(targetDirectory);
  return entries;
}

function parentPaths(path) {
  const parents = [];
  let parent = dirname(path).replaceAll('\\', '/');
  while (parent !== '.' && parent !== '') {
    parents.push(parent);
    parent = dirname(parent).replaceAll('\\', '/');
  }
  return parents;
}

function classifyEntries(entries, packageAssignments) {
  const entryByPath = new Map(entries.map((entry) => [entry.path, entry]));
  const layerEntries = new Map(FILESYSTEM_LAYER_DEFINITIONS.map((layer) => [layer.id, new Set()]));
  for (const entry of entries) {
    if (entry.directory) continue;
    const packageLayer = packageAssignments.get(entry.path);
    const pathLayer = explicitLayer(entry.path);
    if (packageLayer !== undefined && pathLayer !== undefined && packageLayer !== pathLayer) {
      throw new Error(`${entry.path} is assigned to both ${packageLayer} and ${pathLayer}`);
    }
    const layer = packageLayer ?? pathLayer ?? 'base';
    layerEntries.get(layer).add(entry.path);
    for (const parent of parentPaths(entry.path)) layerEntries.get(layer).add(parent);
  }
  for (const entry of entries) {
    if (!entry.directory) continue;
    const packageLayer = packageAssignments.get(entry.path);
    const pathLayer = explicitLayer(entry.path);
    if (packageLayer !== undefined && pathLayer !== undefined && packageLayer !== pathLayer) {
      throw new Error(`${entry.path} is assigned to both ${packageLayer} and ${pathLayer}`);
    }
    const assigned = packageLayer ?? pathLayer;
    if (assigned !== undefined) {
      layerEntries.get(assigned).add(entry.path);
      for (const parent of parentPaths(entry.path)) layerEntries.get(assigned).add(parent);
    }
    const used = [...layerEntries.entries()]
      .some(([layer, paths]) => layer !== 'complete' && paths.has(entry.path));
    if (!used) {
      layerEntries.get('base').add(entry.path);
      for (const parent of parentPaths(entry.path)) layerEntries.get('base').add(parent);
    }
  }
  for (const [layer, paths] of layerEntries) {
    for (const path of paths) {
      if (!entryByPath.has(path)) {
        throw new Error(`Layer ${layer} needs parent path ${path}, but it is absent from the target root`);
      }
    }
  }
  layerEntries.set('complete', new Set(entries.map((entry) => entry.path)));
  return layerEntries;
}

function assertRequiredContents(layerEntries) {
  for (const [layer, alternatives] of Object.entries(REQUIRED_PATHS)) {
    const entries = layerEntries.get(layer);
    for (const paths of alternatives) {
      if (!paths.some((path) => entries.has(path))) {
        throw new Error(`Filesystem layer ${layer} is missing required content: ${paths.join(' or ')}`);
      }
    }
  }
  const frrEntries = layerEntries.get('frr');
  if (![...frrEntries].some((path) => path.startsWith('usr/share/yang/') && path.endsWith('.yang'))) {
    throw new Error('Filesystem layer frr must contain the complete FRR/YANG model set');
  }
}

function runtimePath(value, containingPath) {
  const normalized = value.startsWith('/')
    ? posix.normalize(value).slice(1)
    : posix.normalize(posix.join(posix.dirname(containingPath), value));
  if (normalized === '' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Runtime dependency escapes the appliance root: ${containingPath} -> ${value}`);
  }
  return normalized;
}

function accessibleLayers(layerId) {
  const definitions = new Map(FILESYSTEM_LAYER_DEFINITIONS.map((definition) => (
    [definition.id, definition]
  )));
  const result = new Set();
  const visit = (id) => {
    if (result.has(id)) return;
    const definition = definitions.get(id);
    if (definition === undefined) throw new Error(`Unknown filesystem dependency layer: ${id}`);
    result.add(id);
    for (const dependency of definition.dependsOn) visit(dependency);
  };
  visit(layerId);
  return result;
}

async function filePrefix(path, length = 512) {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function assertRuntimeClosure({
  entries,
  layerEntries,
  targetDirectory,
  readelf,
}) {
  const entryByPath = new Map(entries.map((entry) => [entry.path, entry]));
  const ownerByPath = new Map();
  for (const definition of FILESYSTEM_LAYER_DEFINITIONS) {
    if (definition.id === 'complete') continue;
    for (const path of layerEntries.get(definition.id)) {
      const entry = entryByPath.get(path);
      if (entry?.directory !== false) continue;
      const previous = ownerByPath.get(path);
      if (previous !== undefined) {
        throw new Error(`Non-directory path ${path} is duplicated by ${previous} and ${definition.id}`);
      }
      ownerByPath.set(path, definition.id);
    }
  }
  const librariesByName = new Map();
  for (const [path, layer] of ownerByPath) {
    const name = basename(path);
    const candidates = librariesByName.get(name) ?? [];
    candidates.push({ path, layer });
    librariesByName.set(name, candidates);
  }

  const assertPath = (requester, layer, dependency, label, allowDirectory = false) => {
    const dependencyEntry = entryByPath.get(dependency);
    if (dependencyEntry === undefined || (dependencyEntry.directory && !allowDirectory)) {
      throw new Error(`${requester} requires missing ${label} ${dependency}`);
    }
    const available = accessibleLayers(layer);
    if (dependencyEntry.directory) {
      if (![...available].some((id) => layerEntries.get(id).has(dependency))) {
        throw new Error(`${requester} requires ${label} ${dependency} from an inaccessible layer`);
      }
      return;
    }
    const owner = ownerByPath.get(dependency);
    if (owner === undefined || !available.has(owner)) {
      throw new Error(`${requester} requires ${label} ${dependency} from inaccessible layer ${owner ?? '<none>'}`);
    }
  };
  const assertLibrary = (requester, layer, library) => {
    const candidates = librariesByName.get(library) ?? [];
    const available = accessibleLayers(layer);
    if (!candidates.some((candidate) => available.has(candidate.layer))) {
      const owners = [...new Set(candidates.map((candidate) => candidate.layer))];
      throw new Error(
        `${requester} requires shared library ${library} from inaccessible layer ${owners.join(',') || '<missing>'}`,
      );
    }
  };

  for (const [path, layer] of ownerByPath) {
    const entry = entryByPath.get(path);
    const absolutePath = resolve(targetDirectory, path);
    if (entry.kind === 'symlink') {
      const target = runtimePath(await readlink(absolutePath), path);
      if (entryByPath.has(target)) assertPath(path, layer, target, 'symlink target', true);
      continue;
    }
    if (entry.kind !== 'file') continue;
    const prefix = await filePrefix(absolutePath);
    if (prefix.subarray(0, 2).toString() === '#!') {
      const firstLine = prefix.toString('utf8').split(/\r?\n/, 1)[0];
      const match = /^#!\s*(\/[^\s]+)/.exec(firstLine);
      if (match === null) throw new Error(`${path} has an invalid absolute shebang`);
      assertPath(path, layer, runtimePath(match[1], path), 'interpreter');
    }
    if (!prefix.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) continue;
    if (typeof readelf !== 'string' || readelf === '') {
      throw new Error(`readelf is required to verify ELF dependency closure: ${path}`);
    }
    const result = await execute(readelf, [
      '--dynamic',
      '--program-headers',
      '--wide',
      absolutePath,
    ], { maxBuffer: 16 * 1024 * 1024 });
    const interpreter = /Requesting program interpreter:\s*([^\]]+)\]/.exec(result.stdout)?.[1];
    if (interpreter !== undefined) {
      assertPath(path, layer, runtimePath(interpreter, path), 'ELF interpreter');
    }
    for (const match of result.stdout.matchAll(/\(NEEDED\).*Shared library: \[([^\]]+)\]/g)) {
      assertLibrary(path, layer, match[1]);
    }
  }
}

function nulList(paths) {
  return Buffer.from(`${paths.join('\0')}\0`);
}

async function sha256File(path) {
  const hash = createHash('sha256');
  await new Promise((resolvePromise, reject) => {
    const input = createReadStream(path);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('error', reject);
    input.on('end', resolvePromise);
  });
  return hash.digest('hex');
}

async function copyLayerTree({ definition, paths, targetDirectory, workDirectory, tar }) {
  const layerWork = resolve(workDirectory, definition.id);
  const stage = resolve(layerWork, 'root');
  const archive = resolve(layerWork, 'root.tar');
  const list = resolve(layerWork, 'entries.list');
  await rm(layerWork, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  const targetRootMetadata = await lstat(targetDirectory);
  await chmod(stage, targetRootMetadata.mode & 0o7777);
  if (typeof process.getuid !== 'function' || process.getuid() === 0) {
    await chown(stage, targetRootMetadata.uid, targetRootMetadata.gid);
  }
  await writeFile(list, nulList(paths));
  const commonOptions = ['--numeric-owner', '--acls', '--xattrs', '--xattrs-include=*'];
  await execute(tar, [
    '--create',
    '--file', archive,
    '--directory', targetDirectory,
    '--format=gnu',
    '--no-recursion',
    '--null',
    '--files-from', list,
    ...commonOptions,
  ], { maxBuffer: 16 * 1024 * 1024 });
  await execute(tar, [
    '--extract',
    '--file', archive,
    '--directory', stage,
    '--same-owner',
    '--same-permissions',
    ...commonOptions,
  ], { maxBuffer: 16 * 1024 * 1024 });
  return stage;
}

function assertSquashfsModeListing(stdout, definition) {
  const entries = stdout.split('\n').filter((line) => (
    /^[bcdlps-][rwxStTs-]{9}\s/.test(line)
  ));
  if (entries.length === 0) {
    throw new Error(`unsquashfs returned no metadata entries for the ${definition.id} layer`);
  }
  const privileged = entries.find((line) => (
    /^.{3}[sS]/.test(line) || /^.{6}[sS]/.test(line)
  ));
  if (privileged !== undefined) {
    throw new Error(`Filesystem layer ${definition.id} contains setuid or setgid mode bits`);
  }
}

async function makeSquashfs({
  definition,
  stage,
  outputDirectory,
  mksquashfs,
  unsquashfs,
  sourceDateEpoch,
}) {
  const outputPath = resolve(outputDirectory, definition.file);
  const temporaryPath = `${outputPath}.tmp`;
  const squashfsEnvironment = {
    ...process.env,
    LC_ALL: 'C',
    TZ: 'UTC',
  };
  // mksquashfs 4.6 rejects SOURCE_DATE_EPOCH when an explicit timestamp
  // option is also present.  Keep the stronger -mkfs-time/-all-time contract
  // below, but do not leak Buildroot's globally exported value to this child.
  delete squashfsEnvironment.SOURCE_DATE_EPOCH;
  await rm(temporaryPath, { force: true });
  await execute(mksquashfs, [
    stage,
    temporaryPath,
    '-noappend',
    '-comp', FILESYSTEM_LAYOUT.compression,
    '-b', String(FILESYSTEM_LAYOUT.blockSize),
    '-Xcompression-level', '19',
    '-processors', '1',
    '-reproducible',
    '-mkfs-time', String(sourceDateEpoch),
    '-all-time', String(sourceDateEpoch),
    '-no-progress',
  ], {
    env: squashfsEnvironment,
    maxBuffer: 16 * 1024 * 1024,
  });
  const metadata = await stat(temporaryPath);
  if (!metadata.isFile() || metadata.size <= 0) {
    throw new Error(`mksquashfs did not create a non-empty ${definition.id} layer`);
  }
  const listing = await execute(unsquashfs, ['-lln', temporaryPath], {
    env: {
      ...process.env,
      LC_ALL: 'C',
      TZ: 'UTC',
    },
    maxBuffer: 16 * 1024 * 1024,
  });
  assertSquashfsModeListing(listing.stdout, definition);
  const sha256 = await sha256File(temporaryPath);
  await rename(temporaryPath, outputPath);
  return { id: definition.id, size: metadata.size, sha256 };
}

export async function buildFilesystemLayers({
  targetDirectory,
  outputDirectory,
  workDirectory,
  buildrootBuildDirectory,
  mksquashfs,
  unsquashfs,
  readelf,
  tar = 'tar',
  sourceDateEpoch,
}) {
  if (!Number.isSafeInteger(sourceDateEpoch) || sourceDateEpoch <= 0) {
    throw new Error('sourceDateEpoch must be a positive integer');
  }
  const target = resolve(targetDirectory);
  const output = resolve(outputDirectory);
  const work = resolve(workDirectory);
  const buildrootBuild = resolve(buildrootBuildDirectory);
  if (isWithin(target, output) || isWithin(target, work) || isWithin(target, buildrootBuild)) {
    throw new Error('Layer output, work and Buildroot metadata directories must be outside the target root');
  }
  await mkdir(output, { recursive: true });
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });

  const [entries, packageAssignments] = await Promise.all([
    targetEntries(target),
    packagePathAssignments(buildrootBuild),
  ]);
  const layerEntries = classifyEntries(entries, packageAssignments);
  assertRequiredContents(layerEntries);
  await assertRuntimeClosure({
    entries,
    layerEntries,
    targetDirectory: target,
    readelf,
  });

  const artifacts = [];
  for (const definition of FILESYSTEM_LAYER_DEFINITIONS) {
    const paths = [...layerEntries.get(definition.id)].sort((left, right) => left.localeCompare(right, 'en'));
    const stage = await copyLayerTree({
      definition,
      paths,
      targetDirectory: target,
      workDirectory: work,
      tar,
    });
    artifacts.push(await makeSquashfs({
      definition,
      stage,
      outputDirectory: output,
      mksquashfs,
      unsquashfs,
      sourceDateEpoch,
    }));
  }
  const filesystem = createFilesystemMetadata(artifacts);
  const metadataPath = resolve(output, 'filesystem.json');
  const temporaryMetadataPath = `${metadataPath}.tmp`;
  await writeFile(temporaryMetadataPath, `${JSON.stringify(filesystem, null, 2)}\n`);
  await rename(temporaryMetadataPath, metadataPath);
  await rm(work, { recursive: true, force: true });
  return { filesystem, metadataPath };
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  const result = await buildFilesystemLayers(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${result.filesystem.cache.key}  filesystem.json\n`);
}
