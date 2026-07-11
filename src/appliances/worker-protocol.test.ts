import { describe, expect, it } from 'vitest';
import { APPLIANCE_HOST_ABI_VERSION, type ApplianceBootRequest } from './abi';
import { birdCompatibilityRuntimeFactory } from './mock/compatibility-runtime';
import { ApplianceRuntimeRegistry } from './registry';
import {
  APPLIANCE_WORKER_PROTOCOL_VERSION,
  assertApplianceWorkerRequest,
  isApplianceWorkerRequest,
  type ApplianceWorkerMessage,
  workerFailure,
  workerSuccess,
  workerTransferables,
} from './worker-protocol';
import { ApplianceWorkerServer } from './worker-server';

const boot: ApplianceBootRequest = {
  nodeId: 'router-1',
  hostname: 'router-1',
  entrypoint: '/usr/sbin/bird',
  argv: ['-c', '/etc/bird/bird.conf'],
  environment: {},
  files: [
    {
      path: '/etc/bird/bird.conf',
      contents: new TextEncoder().encode('router id 192.0.2.1;'),
    },
  ],
  interfaces: [],
  randomSeed: 'test-seed',
};

describe('appliance worker protocol', () => {
  it('accepts only versioned request envelopes', () => {
    const request = {
      protocolVersion: APPLIANCE_WORKER_PROTOCOL_VERSION,
      requestId: 'request-1',
      type: 'hello',
    } as const;

    expect(isApplianceWorkerRequest(request)).toBe(true);
    expect(isApplianceWorkerRequest({ ...request, protocolVersion: 2 })).toBe(false);
    expect(isApplianceWorkerRequest({ ...request, requestId: '' })).toBe(false);
    expect(isApplianceWorkerRequest({ ...request, type: 'unknown' })).toBe(false);
    expect(
      isApplianceWorkerRequest({ ...request, type: 'initialize', runtimeId: 'bird' }),
    ).toBe(false);
    expect(() => assertApplianceWorkerRequest(null)).toThrow('Invalid appliance worker request');
  });

  it('normalizes successful and failed responses', () => {
    expect(workerSuccess('42', { type: 'ack' })).toEqual({
      protocolVersion: APPLIANCE_WORKER_PROTOCOL_VERSION,
      type: 'response',
      requestId: '42',
      ok: true,
      result: { type: 'ack' },
    });

    const failure = workerFailure('43', new TypeError('bad request'));
    expect(failure).toMatchObject({
      protocolVersion: APPLIANCE_WORKER_PROTOCOL_VERSION,
      requestId: '43',
      ok: false,
      error: { name: 'TypeError', message: 'bad request' },
    });
  });

  it('deduplicates transferable buffers in nested messages', () => {
    const buffer = new ArrayBuffer(8);
    const view = new Uint8Array(buffer);
    const message = {
      protocolVersion: APPLIANCE_WORKER_PROTOCOL_VERSION,
      requestId: 'write',
      type: 'write-file',
      file: { path: '/tmp/a', contents: view },
    } as const;

    expect(workerTransferables(message)).toEqual([buffer]);
  });

  it('handshakes and requires explicit compatibility opt-in', async () => {
    const registry = new ApplianceRuntimeRegistry();
    registry.register(birdCompatibilityRuntimeFactory);
    const posted: ApplianceWorkerMessage[] = [];
    const server = new ApplianceWorkerServer({
      registry,
      transport: { postMessage: (message) => posted.push(message) },
      clock: { nowNs: () => 123n },
      fillRandom: (target) => target.fill(7),
    });

    await server.receive({
      protocolVersion: APPLIANCE_WORKER_PROTOCOL_VERSION,
      requestId: 'hello-1',
      type: 'hello',
    });

    expect(posted[0]).toMatchObject({
      ok: true,
      result: {
        type: 'hello',
        hello: {
          hostAbiVersion: APPLIANCE_HOST_ABI_VERSION,
          runtimes: [{ fidelity: 'compatibility' }],
        },
      },
    });

    const deniedInitialization = {
      protocolVersion: APPLIANCE_WORKER_PROTOCOL_VERSION,
      requestId: 'init-denied',
      type: 'initialize',
      runtimeId: birdCompatibilityRuntimeFactory.descriptor.runtimeId,
      allowCompatibility: false,
      boot,
    } as const;
    expect(isApplianceWorkerRequest(deniedInitialization)).toBe(true);
    await server.receive(deniedInitialization);
    expect(posted.at(-1)).toMatchObject({ ok: false, error: { message: expect.stringContaining('No appliance runtime matches') } });

    await server.receive({
      protocolVersion: APPLIANCE_WORKER_PROTOCOL_VERSION,
      requestId: 'init-explicit',
      type: 'initialize',
      runtimeId: birdCompatibilityRuntimeFactory.descriptor.runtimeId,
      allowCompatibility: true,
      boot,
    });

    expect(posted.some((message) => message.type === 'event')).toBe(true);
    expect(posted.at(-1)).toMatchObject({
      ok: true,
      result: { type: 'initialized', descriptor: { fidelity: 'compatibility' } },
    });
  });
});
