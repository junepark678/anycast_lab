import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { MemoryV86ArtifactCache } from './artifact-cache';
import {
  PINNED_BIRD_VERSION,
  PINNED_BUILDROOT_VERSION,
  PINNED_FRR_VERSION,
  PINNED_LLVM_VERSION,
  PINNED_V86_COMMIT,
  PINNED_V86_PACKAGE_VERSION,
  V86_IMAGE_BUILD_ID,
  filesystemLayerUrl,
  v86FilesystemCacheKey,
  loadVerifiedV86Artifacts,
  parseV86ArtifactManifest,
  type V86ArtifactId,
  type V86FilesystemLayerEntry,
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
      ['https://lab.test/v86/rootfs-complete.squashfs', FILESYSTEM_BYTES.complete],
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
    expect(bundle.manifest.machine.model).toBe('shared-namespaces');
    expect(bundle.manifest.toolchain).toMatchObject({
      compiler: 'clang', compilerVersion: PINNED_LLVM_VERSION, optimization: 'O3', lto: 'thin',
    });
    expect(bundle.manifest.pgo).toMatchObject({ mode: 'use', profileSetBuildKey: '2'.repeat(64) });
    expect(bundle.artifacts.bzimage).toEqual(artifacts.bzimage);
    expect(bundle.filesystems.complete).toMatchObject({ size: FILESYSTEM_BYTES.complete.byteLength });
    expect(fetch).toHaveBeenCalledTimes(6);
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
      ['https://lab.test/v86/rootfs-complete.squashfs', FILESYSTEM_BYTES.complete],
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

  it('streams verified artifacts into a content-addressed cache and reuses them', async () => {
    const artifacts: Record<V86ArtifactId, Uint8Array> = {
      'v86-wasm': new Uint8Array([0, 97, 115, 109]),
      bios: new Uint8Array([1, 2]),
      'vga-bios': new Uint8Array([3, 4]),
      bzimage: new Uint8Array([5, 6, 7]),
    };
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifestFor(artifacts)));
    const responses = new Map<string, Uint8Array>([
      ['https://lab.test/v86/manifest.json', manifestBytes],
      ['https://lab.test/v86/rootfs-complete.squashfs', FILESYSTEM_BYTES.complete],
      ...Object.entries(artifacts).map(
        ([id, bytes]) => [`https://lab.test/v86/${id}.bin`, bytes] as const,
      ),
    ]);
    const fetch = fakeFetch(responses);
    const cache = new MemoryV86ArtifactCache();
    const digestSpy = vi.fn(digest);
    const source = {
      manifestUrl: 'https://lab.test/v86/manifest.json',
      manifestSha256: await digest(manifestBytes),
    };

    await loadVerifiedV86Artifacts(source, { fetch, digest: digestSpy, cache });
    await loadVerifiedV86Artifacts(source, { fetch, digest: digestSpy, cache });

    // The trusted manifest remains no-cache; all five immutable payloads are fetched once.
    expect(fetch).toHaveBeenCalledTimes(7);
    // Cache get/store already verifies immutable payloads incrementally.
    expect(digestSpy).toHaveBeenCalledTimes(2);
  });

  it('rejects incomplete PGO provenance and a non-pinned daemon toolchain', async () => {
    const artifacts: Record<V86ArtifactId, Uint8Array> = {
      'v86-wasm': new Uint8Array([0]),
      bios: new Uint8Array([1]),
      'vga-bios': new Uint8Array([2]),
      bzimage: new Uint8Array([3]),
    };
    const missingProfile = manifestFor(artifacts);
    missingProfile.pgo.birdProfileSha256 = null as never;
    expect(() => loadManifestOnly(missingProfile)).toThrow(/complete profile identity/);

    const wrongCompiler = manifestFor(artifacts);
    wrongCompiler.toolchain.compilerVersion = '22.0.0' as never;
    expect(() => loadManifestOnly(wrongCompiler)).toThrow(/pinned Clang O3 ThinLTO/);

    const wrongFilesystemCache = manifestFor(artifacts);
    wrongFilesystemCache.filesystem.cache.key = `sha256:${'0'.repeat(64)}`;
    expect(() => loadManifestOnly(wrongFilesystemCache)).toThrow(/filesystem cache identity/);

    const perNodeMachine = manifestFor(artifacts);
    perNodeMachine.machine.model = 'per-node-vm' as never;
    expect(() => loadManifestOnly(perNodeMachine)).toThrow(/requires shared namespaces/);

    for (const file of ['//evil.example/v86.wasm', '../v86.wasm', 'v86%2ewasm', 'v86.wasm?raw=1']) {
      const unsafePath = manifestFor(artifacts);
      unsafePath.artifacts[0]!.file = file;
      expect(() => loadManifestOnly(unsafePath)).toThrow(/Invalid file/);
    }
  });

  it('resolves local layers beside the manifest and deployed OCI layers by content address', () => {
    const layer = filesystemManifest().layers[0]!;
    expect(filesystemLayerUrl('https://lab.test/runtime/v86/manifest.json', layer)).toBe(
      'https://lab.test/runtime/v86/rootfs-complete.squashfs',
    );
    expect(filesystemLayerUrl(
      `https://objectstorage.example/n/ns/b/bucket/o/anycast-lab/native-v86/objects/sha256/${'a'.repeat(64)}/manifest.json`,
      layer,
    )).toBe(
      `https://objectstorage.example/n/ns/b/bucket/o/anycast-lab/native-v86/${layer.object}`,
    );
  });
});

function loadManifestOnly(value: unknown) {
  return parseV86ArtifactManifest(value);
}

function manifestFor(artifacts: Record<V86ArtifactId, Uint8Array>) {
  const filesystem = filesystemManifest();
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
    toolchain: {
      scope: 'bird-and-frr',
      compiler: 'clang',
      compilerVersion: PINNED_LLVM_VERSION,
      linker: 'lld',
      optimization: 'O3',
      lto: 'thin',
    },
    pgo: {
      mode: 'use',
      contextSha256: '1'.repeat(64),
      profileSetBuildKey: '2'.repeat(64),
      birdProfileSha256: '3'.repeat(64),
      frrProfileSha256: '4'.repeat(64),
    },
    machine: {
      model: 'shared-namespaces',
      memoryBytes: 256 * 1024 * 1024,
      vgaMemoryBytes: 2 * 1024 * 1024,
      trunkMtu: 65_535,
    },
    filesystem,
    artifacts: Object.entries(artifacts).map(([id, bytes]) => ({
      id,
      file: `${id}.bin`,
      size: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })),
  };
}

const FILESYSTEM_BYTES = {
  complete: new Uint8Array([0x68, 0x73, 0x71, 0x73, 1]),
  base: new Uint8Array([0x68, 0x73, 0x71, 0x73, 2]),
  bird: new Uint8Array([0x68, 0x73, 0x71, 0x73, 3]),
  frr: new Uint8Array([0x68, 0x73, 0x71, 0x73, 4]),
  toolbox: new Uint8Array([0x68, 0x73, 0x71, 0x73, 5]),
} as const;

function filesystemManifest() {
  const definitions = [
    ['complete', 'boot-complete', true, 'rootfs-complete.squashfs', [], 'root', 0],
    ['base', 'overlay-base', false, 'rootfs-base.squashfs', [], 'overlay-base', 0],
    ['bird', 'routing-suite', false, 'rootfs-bird.squashfs', ['base'], 'overlay-lower', 10],
    ['frr', 'routing-suite', false, 'rootfs-frr.squashfs', ['base'], 'overlay-lower', 20],
    ['toolbox', 'diagnostics', false, 'rootfs-toolbox.squashfs', ['base'], 'overlay-lower', 30],
  ] as const;
  const layers: V86FilesystemLayerEntry[] = definitions.map(([
    id, role, requiredAtBoot, file, dependsOn, type, order,
  ]) => {
    const bytes = FILESYSTEM_BYTES[id];
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    return {
      id,
      role,
      requiredAtBoot,
      file,
      object: `blobs/sha256/${sha256}.squashfs`,
      size: bytes.byteLength,
      sha256,
      cacheKey: `sha256:${sha256}`,
      dependsOn: [...dependsOn],
      mount: { type, path: '/', order, readOnly: true },
    };
  });
  return {
    schemaVersion: 1,
    layoutVersion: 1,
    format: 'squashfs',
    compression: 'zstd',
    blockSize: 65_536,
    cache: { namespace: 'anycastlab-v86-filesystem-v1', key: v86FilesystemCacheKey(layers) },
    layers,
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
