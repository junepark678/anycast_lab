import { describe, expect, it, vi } from 'vitest';
import { V86_IMAGE_BUILD_ID } from '../appliances/v86';
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
      buildId: V86_IMAGE_BUILD_ID,
      memoryBytes: 128 * 1024 * 1024,
    }, 'https://guide.example/lab/')).toEqual({
      available: true,
      manifestUrl: 'https://guide.example/lab/runtime/v86/manifest.json',
      manifestSha256: digest,
      buildId: V86_IMAGE_BUILD_ID,
      memoryBytes: 128 * 1024 * 1024,
    });
  });

  it('accepts an HTTPS manifest on a dedicated artifact origin', () => {
    expect(parseNativeRuntimeStatus({
      schemaVersion: 1,
      nativeV86: true,
      manifestUrl: 'https://assets.example/v86/sha256/abc/manifest.json',
      manifestSha256: digest,
      buildId: V86_IMAGE_BUILD_ID,
      memoryBytes: 128 * 1024 * 1024,
    }, 'https://guide.example/lab/')).toMatchObject({
      available: true,
      manifestUrl: 'https://assets.example/v86/sha256/abc/manifest.json',
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
    [{ schemaVersion: 1, nativeV86: true, manifestSha256: 'bad', buildId: V86_IMAGE_BUILD_ID, memoryBytes: 1 }, 'invalid manifest digest'],
    [{ schemaVersion: 1, nativeV86: true, manifestSha256: digest, buildId: '', memoryBytes: 1 }, 'invalid build id'],
    [{ schemaVersion: 1, nativeV86: true, manifestSha256: digest, buildId: 'old-build', memoryBytes: 1 }, 'incompatible build'],
    [{ schemaVersion: 1, nativeV86: true, manifestSha256: digest, buildId: V86_IMAGE_BUILD_ID, memoryBytes: 0 }, 'invalid memory size'],
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
      buildId: V86_IMAGE_BUILD_ID,
      memoryBytes: 64 * 1024 * 1024,
    }));
    await expect(loadNativeRuntimeAvailability('https://guide.example/lab', fetchImplementation)).resolves.toMatchObject({
      available: true,
      buildId: V86_IMAGE_BUILD_ID,
    });
    expect(fetchImplementation).toHaveBeenCalledWith(
      'https://guide.example/lab/runtime/status.json',
      { cache: 'no-store' },
    );
  });

  it('follows one external release-status pointer and resolves its manifest URL', async () => {
    const releaseStatusUrl = 'https://assets.example/v86/channels/stable/status.json';
    const fetchImplementation = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === 'https://guide.example/lab/runtime/status.json') {
        return Response.json({ schemaVersion: 1, nativeV86: true, releaseStatusUrl });
      }
      if (String(url) === releaseStatusUrl) {
        return Response.json({
          schemaVersion: 1,
          nativeV86: true,
          manifestUrl: 'https://assets.example/v86/objects/sha256/abc/manifest.json',
          manifestSha256: digest,
          buildId: V86_IMAGE_BUILD_ID,
          memoryBytes: 128 * 1024 * 1024,
        });
      }
      return new Response('', { status: 404 });
    });

    await expect(loadNativeRuntimeAvailability('https://guide.example/lab/', fetchImplementation)).resolves.toEqual({
      available: true,
      manifestUrl: 'https://assets.example/v86/objects/sha256/abc/manifest.json',
      manifestSha256: digest,
      buildId: V86_IMAGE_BUILD_ID,
      memoryBytes: 128 * 1024 * 1024,
    });
    expect(fetchImplementation).toHaveBeenNthCalledWith(1, 'https://guide.example/lab/runtime/status.json', { cache: 'no-store' });
    expect(fetchImplementation).toHaveBeenNthCalledWith(2, releaseStatusUrl, { cache: 'no-store' });
  });

  it('rejects insecure or recursively redirected external status metadata', async () => {
    const insecureFetch = vi.fn(async () => Response.json({
      schemaVersion: 1,
      nativeV86: true,
      releaseStatusUrl: 'http://assets.example/status.json',
    }));
    await expect(loadNativeRuntimeAvailability('https://guide.example/lab/', insecureFetch)).resolves.toMatchObject({
      available: false,
      reason: expect.stringContaining('must use HTTPS'),
    });

    const recursiveFetch = vi.fn()
      .mockResolvedValueOnce(Response.json({
        schemaVersion: 1,
        nativeV86: true,
        releaseStatusUrl: 'https://assets.example/stable/status.json',
      }))
      .mockResolvedValueOnce(Response.json({
        schemaVersion: 1,
        nativeV86: true,
        releaseStatusUrl: 'https://assets.example/other/status.json',
      }));
    await expect(loadNativeRuntimeAvailability('https://guide.example/lab/', recursiveFetch)).resolves.toEqual({
      available: false,
      reason: 'External native runtime status cannot redirect to another status document',
    });
  });
});

describe('native memory estimate', () => {
  it('reports one VM allocation shared by all namespace-isolated nodes', () => {
    expect(nativeMemoryEstimate(6, 128 * 1024 * 1024)).toBe('128 MiB shared by 6 nodes');
    expect(nativeMemoryEstimate(1, 128 * 1024 * 1024)).toBe('128 MiB shared by 1 node');
  });
});
