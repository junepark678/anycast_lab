// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_RELEASE_ARTIFACT_BYTES,
  PINNED_V86_MANIFEST_IDENTITY,
  verifyV86ArtifactBundle,
} from './verify-manifest.mjs';

const temporaryDirectories = [];
const definitions = [
  ['v86-wasm', 'v86.wasm'],
  ['bios', 'seabios.bin'],
  ['vga-bios', 'vgabios.bin'],
  ['bzimage', 'router-bzimage.bin'],
];

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function fixture() {
  const directory = await mkdtemp(resolve(tmpdir(), 'anycast-v86-manifest-'));
  temporaryDirectories.push(directory);
  const artifacts = [];
  for (const [id, file] of definitions) {
    const bytes = Buffer.from(`fixture:${id}`);
    await writeFile(resolve(directory, file), bytes);
    artifacts.push({ id, file, size: bytes.byteLength, sha256: digest(bytes) });
  }
  const manifest = {
    ...PINNED_V86_MANIFEST_IDENTITY,
    toolchain: { ...PINNED_V86_MANIFEST_IDENTITY.toolchain },
    pgo: {
      mode: 'use',
      contextSha256: '1'.repeat(64),
      profileSetBuildKey: '2'.repeat(64),
      birdProfileSha256: '3'.repeat(64),
      frrProfileSha256: '4'.repeat(64),
    },
    machine: {
      memoryBytes: 128 * 1024 * 1024,
      vgaMemoryBytes: 2 * 1024 * 1024,
      trunkMtu: 65_535,
    },
    artifacts,
  };
  const manifestPath = resolve(directory, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { directory, manifest, manifestPath };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('verifyV86ArtifactBundle', () => {
  it('verifies the fixed artifact set and manifest digest', async () => {
    const { manifestPath } = await fixture();
    const verified = await verifyV86ArtifactBundle(manifestPath);
    expect(verified.artifacts.map((artifact) => artifact.file)).toEqual(definitions.map(([, file]) => file));
    await expect(verifyV86ArtifactBundle(manifestPath, {
      expectedManifestSha256: verified.manifestSha256,
    })).resolves.toMatchObject({ manifestSha256: verified.manifestSha256 });
  });

  it('rejects traversal, duplicate IDs, and missing fixed artifacts', async () => {
    const { manifest, manifestPath } = await fixture();
    manifest.artifacts[0].file = '../v86.wasm';
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(verifyV86ArtifactBundle(manifestPath)).rejects.toThrow('fixed filename');

    manifest.artifacts[0].file = 'v86.wasm';
    manifest.artifacts[1].id = 'v86-wasm';
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(verifyV86ArtifactBundle(manifestPath)).rejects.toThrow('duplicate');

    manifest.artifacts.pop();
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(verifyV86ArtifactBundle(manifestPath)).rejects.toThrow('exactly 4');
  });

  it('rejects oversized or corrupted artifact bytes', async () => {
    const { directory, manifest, manifestPath } = await fixture();
    manifest.artifacts[0].size = MAX_RELEASE_ARTIFACT_BYTES + 1;
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(verifyV86ArtifactBundle(manifestPath)).rejects.toThrow('release safety limit');

    manifest.artifacts[0].size = Buffer.byteLength('fixture:v86-wasm');
    await writeFile(resolve(directory, 'v86.wasm'), 'corrupt');
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(verifyV86ArtifactBundle(manifestPath)).rejects.toThrow('Artifact verification failed');
  });

  it('rejects a bundle that the browser manifest contract cannot consume', async () => {
    const { manifest, manifestPath } = await fixture();
    delete manifest.v86;
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(verifyV86ArtifactBundle(manifestPath)).rejects.toThrow('v86 must be an object');

    manifest.v86 = PINNED_V86_MANIFEST_IDENTITY.v86;
    manifest.machine.trunkMtu = 1500;
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(verifyV86ArtifactBundle(manifestPath)).rejects.toThrow('between 1504 and 65535');
  });

  it('requires pinned O3 ThinLTO and complete PGO-use provenance', async () => {
    const { manifest, manifestPath } = await fixture();
    manifest.toolchain.optimization = 'O2';
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(verifyV86ArtifactBundle(manifestPath)).rejects.toThrow('toolchain metadata');

    manifest.toolchain = { ...PINNED_V86_MANIFEST_IDENTITY.toolchain };
    manifest.pgo.birdProfileSha256 = null;
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(verifyV86ArtifactBundle(manifestPath)).rejects.toThrow('birdProfileSha256');

    manifest.pgo = {
      mode: 'generate',
      contextSha256: '1'.repeat(64),
      profileSetBuildKey: '2'.repeat(64),
      birdProfileSha256: null,
      frrProfileSha256: null,
    };
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(verifyV86ArtifactBundle(manifestPath)).rejects.toThrow('Only PGO use mode');

    manifest.pgo.profileSetBuildKey = null;
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(verifyV86ArtifactBundle(manifestPath, { requiredPgoMode: 'use' }))
      .rejects.toThrow('requires PGO mode use');
  });
});
