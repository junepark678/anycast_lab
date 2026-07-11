import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  PINNED_BIRD_VERSION,
  PINNED_BUILDROOT_VERSION,
  PINNED_FRR_VERSION,
  PINNED_V86_COMMIT,
  PINNED_V86_PACKAGE_VERSION,
  V86_IMAGE_BUILD_ID,
  loadVerifiedV86Artifacts,
  type V86ArtifactId,
} from './manifest';

const digest = async (contents: Uint8Array): Promise<string> =>
  createHash('sha256').update(contents).digest('hex');

describe('v86 artifact verification', () => {
  it('verifies the trusted manifest before all pinned artifacts', async () => {
    const artifacts: Record<V86ArtifactId, Uint8Array> = {
      'v86-wasm': new Uint8Array([0, 97, 115, 109]),
      bios: new Uint8Array([1, 2]),
      'vga-bios': new Uint8Array([3, 4]),
      bzimage: new Uint8Array([5, 6, 7]),
    };
    const manifest = manifestFor(artifacts);
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
    const responses = new Map<string, Uint8Array>([
      ['https://lab.test/v86/manifest.json', manifestBytes],
      ...Object.entries(artifacts).map(
        ([id, bytes]) => [`https://lab.test/v86/${id}.bin`, bytes] as const,
      ),
    ]);
    const fetch = fakeFetch(responses);

    const bundle = await loadVerifiedV86Artifacts(
      {
        manifestUrl: 'https://lab.test/v86/manifest.json',
        manifestSha256: await digest(manifestBytes),
      },
      { fetch, digest },
    );

    expect(bundle.manifest.buildId).toBe(V86_IMAGE_BUILD_ID);
    expect(bundle.artifacts.bzimage).toEqual(artifacts.bzimage);
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it('refuses a modified artifact even when its byte length is unchanged', async () => {
    const artifacts: Record<V86ArtifactId, Uint8Array> = {
      'v86-wasm': new Uint8Array([0]),
      bios: new Uint8Array([1]),
      'vga-bios': new Uint8Array([2]),
      bzimage: new Uint8Array([3]),
    };
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifestFor(artifacts)));
    const responses = new Map<string, Uint8Array>([
      ['https://lab.test/v86/manifest.json', manifestBytes],
      ['https://lab.test/v86/v86-wasm.bin', artifacts['v86-wasm']],
      ['https://lab.test/v86/bios.bin', artifacts.bios],
      ['https://lab.test/v86/vga-bios.bin', artifacts['vga-bios']],
      ['https://lab.test/v86/bzimage.bin', new Uint8Array([4])],
    ]);

    await expect(
      loadVerifiedV86Artifacts(
        {
          manifestUrl: 'https://lab.test/v86/manifest.json',
          manifestSha256: await digest(manifestBytes),
        },
        { fetch: fakeFetch(responses), digest },
      ),
    ).rejects.toThrow(/bzimage digest mismatch/);
  });
});

function manifestFor(artifacts: Record<V86ArtifactId, Uint8Array>) {
  return {
    schemaVersion: 1,
    imageId: 'anycast-lab-router',
    buildId: V86_IMAGE_BUILD_ID,
    sourceDateEpoch: 1_781_643_617,
    buildroot: {
      version: PINNED_BUILDROOT_VERSION,
      sha256: '5a59e7501b0b4ec52c41f4bfa79412320e0b37eae5f719605a258e8d0c6fc7fb',
    },
    v86: { packageVersion: PINNED_V86_PACKAGE_VERSION, commit: PINNED_V86_COMMIT },
    daemons: { bird: PINNED_BIRD_VERSION, frr: PINNED_FRR_VERSION },
    machine: { memoryBytes: 256 * 1024 * 1024, vgaMemoryBytes: 2 * 1024 * 1024, trunkMtu: 65_535 },
    artifacts: Object.entries(artifacts).map(([id, bytes]) => ({
      id,
      file: `${id}.bin`,
      size: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })),
  };
}

function fakeFetch(responses: Map<string, Uint8Array>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const bytes = responses.get(url);
    return bytes === undefined
      ? new Response(null, { status: 404 })
      : new Response(bytes.slice().buffer, { status: 200 });
  });
}
