#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, readlink } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CACHE_KEY_SCHEMA = 'anycast-lab-native-v86-bundle-v1';
const DAEMON_CACHE_KEY_SCHEMA = 'anycast-lab-native-daemons-v1';

export const APPLIANCE_CACHE_INPUTS = Object.freeze([
  'artifact-manifest.template.json',
  'buildroot',
  'scripts/appliance-cache-key.mjs',
  'scripts/build-filesystem-layers.mjs',
  'scripts/build-filesystem-layers.sh',
  'scripts/build-image.sh',
  'scripts/filesystem-layout.mjs',
  'scripts/pgo-profile-set.mjs',
  'scripts/verify-manifest.mjs',
  'scripts/verify-optimized-daemons.sh',
  'scripts/verify-effective-config.mjs',
  'scripts/verify-rootfs-policy.sh',
  'versions.env',
]);

// Keep the expensive BIRD/FRR cache independent from browser, supervisor,
// kernel, rootfs, and packaging-only changes. These are the checked-in inputs
// that can alter the daemon binaries or the Clang runtime used to link them.
export const DAEMON_CACHE_INPUTS = Object.freeze([
  'buildroot/configs/anycast_lab_v86_defconfig',
  'buildroot/external.mk',
  'buildroot/package/anycast-clang-toolchain',
  'buildroot/patches/bird',
  'buildroot/patches/frr',
  'scripts/appliance-cache-key.mjs',
  'scripts/pgo-profile-set.mjs',
  'versions.env',
]);

export async function computeApplianceCacheKey(root) {
  return computeCacheKey(root, APPLIANCE_CACHE_INPUTS, CACHE_KEY_SCHEMA);
}

export async function computeDaemonCacheKey(root) {
  return computeCacheKey(root, DAEMON_CACHE_INPUTS, DAEMON_CACHE_KEY_SCHEMA);
}

async function computeCacheKey(root, inputs, schema) {
  const absoluteRoot = resolve(root);
  const entries = [];
  for (const input of inputs) {
    await collectEntries(absoluteRoot, resolve(absoluteRoot, input), entries);
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));

  const hash = createHash('sha256');
  hash.update(`${schema}\0`);
  for (const entry of entries) {
    hash.update(`${entry.type}\0${entry.path}\0${entry.mode.toString(8)}\0${entry.bytes.byteLength}\0`);
    hash.update(entry.bytes);
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function collectEntries(root, path, entries) {
  const metadata = await lstat(path);
  if (metadata.isDirectory()) {
    const children = await readdir(path);
    children.sort((left, right) => left.localeCompare(right));
    for (const child of children) await collectEntries(root, resolve(path, child), entries);
    return;
  }

  const normalizedPath = relative(root, path).split(sep).join('/');
  if (normalizedPath === '' || normalizedPath.startsWith('../')) {
    throw new Error(`Appliance cache input escapes its root: ${path}`);
  }
  const mode = metadata.mode & 0o777;
  if (metadata.isFile()) {
    entries.push({ type: 'file', path: normalizedPath, mode, bytes: await readFile(path) });
    return;
  }
  if (metadata.isSymbolicLink()) {
    entries.push({
      type: 'symlink',
      path: normalizedPath,
      mode,
      bytes: Buffer.from(await readlink(path)),
    });
    return;
  }
  throw new Error(`Unsupported appliance cache input type: ${normalizedPath}`);
}

const scriptPath = process.argv[1];
if (scriptPath !== undefined && import.meta.url === pathToFileURL(scriptPath).href) {
  const applianceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const command = process.argv[2];
  const compute = command === undefined
    ? computeApplianceCacheKey
    : command === '--daemons'
      ? computeDaemonCacheKey
      : null;
  if (compute === null) {
    console.error('Usage: appliance-cache-key.mjs [--daemons]');
    process.exitCode = 2;
  } else compute(applianceRoot).then(
    (digest) => process.stdout.write(`${digest}\n`),
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    },
  );
}
