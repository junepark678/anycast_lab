import { describe, expect, it, vi } from 'vitest';

import {
  formatStorageBytes,
  getStorageStatus,
  isStoragePressure,
  requestPersistentStorage,
} from './storage';

describe('browser storage helpers', () => {
  it('summarizes quota and persistence state', async () => {
    const status = await getStorageStatus({
      estimate: async () => ({ usage: 80, quota: 100 }),
      persisted: async () => true,
    });

    expect(status).toEqual({
      supported: true,
      usage: 80,
      quota: 100,
      available: 20,
      usageRatio: 0.8,
      persisted: true,
    });
    expect(isStoragePressure(status)).toBe(true);
  });

  it('requests persistent storage only when needed', async () => {
    const persist = vi.fn(async () => true);
    await expect(
      requestPersistentStorage({
        persisted: async () => false,
        persist,
      }),
    ).resolves.toEqual({ status: 'granted' });
    expect(persist).toHaveBeenCalledOnce();

    await expect(requestPersistentStorage(undefined)).resolves.toEqual({
      status: 'unsupported',
    });
  });

  it('formats binary byte counts', () => {
    expect(formatStorageBytes(500)).toBe('500 B');
    expect(formatStorageBytes(1_024)).toBe('1 KiB');
    expect(formatStorageBytes(5.5 * 1_024 * 1_024)).toBe('5.50 MiB');
  });
});
