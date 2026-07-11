import { describe, expect, it, vi } from 'vitest';
import {
  loadNativeRuntimeAvailability,
  nativeMemoryEstimate,
  parseNativeRuntimeStatus,
} from './native-runtime';

const digest = 'a'.repeat(64);

describe('native runtime deployment status', () => {
  it('parses verified artifact metadata relative to a deployment base', () => {
    expect(parseNativeRuntimeStatus({
      schemaVersion: 1,
      nativeV86: true,
      manifestSha256: digest,
      buildId: 'image-r1',
      memoryBytes: 128 * 1024 * 1024,
    }, 'https://guide.example/lab/')).toEqual({
      available: true,
      manifestUrl: 'https://guide.example/lab/runtime/v86/manifest.json',
      manifestSha256: digest,
      buildId: 'image-r1',
      memoryBytes: 128 * 1024 * 1024,
    });
  });

  it('reports a deliberate artifact-free deployment without throwing', () => {
    expect(parseNativeRuntimeStatus({ schemaVersion: 1, nativeV86: false }, 'https://guide.example/lab/')).toEqual({
      available: false,
      reason: 'This deployment does not include the native VM image.',
    });
  });

  it.each([
    [{ schemaVersion: 2, nativeV86: false }, 'Unsupported native runtime status schema'],
    [{ schemaVersion: 1 }, 'missing nativeV86'],
    [{ schemaVersion: 1, nativeV86: true, manifestSha256: 'bad', buildId: 'r1', memoryBytes: 1 }, 'invalid manifest digest'],
    [{ schemaVersion: 1, nativeV86: true, manifestSha256: digest, buildId: '', memoryBytes: 1 }, 'invalid build id'],
    [{ schemaVersion: 1, nativeV86: true, manifestSha256: digest, buildId: 'r1', memoryBytes: 0 }, 'invalid memory size'],
  ])('rejects malformed deployment metadata %#', (status, message) => {
    expect(() => parseNativeRuntimeStatus(status, 'https://guide.example/lab/')).toThrow(message);
  });

  it('converts fetch and HTTP failures into an unavailable state', async () => {
    const httpFetch = vi.fn(async () => new Response('', { status: 503 }));
    await expect(loadNativeRuntimeAvailability('https://guide.example/lab', httpFetch)).resolves.toEqual({
      available: false,
      reason: 'Native runtime status returned HTTP 503.',
    });

    const failedFetch = vi.fn(async () => { throw new Error('offline'); });
    await expect(loadNativeRuntimeAvailability('https://guide.example/lab/', failedFetch)).resolves.toEqual({
      available: false,
      reason: 'offline',
    });
  });

  it('recognizes a development-server HTML fallback as missing metadata', async () => {
    const fetchImplementation = vi.fn(async () => new Response('<!doctype html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }));
    await expect(loadNativeRuntimeAvailability('https://guide.example/lab/', fetchImplementation)).resolves.toEqual({
      available: false,
      reason: 'This deployment does not publish native VM runtime metadata.',
    });
  });

  it('loads availability with a no-store request', async () => {
    const fetchImplementation = vi.fn(async () => Response.json({
      schemaVersion: 1,
      nativeV86: true,
      manifestSha256: digest,
      buildId: 'image-r1',
      memoryBytes: 64 * 1024 * 1024,
    }));
    await expect(loadNativeRuntimeAvailability('https://guide.example/lab', fetchImplementation)).resolves.toMatchObject({
      available: true,
      buildId: 'image-r1',
    });
    expect(fetchImplementation).toHaveBeenCalledWith(
      'https://guide.example/lab/runtime/status.json',
      { cache: 'no-store' },
    );
  });
});

describe('native memory estimate', () => {
  it('reports aggregate VM memory and singularizes one VM', () => {
    expect(nativeMemoryEstimate(6, 128 * 1024 * 1024)).toBe('768 MiB for 6 VMs');
    expect(nativeMemoryEstimate(1, 128 * 1024 * 1024)).toBe('128 MiB for 1 VM');
  });
});
