export const PINNED_V86_PACKAGE_VERSION = '0.5.424' as const;
export const PINNED_V86_COMMIT = '2f1346b0e7d88d4cbbbcc05fe15b4e369c3de23f' as const;
export const PINNED_BUILDROOT_VERSION = '2026.02.3' as const;
export const PINNED_BIRD_VERSION = '2.15.1' as const;
export const PINNED_FRR_VERSION = '10.5.1' as const;
export const V86_IMAGE_BUILD_ID = 'anycastlab-v86-br2026.02.3-r1' as const;

export type V86ArtifactId = 'v86-wasm' | 'bios' | 'vga-bios' | 'bzimage';

export interface V86ArtifactManifestEntry {
  readonly id: V86ArtifactId;
  readonly file: string;
  readonly size: number;
  readonly sha256: string;
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
  readonly machine: {
    readonly memoryBytes: number;
    readonly vgaMemoryBytes: number;
    readonly trunkMtu: number;
  };
  readonly artifacts: readonly V86ArtifactManifestEntry[];
}

export interface VerifiedV86ArtifactBundle {
  readonly manifest: V86ArtifactManifest;
  readonly manifestSha256: string;
  readonly artifacts: Readonly<Record<V86ArtifactId, Uint8Array>>;
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
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const REQUIRED_ARTIFACTS: readonly V86ArtifactId[] = [
  'v86-wasm',
  'bios',
  'vga-bios',
  'bzimage',
];

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

  await Promise.all(
    manifest.artifacts.map(async (artifact) => {
      const url = new URL(artifact.file, source.manifestUrl).href;
      const bytes = await fetchBytes(fetchImplementation, url);
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
      artifacts[artifact.id] = bytes;
    }),
  );

  return { manifest, manifestSha256: source.manifestSha256, artifacts };
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

  const machine = requireRecord(value.machine, 'machine');
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

  if (!Array.isArray(value.artifacts)) throw new Error('v86 manifest artifacts must be an array');
  const seen = new Set<string>();
  const artifacts = value.artifacts.map((raw): V86ArtifactManifestEntry => {
    if (!isRecord(raw) || !isArtifactId(raw.id)) throw new Error('Invalid v86 artifact id');
    if (seen.has(raw.id)) throw new Error(`Duplicate v86 artifact: ${raw.id}`);
    seen.add(raw.id);
    if (typeof raw.file !== 'string' || raw.file.length === 0 || /^[a-z]+:/i.test(raw.file)) {
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
    machine: {
      memoryBytes: machine.memoryBytes,
      vgaMemoryBytes: machine.vgaMemoryBytes,
      trunkMtu: machine.trunkMtu,
    },
    artifacts,
  };
}

async function fetchBytes(fetchImplementation: typeof globalThis.fetch, url: string): Promise<Uint8Array> {
  const response = await fetchImplementation(url);
  if (!response.ok) throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
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
  return (value & (value - 1)) === 0;
}

function isArtifactId(value: unknown): value is V86ArtifactId {
  return typeof value === 'string' && (REQUIRED_ARTIFACTS as readonly string[]).includes(value);
}
