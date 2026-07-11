import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { createReleaseStatus, validateReleaseStatus } from './release-status.mjs';
import { PINNED_V86_MANIFEST_IDENTITY } from './verify-manifest.mjs';

let directory;
let manifestPath;
let digestPath;
let digest;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'anycast-release-status-'));
  manifestPath = join(directory, 'manifest.json');
  digestPath = join(directory, 'manifest.sha256');
  const definitions = [
    ['v86-wasm', 'v86.wasm'],
    ['bios', 'seabios.bin'],
    ['vga-bios', 'vgabios.bin'],
    ['bzimage', 'router-bzimage.bin'],
  ];
  const artifacts = [];
  for (const [id, file] of definitions) {
    const bytes = Buffer.from(`release-status:${id}`);
    await writeFile(join(directory, file), bytes);
    artifacts.push({ id, file, size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const manifestBytes = Buffer.from(`${JSON.stringify({
    ...PINNED_V86_MANIFEST_IDENTITY,
    pgo: {
      mode: 'use',
      contextSha256: '1'.repeat(64),
      profileSetBuildKey: '2'.repeat(64),
      birdProfileSha256: '3'.repeat(64),
      frrProfileSha256: '4'.repeat(64),
    },
    machine: {
      memoryBytes: 134_217_728,
      vgaMemoryBytes: 2_097_152,
      trunkMtu: 65_535,
    },
    artifacts,
  }, null, 2)}\n`);
  digest = createHash('sha256').update(manifestBytes).digest('hex');
  await writeFile(manifestPath, manifestBytes);
  await writeFile(digestPath, `${digest}  manifest.json\n`);
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

function options(overrides = {}) {
  return {
    manifestPath,
    manifestSha256Path: digestPath,
    manifestUrl: `https://assets.example/releases/${digest}/manifest.json`,
    channel: 'stable',
    generation: 7,
    sourceRevision: 'a'.repeat(40),
    publishedAt: '2026-07-11T00:00:00.000Z',
    ...overrides,
  };
}

it('creates and validates an external release status from immutable inputs', async () => {
  const status = await createReleaseStatus(options());
  expect(status).toEqual({
    schemaVersion: 1,
    nativeV86: true,
    channel: 'stable',
    generation: 7,
    manifestUrl: `https://assets.example/releases/${digest}/manifest.json`,
    manifestSha256: digest,
    buildId: 'anycastlab-v86-br2026.02.3-r3',
    memoryBytes: 134_217_728,
    publishedAt: '2026-07-11T00:00:00.000Z',
    sourceRevision: 'a'.repeat(40),
  });
  await expect(validateReleaseStatus(status, options())).resolves.toBe(status);
});

it('rejects a recorded digest that does not cover the manifest bytes', async () => {
  const badDigestPath = join(directory, 'bad.sha256');
  await writeFile(badDigestPath, `${'0'.repeat(64)}  manifest.json\n`);
  await expect(
    createReleaseStatus(options({ manifestSha256Path: badDigestPath })),
  ).rejects.toThrow(/Manifest digest mismatch/);
});

it('rejects mutable or credential-bearing manifest URLs', async () => {
  await expect(
    createReleaseStatus(options({ manifestUrl: 'https://assets.example/releases/latest/manifest.json' })),
  ).rejects.toThrow(/namespaced by the manifest SHA-256/);
  await expect(
    createReleaseStatus(options({ manifestUrl: `https://user:secret@assets.example/${digest}/manifest.json` })),
  ).rejects.toThrow(/without credentials/);
});

it('rejects channel traversal and a mismatched release status', async () => {
  await expect(createReleaseStatus(options({ channel: '../stable' }))).rejects.toThrow(/channel must contain/);
  const status = await createReleaseStatus(options());
  await expect(
    validateReleaseStatus({ ...status, buildId: 'different' }, options()),
  ).rejects.toThrow(/buildId does not match/);
  await expect(
    validateReleaseStatus({ ...status, releaseStatusUrl: 'https://assets.example/recursive.json' }, options()),
  ).rejects.toThrow(/unexpected or missing fields/);
});

it('rejects noncanonical timestamps and source revisions', async () => {
  await expect(
    createReleaseStatus(options({ publishedAt: '2026-07-11T00:00:00Z' })),
  ).rejects.toThrow(/canonical UTC timestamp/);
  await expect(
    createReleaseStatus(options({ sourceRevision: 'main' })),
  ).rejects.toThrow(/40-character Git commit SHA/);
  await expect(
    createReleaseStatus(options({ generation: -1 })),
  ).rejects.toThrow(/non-negative safe integer/);
});

it('the fixture digest file is exact and has no hidden test mutation', async () => {
  expect(await readFile(digestPath, 'utf8')).toBe(`${digest}  manifest.json\n`);
});
