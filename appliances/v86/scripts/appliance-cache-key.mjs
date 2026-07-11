#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, readlink } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CACHE_KEY_SCHEMA = 'anycast-lab-native-v86-bundle-v1';

export const APPLIANCE_CACHE_INPUTS = Object.freeze([
  'artifact-manifest.template.json',
  'buildroot',
  'scripts/appliance-cache-key.mjs',
  'scripts/build-image.sh',
  'scripts/verify-manifest.mjs',
  'versions.env',
]);

export async function computeApplianceCacheKey(root) {
  const absoluteRoot = resolve(root);
  const entries = [];
  for (const input of APPLIANCE_CACHE_INPUTS) {
    await collectEntries(absoluteRoot, resolve(absoluteRoot, input), entries);
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));

  const hash = createHash('sha256');
  hash.update(`${CACHE_KEY_SCHEMA}\0`);
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
  computeApplianceCacheKey(applianceRoot).then(
    (digest) => process.stdout.write(`${digest}\n`),
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    },
  );
}
