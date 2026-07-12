import {
  MemoryV86ArtifactCache,
  type CachedV86Artifact,
  type V86ArtifactCache,
} from './artifact-cache';
import { StreamingSha256 } from './sha256-stream';

export const PINNED_V86_PACKAGE_VERSION = '0.5.424' as const;
export const PINNED_V86_COMMIT = '2f1346b0e7d88d4cbbbcc05fe15b4e369c3de23f' as const;
export const PINNED_BUILDROOT_VERSION = '2026.02.3' as const;
export const PINNED_BIRD_VERSION = '2.15.1' as const;
export const PINNED_FRR_VERSION = '10.5.1' as const;
export const PINNED_LLVM_VERSION = '21.1.8' as const;
export const V86_IMAGE_BUILD_ID = 'anycastlab-v86-br2026.02.3-r4' as const;

export type V86ArtifactId = 'v86-wasm' | 'bios' | 'vga-bios' | 'bzimage';
export type V86PgoMode = 'none' | 'generate' | 'use';
export type V86FilesystemLayerId = 'complete' | 'base' | 'bird' | 'frr' | 'toolbox';
export type V86FilesystemLayerRole = 'boot-complete' | 'overlay-base' | 'routing-suite' | 'diagnostics';
export type V86FilesystemMountType = 'root' | 'overlay-base' | 'overlay-lower';

export interface V86ArtifactManifestEntry {
  readonly id: V86ArtifactId;
  readonly file: string;
  readonly size: number;
  readonly sha256: string;
}

export interface V86FilesystemLayerEntry {
  readonly id: V86FilesystemLayerId;
  readonly role: V86FilesystemLayerRole;
  readonly requiredAtBoot: boolean;
  readonly file: string;
  readonly object: string;
  readonly size: number;
  readonly sha256: string;
  readonly cacheKey: string;
  readonly dependsOn: readonly V86FilesystemLayerId[];
  readonly mount: {
    readonly type: V86FilesystemMountType;
    readonly path: '/';
    readonly order: number;
    readonly readOnly: true;
  };
}

export interface V86FilesystemManifest {
  readonly schemaVersion: 1;
  readonly layoutVersion: 1;
  readonly format: 'squashfs';
  readonly compression: 'zstd';
  readonly blockSize: 65_536;
  readonly cache: {
    readonly namespace: 'anycastlab-v86-filesystem-v1';
    readonly key: string;
  };
  readonly layers: readonly V86FilesystemLayerEntry[];
}

export interface V86ArtifactManifest {
  readonly schemaVersion: 1;
  readonly imageId: 'anycast-lab-router';
  readonly buildId: typeof V86_IMAGE_BUILD_ID;
  readonly sourceDateEpoch: number;
  readonly buildroot: {
    readonly version: typeof PINNED_BUILDROOT_VERSION;
    readonly sha256: string;
  };
  readonly v86: {
    readonly packageVersion: typeof PINNED_V86_PACKAGE_VERSION;
    readonly commit: typeof PINNED_V86_COMMIT;
  };
  readonly daemons: {
    readonly bird: typeof PINNED_BIRD_VERSION;
    readonly frr: typeof PINNED_FRR_VERSION;
  };
  readonly toolchain: {
    readonly scope: 'bird-and-frr';
    readonly compiler: 'clang';
    readonly compilerVersion: typeof PINNED_LLVM_VERSION;
    readonly linker: 'lld';
    readonly optimization: 'O3';
    readonly lto: 'thin';
  };
  readonly pgo: {
    readonly mode: V86PgoMode;
    readonly contextSha256: string;
    readonly profileSetBuildKey: string | null;
    readonly birdProfileSha256: string | null;
    readonly frrProfileSha256: string | null;
  };
  readonly machine: {
    readonly model: 'shared-namespaces';
    readonly memoryBytes: number;
    readonly vgaMemoryBytes: number;
    readonly trunkMtu: number;
  };
  readonly filesystem: V86FilesystemManifest;
  readonly artifacts: readonly V86ArtifactManifestEntry[];
}

export interface VerifiedV86ArtifactBundle {
  readonly manifest: V86ArtifactManifest;
  readonly manifestSha256: string;
  readonly artifacts: Readonly<Record<V86ArtifactId, Uint8Array>>;
  /** Required boot filesystems remain Blob/File-backed so v86 can page them from OPFS. */
  readonly filesystems: Readonly<Partial<Record<V86FilesystemLayerId, CachedV86Artifact>>>;
}

export interface V86ArtifactSource {
  /** URL of the generated manifest. Relative artifact paths resolve against it. */
  readonly manifestUrl: string;
  /** Trusted digest compiled into/deployed with the application. */
  readonly manifestSha256: string;
}

export interface V86ArtifactLoaderOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly digest?: (contents: Uint8Array) => Promise<string>;
  /** Content-addressed persistent cache; OPFS is used by the browser runtime. */
  readonly cache?: V86ArtifactCache;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const REQUIRED_ARTIFACTS: readonly V86ArtifactId[] = [
  'v86-wasm',
  'bios',
  'vga-bios',
  'bzimage',
];

const FILESYSTEM_LAYER_CONTRACT = [
  {
    id: 'complete', role: 'boot-complete', requiredAtBoot: true,
    file: 'rootfs-complete.squashfs', dependsOn: [], mount: { type: 'root', order: 0 },
  },
  {
    id: 'base', role: 'overlay-base', requiredAtBoot: false,
    file: 'rootfs-base.squashfs', dependsOn: [], mount: { type: 'overlay-base', order: 0 },
  },
  {
    id: 'bird', role: 'routing-suite', requiredAtBoot: false,
    file: 'rootfs-bird.squashfs', dependsOn: ['base'], mount: { type: 'overlay-lower', order: 10 },
  },
  {
    id: 'frr', role: 'routing-suite', requiredAtBoot: false,
    file: 'rootfs-frr.squashfs', dependsOn: ['base'], mount: { type: 'overlay-lower', order: 20 },
  },
  {
    id: 'toolbox', role: 'diagnostics', requiredAtBoot: false,
    file: 'rootfs-toolbox.squashfs', dependsOn: ['base'], mount: { type: 'overlay-lower', order: 30 },
  },
] as const satisfies readonly {
  readonly id: V86FilesystemLayerId;
  readonly role: V86FilesystemLayerRole;
  readonly requiredAtBoot: boolean;
  readonly file: string;
  readonly dependsOn: readonly V86FilesystemLayerId[];
  readonly mount: { readonly type: V86FilesystemMountType; readonly order: number };
}[];

export async function sha256Hex(contents: Uint8Array): Promise<string> {
  if (globalThis.crypto?.subtle === undefined) {
    throw new Error('Web Crypto SHA-256 is required to verify v86 artifacts');
  }
  const copy = contents.slice();
  const digest = await globalThis.crypto.subtle.digest('SHA-256', copy.buffer);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function loadVerifiedV86Artifacts(
  source: V86ArtifactSource,
  options: V86ArtifactLoaderOptions = {},
): Promise<VerifiedV86ArtifactBundle> {
  assertSha256('manifestSha256', source.manifestSha256);
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (fetchImplementation === undefined) throw new Error('fetch is required to load v86 artifacts');
  const digest = options.digest ?? sha256Hex;

  const manifestBytes = await fetchBytes(fetchImplementation, source.manifestUrl);
  const actualManifestHash = await digest(manifestBytes);
  if (actualManifestHash !== source.manifestSha256) {
    throw new Error(
      `v86 manifest digest mismatch: expected ${source.manifestSha256}, received ${actualManifestHash}`,
    );
  }

  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch (error) {
    throw new Error('v86 artifact manifest is not valid JSON', { cause: error });
  }
  const manifest = parseV86ArtifactManifest(rawManifest);
  const artifacts = {} as Record<V86ArtifactId, Uint8Array>;
  const filesystems: Partial<Record<V86FilesystemLayerId, CachedV86Artifact>> = {};
  const filesystemCache = options.cache ?? new MemoryV86ArtifactCache();

  await Promise.all(
    manifest.artifacts.map(async (artifact) => {
      const url = new URL(artifact.file, source.manifestUrl).href;
      if (options.cache !== undefined) {
        artifacts[artifact.id] = await loadCachedArtifact(
          options.cache,
          fetchImplementation,
          url,
          artifact,
        );
        return;
      }
      const bytes = await fetchBytes(fetchImplementation, url);
      await verifyArtifactBytes(artifact, bytes, digest);
      artifacts[artifact.id] = bytes;
    }),
  );

  await Promise.all(
    manifest.filesystem.layers
      .filter((layer) => layer.requiredAtBoot)
      .map(async (layer) => {
        const url = filesystemLayerUrl(source.manifestUrl, layer);
        filesystems[layer.id] = await loadCachedBlob(
          filesystemCache,
          fetchImplementation,
          url,
          layer,
        );
      }),
  );

  return { manifest, manifestSha256: source.manifestSha256, artifacts, filesystems };
}

export function parseV86ArtifactManifest(value: unknown): V86ArtifactManifest {
  if (!isRecord(value)) throw new Error('v86 artifact manifest must be an object');
  if (value.schemaVersion !== 1) throw new Error('Unsupported v86 artifact manifest schema');
  if (value.imageId !== 'anycast-lab-router') throw new Error('Unexpected v86 image id');
  if (value.buildId !== V86_IMAGE_BUILD_ID) throw new Error(`Unexpected v86 build id: ${String(value.buildId)}`);
  if (!isPositiveInteger(value.sourceDateEpoch)) throw new Error('Invalid v86 sourceDateEpoch');

  const buildroot = requireRecord(value.buildroot, 'buildroot');
  if (buildroot.version !== PINNED_BUILDROOT_VERSION) {
    throw new Error(`Expected Buildroot ${PINNED_BUILDROOT_VERSION}`);
  }
  if (typeof buildroot.sha256 !== 'string') throw new Error('Invalid Buildroot digest');
  assertSha256('buildroot.sha256', buildroot.sha256);

  const v86 = requireRecord(value.v86, 'v86');
  if (v86.packageVersion !== PINNED_V86_PACKAGE_VERSION || v86.commit !== PINNED_V86_COMMIT) {
    throw new Error('The appliance was not built for the pinned v86 package and commit');
  }

  const daemons = requireRecord(value.daemons, 'daemons');
  if (daemons.bird !== PINNED_BIRD_VERSION || daemons.frr !== PINNED_FRR_VERSION) {
    throw new Error('The appliance daemon versions do not match the runtime descriptors');
  }

  const toolchain = requireRecord(value.toolchain, 'toolchain');
  if (
    toolchain.scope !== 'bird-and-frr' ||
    toolchain.compiler !== 'clang' ||
    toolchain.compilerVersion !== PINNED_LLVM_VERSION ||
    toolchain.linker !== 'lld' ||
    toolchain.optimization !== 'O3' ||
    toolchain.lto !== 'thin'
  ) {
    throw new Error('The appliance routing daemons do not use the pinned Clang O3 ThinLTO toolchain');
  }

  const pgo = requireRecord(value.pgo, 'pgo');
  if (pgo.mode !== 'none' && pgo.mode !== 'generate' && pgo.mode !== 'use') {
    throw new Error('Invalid v86 PGO mode');
  }
  if (typeof pgo.contextSha256 !== 'string') throw new Error('Invalid PGO context digest');
  assertSha256('pgo.contextSha256', pgo.contextSha256);
  const profileDigests = [pgo.profileSetBuildKey, pgo.birdProfileSha256, pgo.frrProfileSha256];
  if (pgo.mode === 'use') {
    for (const [index, digest] of profileDigests.entries()) {
      if (typeof digest !== 'string') throw new Error('PGO use mode requires a complete profile identity');
      assertSha256(`pgo.profileDigest.${index}`, digest);
    }
  } else if (profileDigests.some((digest) => digest !== null)) {
    throw new Error('Only PGO use mode may identify optimized profiles');
  }

  const machine = requireRecord(value.machine, 'machine');
  if (machine.model !== 'shared-namespaces') {
    throw new Error('Unsupported v86 machine model; this runtime requires shared namespaces');
  }
  if (
    !isPositiveInteger(machine.memoryBytes) ||
    !isPowerOfTwo(machine.memoryBytes) ||
    !isPositiveInteger(machine.vgaMemoryBytes) ||
    !isPowerOfTwo(machine.vgaMemoryBytes) ||
    !isPositiveInteger(machine.trunkMtu) ||
    machine.trunkMtu < 1504 ||
    machine.trunkMtu > 65_535
  ) {
    throw new Error('Invalid v86 machine sizing');
  }

  const filesystem = parseV86FilesystemManifest(value.filesystem);

  if (!Array.isArray(value.artifacts)) throw new Error('v86 manifest artifacts must be an array');
  const seen = new Set<string>();
  const artifacts = value.artifacts.map((raw): V86ArtifactManifestEntry => {
    if (!isRecord(raw) || !isArtifactId(raw.id)) throw new Error('Invalid v86 artifact id');
    if (seen.has(raw.id)) throw new Error(`Duplicate v86 artifact: ${raw.id}`);
    seen.add(raw.id);
    if (typeof raw.file !== 'string' || !isSafeRelativeArtifactPath(raw.file)) {
      throw new Error(`Invalid file for v86 artifact ${raw.id}`);
    }
    if (!isPositiveInteger(raw.size)) throw new Error(`Invalid size for v86 artifact ${raw.id}`);
    if (typeof raw.sha256 !== 'string') throw new Error(`Invalid digest for v86 artifact ${raw.id}`);
    assertSha256(`artifacts.${raw.id}.sha256`, raw.sha256);
    return { id: raw.id, file: raw.file, size: raw.size, sha256: raw.sha256 };
  });

  for (const id of REQUIRED_ARTIFACTS) {
    if (!seen.has(id)) throw new Error(`Missing required v86 artifact: ${id}`);
  }
  if (seen.size !== REQUIRED_ARTIFACTS.length) throw new Error('Unexpected v86 artifact in manifest');

  return {
    schemaVersion: 1,
    imageId: 'anycast-lab-router',
    buildId: V86_IMAGE_BUILD_ID,
    sourceDateEpoch: value.sourceDateEpoch,
    buildroot: { version: PINNED_BUILDROOT_VERSION, sha256: buildroot.sha256 },
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
      mode: pgo.mode,
      contextSha256: pgo.contextSha256,
      profileSetBuildKey: pgo.profileSetBuildKey as string | null,
      birdProfileSha256: pgo.birdProfileSha256 as string | null,
      frrProfileSha256: pgo.frrProfileSha256 as string | null,
    },
    machine: {
      model: 'shared-namespaces',
      memoryBytes: machine.memoryBytes,
      vgaMemoryBytes: machine.vgaMemoryBytes,
      trunkMtu: machine.trunkMtu,
    },
    filesystem,
    artifacts,
  };
}

export function parseV86FilesystemManifest(value: unknown): V86FilesystemManifest {
  const filesystem = requireRecord(value, 'filesystem');
  if (
    filesystem.schemaVersion !== 1 ||
    filesystem.layoutVersion !== 1 ||
    filesystem.format !== 'squashfs' ||
    filesystem.compression !== 'zstd' ||
    filesystem.blockSize !== 65_536
  ) {
    throw new Error('Unsupported v86 filesystem layout');
  }
  if (!Array.isArray(filesystem.layers) || filesystem.layers.length !== FILESYSTEM_LAYER_CONTRACT.length) {
    throw new Error(`v86 filesystem must contain ${FILESYSTEM_LAYER_CONTRACT.length} pinned layers`);
  }
  const layers = filesystem.layers.map((raw, index): V86FilesystemLayerEntry => {
    const contract = FILESYSTEM_LAYER_CONTRACT[index]!;
    const layer = requireRecord(raw, `filesystem.layers.${index}`);
    if (
      layer.id !== contract.id ||
      layer.role !== contract.role ||
      layer.requiredAtBoot !== contract.requiredAtBoot ||
      layer.file !== contract.file
    ) {
      throw new Error(`v86 filesystem layer ${index} does not match the ${contract.id} contract`);
    }
    if (!isPositiveInteger(layer.size)) throw new Error(`Invalid size for filesystem layer ${contract.id}`);
    if (typeof layer.sha256 !== 'string') throw new Error(`Invalid digest for filesystem layer ${contract.id}`);
    assertSha256(`filesystem.layers.${contract.id}.sha256`, layer.sha256);
    const expectedObject = `blobs/sha256/${layer.sha256}.squashfs`;
    if (layer.object !== expectedObject || layer.cacheKey !== `sha256:${layer.sha256}`) {
      throw new Error(`Invalid content address for filesystem layer ${contract.id}`);
    }
    if (
      !Array.isArray(layer.dependsOn) ||
      layer.dependsOn.length !== contract.dependsOn.length ||
      layer.dependsOn.some((dependency, dependencyIndex) => dependency !== contract.dependsOn[dependencyIndex])
    ) {
      throw new Error(`Invalid dependencies for filesystem layer ${contract.id}`);
    }
    const mount = requireRecord(layer.mount, `filesystem.layers.${contract.id}.mount`);
    if (
      mount.type !== contract.mount.type ||
      mount.path !== '/' ||
      mount.order !== contract.mount.order ||
      mount.readOnly !== true
    ) {
      throw new Error(`Invalid mount contract for filesystem layer ${contract.id}`);
    }
    return {
      id: contract.id,
      role: contract.role,
      requiredAtBoot: contract.requiredAtBoot,
      file: contract.file,
      object: expectedObject,
      size: layer.size,
      sha256: layer.sha256,
      cacheKey: `sha256:${layer.sha256}`,
      dependsOn: [...contract.dependsOn],
      mount: {
        type: contract.mount.type,
        path: '/',
        order: contract.mount.order,
        readOnly: true,
      },
    };
  });
  const cache = requireRecord(filesystem.cache, 'filesystem.cache');
  if (cache.namespace !== 'anycastlab-v86-filesystem-v1') {
    throw new Error('Unsupported v86 filesystem cache namespace');
  }
  const expectedCacheKey = v86FilesystemCacheKey(layers);
  if (cache.key !== expectedCacheKey) throw new Error('Invalid v86 filesystem cache identity');
  return {
    schemaVersion: 1,
    layoutVersion: 1,
    format: 'squashfs',
    compression: 'zstd',
    blockSize: 65_536,
    cache: { namespace: 'anycastlab-v86-filesystem-v1', key: expectedCacheKey },
    layers,
  };
}

export function v86FilesystemCacheKey(layers: readonly V86FilesystemLayerEntry[]): string {
  const projection = {
    schemaVersion: 1,
    layoutVersion: 1,
    format: 'squashfs',
    compression: 'zstd',
    blockSize: 65_536,
    layers: layers.map((layer) => ({
      id: layer.id,
      role: layer.role,
      requiredAtBoot: layer.requiredAtBoot,
      file: layer.file,
      object: layer.object,
      size: layer.size,
      sha256: layer.sha256,
      dependsOn: [...layer.dependsOn],
      mount: { ...layer.mount },
    })),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(projection));
  return `sha256:${new StreamingSha256().update(bytes).digestHex()}`;
}

export function filesystemLayerUrl(
  manifestUrl: string,
  layer: V86FilesystemLayerEntry,
): string {
  const url = new URL(manifestUrl);
  if (/\/objects\/sha256\/[a-f0-9]{64}\/manifest\.json$/.test(url.pathname)) {
    return new URL(`../../../${layer.object}`, url).href;
  }
  return new URL(layer.file, url).href;
}

async function fetchBytes(fetchImplementation: typeof globalThis.fetch, url: string): Promise<Uint8Array> {
  const response = await fetchImplementation(url);
  if (!response.ok) throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function loadCachedArtifact(
  cache: V86ArtifactCache,
  fetchImplementation: typeof globalThis.fetch,
  url: string,
  artifact: V86ArtifactManifestEntry,
): Promise<Uint8Array> {
  const bytes = await readBlob((await loadCachedBlob(cache, fetchImplementation, url, artifact)).blob);
  if (bytes.byteLength !== artifact.size) {
    throw new Error(`Cached v86 artifact ${artifact.id} has an invalid size`);
  }
  return bytes;
}

async function loadCachedBlob(
  cache: V86ArtifactCache,
  fetchImplementation: typeof globalThis.fetch,
  url: string,
  artifact: { readonly size: number; readonly sha256: string },
): Promise<CachedV86Artifact> {
  const identity = { size: artifact.size, sha256: artifact.sha256 };
  const cached = await cache.get(identity);
  if (cached !== null) return cached;

  const response = await fetchImplementation(url);
  if (!response.ok) throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  if (response.body === null) {
    throw new Error(`Failed to cache ${url}: response body is not streamable`);
  }
  return cache.store(identity, response.body);
}

async function verifyArtifactBytes(
  artifact: V86ArtifactManifestEntry,
  bytes: Uint8Array,
  digest: (contents: Uint8Array) => Promise<string>,
): Promise<void> {
  if (bytes.byteLength !== artifact.size) {
    throw new Error(
      `v86 artifact ${artifact.id} has size ${bytes.byteLength}; expected ${artifact.size}`,
    );
  }
  const actualHash = await digest(bytes);
  if (actualHash !== artifact.sha256) {
    throw new Error(
      `v86 artifact ${artifact.id} digest mismatch: expected ${artifact.sha256}, received ${actualHash}`,
    );
  }
}

function readBlob(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer().then((buffer) => new Uint8Array(buffer));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Artifact Blob read failed'));
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.readAsArrayBuffer(blob);
  });
}

function assertSha256(name: string, value: string): void {
  if (!SHA256_PATTERN.test(value)) throw new Error(`${name} must be a lowercase SHA-256 digest`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`v86 manifest ${name} must be an object`);
  return value;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isPowerOfTwo(value: number): boolean {
  return Number.isInteger(Math.log2(value));
}

function isArtifactId(value: unknown): value is V86ArtifactId {
  return typeof value === 'string' && (REQUIRED_ARTIFACTS as readonly string[]).includes(value);
}

function isSafeRelativeArtifactPath(value: string): boolean {
  if (
    value.length === 0 ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.includes('?') ||
    value.includes('#') ||
    value.includes('%')
  ) {
    return false;
  }
  const segments = value.split('/');
  return segments.every((segment) => (
    segment.length > 0 && segment !== '.' && segment !== '..' && /^[A-Za-z0-9._-]+$/.test(segment)
  ));
}
