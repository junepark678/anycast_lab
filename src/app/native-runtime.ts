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
  if (!Number.isSafeInteger(status.memoryBytes) || Number(status.memoryBytes) <= 0) {
    throw new Error('Native runtime status has an invalid memory size');
  }
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return {
    available: true,
    manifestUrl: new URL('runtime/v86/manifest.json', normalizedBase).href,
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
    return parseNativeRuntimeStatus(await response.json(), normalizedBase);
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : 'Native runtime status could not be loaded.',
    };
  }
}

export function nativeMemoryEstimate(
  nodeCount: number,
  memoryBytesPerNode: number,
): string {
  const totalMebibytes = Math.ceil((nodeCount * memoryBytesPerNode) / (1024 * 1024));
  return `${totalMebibytes} MiB for ${nodeCount} VM${nodeCount === 1 ? '' : 's'}`;
}
