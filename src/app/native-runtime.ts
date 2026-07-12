import { V86_IMAGE_BUILD_ID } from '../appliances/v86/manifest';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export type NativeRuntimeAvailability =
  | { readonly available: false; readonly reason: string }
  | {
      readonly available: true;
      readonly manifestUrl: string;
      readonly manifestSha256: string;
      readonly buildId: string;
      readonly memoryBytes: number;
    };

export function parseNativeRuntimeStatus(
  value: unknown,
  baseUrl: string,
): NativeRuntimeAvailability {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Native runtime status must be an object');
  }
  const status = value as Record<string, unknown>;
  if (status.schemaVersion !== 1) {
    throw new Error(`Unsupported native runtime status schema: ${String(status.schemaVersion)}`);
  }
  if (status.nativeV86 === false) {
    return {
      available: false,
      reason: 'This deployment does not include the native VM image.',
    };
  }
  if (status.nativeV86 !== true) {
    throw new Error('Native runtime status is missing nativeV86');
  }
  if (typeof status.manifestSha256 !== 'string' || !SHA256_PATTERN.test(status.manifestSha256)) {
    throw new Error('Native runtime status has an invalid manifest digest');
  }
  if (typeof status.buildId !== 'string' || status.buildId.length === 0) {
    throw new Error('Native runtime status has an invalid build id');
  }
  if (status.buildId !== V86_IMAGE_BUILD_ID) {
    throw new Error(
      `Native runtime status publishes incompatible build ${status.buildId}; expected ${V86_IMAGE_BUILD_ID}`,
    );
  }
  if (!Number.isSafeInteger(status.memoryBytes) || Number(status.memoryBytes) <= 0) {
    throw new Error('Native runtime status has an invalid memory size');
  }
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const manifestUrl = status.manifestUrl === undefined
    ? new URL('runtime/v86/manifest.json', normalizedBase).href
    : parseRuntimeUrl(status.manifestUrl, normalizedBase, 'manifestUrl');
  return {
    available: true,
    manifestUrl,
    manifestSha256: status.manifestSha256,
    buildId: status.buildId,
    memoryBytes: Number(status.memoryBytes),
  };
}

export async function loadNativeRuntimeAvailability(
  baseUrl: string,
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
): Promise<NativeRuntimeAvailability> {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const statusUrl = new URL('runtime/status.json', normalizedBase).href;
  try {
    const response = await fetchImplementation(statusUrl, { cache: 'no-store' });
    if (!response.ok) {
      return { available: false, reason: `Native runtime status returned HTTP ${response.status}.` };
    }
    if (!response.headers.get('content-type')?.includes('application/json')) {
      return { available: false, reason: 'This deployment does not publish native VM runtime metadata.' };
    }
    const localStatus = await response.json() as unknown;
    const releaseStatusUrl = parseReleaseStatusUrl(localStatus, normalizedBase);
    if (releaseStatusUrl === null) return parseNativeRuntimeStatus(localStatus, normalizedBase);

    const releaseResponse = await fetchImplementation(releaseStatusUrl, { cache: 'no-store' });
    if (!releaseResponse.ok) {
      return { available: false, reason: `External native runtime status returned HTTP ${releaseResponse.status}.` };
    }
    if (!releaseResponse.headers.get('content-type')?.includes('application/json')) {
      return { available: false, reason: 'The external native runtime origin did not return JSON metadata.' };
    }
    const releaseStatus = await releaseResponse.json() as unknown;
    if (parseReleaseStatusUrl(releaseStatus, releaseStatusUrl) !== null) {
      throw new Error('External native runtime status cannot redirect to another status document');
    }
    return parseNativeRuntimeStatus(releaseStatus, new URL('.', releaseStatusUrl).href);
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : 'Native runtime status could not be loaded.',
    };
  }
}

function parseReleaseStatusUrl(value: unknown, baseUrl: string): string | null {
  if (typeof value !== 'object' || value === null || !('releaseStatusUrl' in value)) return null;
  const status = value as Record<string, unknown>;
  if (status.schemaVersion !== 1 || status.nativeV86 !== true) {
    throw new Error('External native runtime pointer has an invalid schema');
  }
  return parseRuntimeUrl(status.releaseStatusUrl, baseUrl, 'releaseStatusUrl');
}

function parseRuntimeUrl(value: unknown, baseUrl: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Native runtime status has an invalid ${label}`);
  }
  const url = new URL(value, baseUrl);
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(`Native runtime ${label} must use HTTPS`);
  }
  if (url.username !== '' || url.password !== '' || url.hash !== '') {
    throw new Error(`Native runtime ${label} cannot contain credentials or a fragment`);
  }
  return url.href;
}

export function nativeMemoryEstimate(
  nodeCount: number,
  sharedMemoryBytes: number,
): string {
  const totalMebibytes = Math.ceil(sharedMemoryBytes / (1024 * 1024));
  return `${totalMebibytes} MiB shared by ${nodeCount} node${nodeCount === 1 ? '' : 's'}`;
}
