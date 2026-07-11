#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const manifestPath = resolve(process.argv[2] ?? 'dist/manifest.json');
const manifestBytes = await readFile(manifestPath);
const manifest = JSON.parse(manifestBytes.toString('utf8'));
const expectedIds = new Set(['v86-wasm', 'bios', 'vga-bios', 'bzimage']);

if (manifest.schemaVersion !== 1 || manifest.buildId !== 'anycastlab-v86-br2026.02.3-r1') {
  throw new Error('Unexpected appliance manifest identity');
}
for (const artifact of manifest.artifacts ?? []) {
  if (!expectedIds.delete(artifact.id)) throw new Error(`Unexpected or duplicate artifact ${artifact.id}`);
  const bytes = await readFile(resolve(dirname(manifestPath), artifact.file));
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (bytes.byteLength !== artifact.size || digest !== artifact.sha256) {
    throw new Error(`Artifact verification failed: ${artifact.id}`);
  }
}
if (expectedIds.size !== 0) throw new Error(`Missing artifacts: ${[...expectedIds].join(', ')}`);

const manifestDigest = createHash('sha256').update(manifestBytes).digest('hex');
process.stdout.write(`${manifestDigest}  manifest.json\n`);
