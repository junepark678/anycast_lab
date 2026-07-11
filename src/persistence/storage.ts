export interface StorageManagerLike {
  estimate?(): Promise<{ usage?: number; quota?: number }>;
  persisted?(): Promise<boolean>;
  persist?(): Promise<boolean>;
}

export interface LabStorageStatus {
  supported: boolean;
  usage?: number;
  quota?: number;
  available?: number;
  usageRatio?: number;
  persisted?: boolean;
}

export type PersistenceRequestResult =
  | { status: 'granted' }
  | { status: 'denied' }
  | { status: 'unsupported' }
  | { status: 'error'; error: unknown };

export function browserStorageManager(): StorageManagerLike | undefined {
  if (typeof navigator === 'undefined' || navigator.storage === undefined) {
    return undefined;
  }
  return navigator.storage;
}

export async function getStorageStatus(
  manager: StorageManagerLike | undefined = browserStorageManager(),
): Promise<LabStorageStatus> {
  if (manager === undefined) {
    return { supported: false };
  }

  const [estimateResult, persistedResult] = await Promise.allSettled([
    manager.estimate?.() ?? Promise.resolve({}),
    manager.persisted?.() ?? Promise.resolve(undefined),
  ]);
  const estimate: { usage?: number; quota?: number } =
    estimateResult.status === 'fulfilled' ? estimateResult.value : {};
  const persisted =
    persistedResult.status === 'fulfilled' ? persistedResult.value : undefined;
  const usage = finiteNonNegative(estimate.usage);
  const quota = finiteNonNegative(estimate.quota);

  return {
    supported:
      manager.estimate !== undefined ||
      manager.persisted !== undefined ||
      manager.persist !== undefined,
    usage,
    quota,
    available:
      usage !== undefined && quota !== undefined
        ? Math.max(0, quota - usage)
        : undefined,
    usageRatio:
      usage !== undefined && quota !== undefined && quota > 0
        ? Math.min(1, usage / quota)
        : undefined,
    persisted: typeof persisted === 'boolean' ? persisted : undefined,
  };
}

export async function requestPersistentStorage(
  manager: StorageManagerLike | undefined = browserStorageManager(),
): Promise<PersistenceRequestResult> {
  if (manager === undefined) {
    return { status: 'unsupported' };
  }

  try {
    if ((await manager.persisted?.()) === true) {
      return { status: 'granted' };
    }
    if (manager.persist === undefined) {
      return { status: 'unsupported' };
    }
    return (await manager.persist())
      ? { status: 'granted' }
      : { status: 'denied' };
  } catch (error) {
    return { status: 'error', error };
  }
}

export function isStoragePressure(
  status: LabStorageStatus,
  threshold = 0.8,
): boolean {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new RangeError('Storage pressure threshold must be between 0 and 1');
  }
  return status.usageRatio !== undefined && status.usageRatio >= threshold;
}

export function formatStorageBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new RangeError('Byte count must be a finite non-negative number');
  }
  if (bytes < 1_024) {
    return `${Math.round(bytes)} B`;
  }
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let amount = bytes;
  let unit = -1;
  do {
    amount /= 1_024;
    unit += 1;
  } while (amount >= 1_024 && unit < units.length - 1);
  const precision = amount >= 10 ? 1 : 2;
  return `${amount.toFixed(precision).replace(/\.0+$/, '')} ${units[unit]}`;
}

function finiteNonNegative(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}
