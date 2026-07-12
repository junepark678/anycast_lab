import { describe, expect, it } from 'vitest';
import {
  APPLIANCE_HOST_ABI_VERSION,
  type ApplianceBootRequest,
  type ApplianceFrame,
  type ApplianceHostV1,
  type ApplianceObservedEvent,
} from '../abi';
import type { V86Emulator, V86EmulatorFactory, V86EmulatorOptions } from './emulator';
import { addLabVlanTag } from './ethernet';
import {
  PINNED_BIRD_VERSION,
  PINNED_FRR_VERSION,
  V86_IMAGE_BUILD_ID,
  type VerifiedV86ArtifactBundle,
  type V86ArtifactManifest,
} from './manifest';
import { createSharedV86RuntimeFactories } from './shared-runtime';
import { encodeSharedBytes, encodeSharedText } from './shared-protocol';
import { readUstarArchive } from './tar';

describe('shared v86 runtime', () => {
  it('boots one emulator for multiple isolated appliance facades and demultiplexes their VLANs', async () => {
    const fake = new SharedFakeV86();
    const birdEvents: ApplianceObservedEvent[] = [];
    const frrEvents: ApplianceObservedEvent[] = [];
    const birdFrames: ApplianceFrame[] = [];
    const frrFrames: ApplianceFrame[] = [];
    const factories = createSharedV86RuntimeFactories({
      artifactSource: { manifestUrl: '/manifest.json', manifestSha256: 'a'.repeat(64) },
      loadArtifacts: async () => artifactBundle(),
      emulatorFactory: fake.factory,
      createObjectUrl: () => 'blob:shared-v86',
      revokeObjectUrl: () => undefined,
      bootTimeoutMs: 500,
      controlTimeoutMs: 500,
    });
    const bird = factories[0].create();
    const frr = factories[1].create();
    await bird.initialize(bootRequest('bird-node', '/usr/sbin/bird'), host(birdEvents, birdFrames));
    await frr.initialize(bootRequest('frr-node', '/run/anycastlab/frr-entrypoint.sh'), host(frrEvents, frrFrames));
    expect(fake.factoryCalls).toBe(1);
    expect(fake.options?.cmdline.split(/\s+/)).toEqual(expect.arrayContaining([
      'dummy.numdummies=0',
      'ifb.numifbs=0',
    ]));
    expect(fake.listeners.get('virtio-console0-output-bytes')?.size).toBe(1);

    const birdStart = bird.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.runCalls).toBe(1);
    expect(fake.controlEmits).toBeGreaterThan(0);
    await birdStart;
    await frr.start();
    expect(fake.runCalls).toBe(1);
    const bootstrap = fake.files.get('/anycastlab-shared-bootstrap.tar')!;
    const entries = readUstarArchive(bootstrap);
    expect(new TextDecoder().decode(
      entries.find((file) => file.path === '/run/anycastlab/bootstrap/node-count')!.contents,
    )).toBe('2\n');

    const packet = new Uint8Array(18).fill(7);
    fake.emit('net0-send', addLabVlanTag(packet, 101));
    expect(birdFrames).toHaveLength(0);
    expect(frrFrames).toEqual([{ interfaceId: 'eth0-id', bytes: packet }]);
    await bird.deliverFrame({ interfaceId: 'eth0-id', bytes: packet });
    expect(fake.receivedFrames.at(-1)).toEqual(addLabVlanTag(packet, 100));
    fake.emit('net0-send', addLabVlanTag(packet, 999));
    expect(birdFrames).toHaveLength(0);
    expect(frrFrames).toHaveLength(1);

    const session = await frr.openTerminal({ terminal: 'serial', columns: 100, rows: 30 });
    await frr.writeTerminal(session, new TextEncoder().encode('vtysh\n'));
    fake.emitControl(`ANYCASTLAB/2 TERM_DATA 2 1 ${encodeSharedBytes(new TextEncoder().encode('frr# '))}`);
    expect(frrEvents.some((event) => (
      event.type === 'terminal-output' && event.sessionId === session && new TextDecoder().decode(event.data) === 'frr# '
    ))).toBe(true);

    await bird.stop();
    expect(fake.stopCalls).toBe(0);
    fake.emit('net0-send', addLabVlanTag(packet, 100));
    expect(birdFrames).toHaveLength(0);
    await frr.stop();
    expect(fake.stopCalls).toBe(1);
    await bird.dispose();
    expect(fake.destroyCalls).toBe(0);
    await frr.dispose();
    expect(fake.destroyCalls).toBe(1);
  });

  it('routes a node exit only to the owning facade', async () => {
    const fake = new SharedFakeV86();
    const factories = createSharedV86RuntimeFactories({
      artifactSource: { manifestUrl: '/manifest.json', manifestSha256: 'a'.repeat(64) },
      loadArtifacts: async () => artifactBundle(),
      emulatorFactory: fake.factory,
      createObjectUrl: () => 'blob:shared-v86',
      revokeObjectUrl: () => undefined,
      bootTimeoutMs: 500,
      controlTimeoutMs: 500,
    });
    const bird = factories[0].create();
    const frr = factories[1].create();
    await bird.initialize(bootRequest('bird-node', '/usr/sbin/bird'), host([], []));
    await frr.initialize(bootRequest('frr-node', '/run/frr'), host([], []));
    await bird.start();
    await frr.start();
    fake.emitControl(`ANYCASTLAB/2 NODE_EXIT 1 ${encodeSharedText('bird exited')}`);
    expect(bird.state).toBe('failed');
    expect(frr.state).toBe('running');
    await bird.dispose();
    await frr.dispose();
  });

  it('uses the boot timeout for slow namespace startup while keeping ordinary controls short', async () => {
    const fake = new SharedFakeV86();
    fake.nodeStartDelayMs = 15;
    fake.nodeReadyDelayMs = 15;
    const factories = createSharedV86RuntimeFactories({
      artifactSource: { manifestUrl: '/manifest.json', manifestSha256: 'a'.repeat(64) },
      loadArtifacts: async () => artifactBundle(),
      emulatorFactory: fake.factory,
      createObjectUrl: () => 'blob:shared-v86',
      revokeObjectUrl: () => undefined,
      bootTimeoutMs: 100,
      controlTimeoutMs: 1,
    });
    const bird = factories[0].create();
    await bird.initialize(bootRequest('bird-node', '/usr/sbin/bird'), host([], []));
    await expect(bird.start()).resolves.toBeUndefined();
    await bird.stop();
    await bird.dispose();
  });

  it('does not report a node running until the guest emits daemon readiness', async () => {
    const fake = new SharedFakeV86();
    fake.nodeReadyDelayMs = 20;
    const factories = createSharedV86RuntimeFactories({
      artifactSource: { manifestUrl: '/manifest.json', manifestSha256: 'a'.repeat(64) },
      loadArtifacts: async () => artifactBundle(),
      emulatorFactory: fake.factory,
      createObjectUrl: () => 'blob:shared-v86',
      revokeObjectUrl: () => undefined,
      bootTimeoutMs: 100,
      controlTimeoutMs: 100,
    });
    const bird = factories[0].create();
    await bird.initialize(bootRequest('bird-node', '/usr/sbin/bird'), host([], []));
    const starting = bird.start();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(bird.state).toBe('initialized');
    await starting;
    expect(bird.state).toBe('running');
    await bird.dispose();
  });

  it('rejects startup when a node exits synchronously immediately after readiness', async () => {
    const fake = new SharedFakeV86();
    const events: ApplianceObservedEvent[] = [];
    fake.nodeExitAfterReadyOnStart = 'bird exited immediately after becoming ready';
    const factories = createSharedV86RuntimeFactories({
      artifactSource: { manifestUrl: '/manifest.json', manifestSha256: 'a'.repeat(64) },
      loadArtifacts: async () => artifactBundle(),
      emulatorFactory: fake.factory,
      createObjectUrl: () => 'blob:shared-v86',
      revokeObjectUrl: () => undefined,
      bootTimeoutMs: 100,
      controlTimeoutMs: 100,
    });
    const bird = factories[0].create();
    await bird.initialize(bootRequest('bird-node', '/usr/sbin/bird'), host(events, []));

    await expect(bird.start()).rejects.toThrow('bird exited immediately after becoming ready');
    expect(bird.state).toBe('failed');
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'lifecycle', state: 'running' }));
    expect(fake.commands.map(({ command }) => command)).toEqual(['NODE_START', 'NODE_STOP']);
    await bird.dispose();
  });

  it('rejects startup when a node exits during interface reconciliation', async () => {
    const fake = new SharedFakeV86();
    const events: ApplianceObservedEvent[] = [];
    fake.nodeExitAfterLink = 'bird exited while its link state was reconciled';
    const factories = createSharedV86RuntimeFactories({
      artifactSource: { manifestUrl: '/manifest.json', manifestSha256: 'a'.repeat(64) },
      loadArtifacts: async () => artifactBundle(),
      emulatorFactory: fake.factory,
      createObjectUrl: () => 'blob:shared-v86',
      revokeObjectUrl: () => undefined,
      bootTimeoutMs: 100,
      controlTimeoutMs: 100,
    });
    const bird = factories[0].create();
    await bird.initialize(bootRequest('bird-node', '/usr/sbin/bird'), host(events, []));

    await expect(bird.start()).rejects.toThrow('bird exited while its link state was reconciled');
    expect(bird.state).toBe('failed');
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'lifecycle', state: 'running' }));
    expect(fake.commands.map(({ command }) => command)).toEqual(['NODE_START', 'LINK', 'NODE_STOP']);
    await bird.dispose();
  });

  it('fails immediately with NODE_EXIT even when NODE_START never receives a response', async () => {
    const fake = new SharedFakeV86();
    fake.nodeExitOnStart = 'bird failed its readiness probe';
    const factories = createSharedV86RuntimeFactories({
      artifactSource: { manifestUrl: '/manifest.json', manifestSha256: 'a'.repeat(64) },
      loadArtifacts: async () => artifactBundle(),
      emulatorFactory: fake.factory,
      createObjectUrl: () => 'blob:shared-v86',
      revokeObjectUrl: () => undefined,
      bootTimeoutMs: 250,
      controlTimeoutMs: 250,
    });
    const bird = factories[0].create();
    await bird.initialize(bootRequest('bird-node', '/usr/sbin/bird'), host([], []));

    await expect(bird.start()).rejects.toThrow('bird failed its readiness probe');
    expect(bird.state).toBe('failed');
    expect(fake.commands.map(({ command }) => command)).toEqual(['NODE_START', 'NODE_STOP']);
    await bird.dispose();
  });

  it('rejects startup when malformed guest output fails the shared machine', async () => {
    const fake = new SharedFakeV86();
    fake.suppressNodeReady = true;
    const factories = createSharedV86RuntimeFactories({
      artifactSource: { manifestUrl: '/manifest.json', manifestSha256: 'a'.repeat(64) },
      loadArtifacts: async () => artifactBundle(),
      emulatorFactory: fake.factory,
      createObjectUrl: () => 'blob:shared-v86',
      revokeObjectUrl: () => undefined,
      bootTimeoutMs: 250,
      controlTimeoutMs: 250,
    });
    const bird = factories[0].create();
    await bird.initialize(bootRequest('bird-node', '/usr/sbin/bird'), host([], []));
    const starting = bird.start();
    while (!fake.commands.some(({ command }) => command === 'NODE_START')) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    fake.emitControl('ANYCASTLAB/2 NOT_A_MESSAGE');

    await expect(starting).rejects.toThrow(/Unknown shared guest message/);
    expect(bird.state).toBe('failed');
    await bird.dispose();
  });

  it('will not send NODE_START after the shared machine has already failed', async () => {
    const fake = new SharedFakeV86();
    const events: ApplianceObservedEvent[] = [];
    const factories = createSharedV86RuntimeFactories({
      artifactSource: { manifestUrl: '/manifest.json', manifestSha256: 'a'.repeat(64) },
      loadArtifacts: async () => artifactBundle(),
      emulatorFactory: fake.factory,
      createObjectUrl: () => 'blob:shared-v86',
      revokeObjectUrl: () => undefined,
      bootTimeoutMs: 100,
      controlTimeoutMs: 100,
    });
    const bird = factories[0].create();
    await bird.initialize(bootRequest('bird-node', '/usr/sbin/bird'), host(events, []));
    fake.emitControl('ANYCASTLAB/2 NOT_A_MESSAGE');

    await expect(bird.start()).rejects.toThrow(/state failed/);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'lifecycle', state: 'failed', detail: expect.stringContaining('Unknown shared guest message'),
    }));
    expect(fake.commands).toHaveLength(0);
    await bird.dispose();
  });

  it('serializes guest controls and applies stopped-node file changes after restart', async () => {
    const fake = new SharedFakeV86();
    const factories = createSharedV86RuntimeFactories({
      artifactSource: { manifestUrl: '/manifest.json', manifestSha256: 'a'.repeat(64) },
      loadArtifacts: async () => artifactBundle(),
      emulatorFactory: fake.factory,
      createObjectUrl: () => 'blob:shared-v86',
      revokeObjectUrl: () => undefined,
      bootTimeoutMs: 250,
      controlTimeoutMs: 250,
    });
    const bird = factories[0].create();
    await bird.initialize(bootRequest('bird-node', '/usr/sbin/bird'), host([], []));
    await bird.start();
    fake.commands.length = 0;
    fake.responseDelayMs.set('LINK', 20);

    const link = bird.setInterfaceState('eth0-id', false);
    const file = bird.writeFile({
      path: '/etc/bird.conf', contents: new TextEncoder().encode('router id 192.0.2.9;\n'), mode: 0o640,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(fake.commands.map(({ command }) => command)).toEqual(['LINK']);
    await Promise.all([link, file]);
    expect(fake.commands.map(({ command }) => command)).toEqual(['LINK', 'APPLY']);

    await bird.stop();
    fake.commands.length = 0;
    await bird.writeFile({
      path: '/etc/bird.conf', contents: new TextEncoder().encode('router id 192.0.2.10;\n'), mode: 0o640,
    });
    expect(fake.commands).toHaveLength(0);
    await bird.start();
    expect(fake.commands.map(({ command }) => command)).toEqual(['APPLY', 'NODE_START', 'LINK']);
    const staged = readUstarArchive(fake.files.get('/anycastlab-node-1-in.tar')!);
    expect(staged).toHaveLength(1);
    expect(staged[0]?.path).toBe('/etc/bird.conf');
    expect(new TextDecoder().decode(staged[0]?.contents)).toBe('router id 192.0.2.10;\n');
    await bird.dispose();
  });

  it('reconciles stopped interface state after readiness and before reporting the node running', async () => {
    const fake = new SharedFakeV86();
    const events: ApplianceObservedEvent[] = [];
    const factories = createSharedV86RuntimeFactories({
      artifactSource: { manifestUrl: '/manifest.json', manifestSha256: 'a'.repeat(64) },
      loadArtifacts: async () => artifactBundle(),
      emulatorFactory: fake.factory,
      createObjectUrl: () => 'blob:shared-v86',
      revokeObjectUrl: () => undefined,
      bootTimeoutMs: 250,
      controlTimeoutMs: 250,
    });
    const bird = factories[0].create();
    await bird.initialize(bootRequest('bird-node', '/usr/sbin/bird'), host(events, []));
    await bird.start();
    await bird.stop();
    fake.commands.length = 0;

    await bird.setInterfaceState('eth0-id', false);
    expect(fake.commands).toHaveLength(0);
    fake.responseDelayMs.set('LINK', 20);
    const runningEventsBeforeRestart = events.filter((event) => (
      event.type === 'lifecycle' && event.state === 'running'
    )).length;
    const restarting = bird.start();
    while (!fake.commands.some(({ command }) => command === 'LINK')) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(fake.commands.map(({ command }) => command)).toEqual(['NODE_START', 'LINK']);
    expect(fake.commands.at(-1)).toEqual({
      command: 'LINK',
      request: expect.any(String),
      slot: '1',
      arguments: [encodeSharedText('eth0'), 'down'],
    });
    expect(bird.state).toBe('stopped');
    expect(events.filter((event) => event.type === 'lifecycle' && event.state === 'running')).toHaveLength(
      runningEventsBeforeRestart,
    );

    await restarting;
    expect(bird.state).toBe('running');
    expect(events.filter((event) => event.type === 'lifecycle' && event.state === 'running')).toHaveLength(
      runningEventsBeforeRestart + 1,
    );
    await bird.dispose();
  });

  it('forces final cleanup and revokes the WASM URL after guest stop and emulator destroy fail', async () => {
    const fake = new SharedFakeV86();
    const events: ApplianceObservedEvent[] = [];
    const revoked: string[] = [];
    fake.suppressResponses.add('NODE_STOP');
    fake.destroyError = new Error('synthetic destroy failure');
    const factories = createSharedV86RuntimeFactories({
      artifactSource: { manifestUrl: '/manifest.json', manifestSha256: 'a'.repeat(64) },
      loadArtifacts: async () => artifactBundle(),
      emulatorFactory: fake.factory,
      createObjectUrl: () => 'blob:shared-v86',
      revokeObjectUrl: (url) => revoked.push(url),
      bootTimeoutMs: 100,
      controlTimeoutMs: 10,
    });
    const bird = factories[0].create();
    await bird.initialize(bootRequest('bird-node', '/usr/sbin/bird'), host(events, []));
    await bird.start();

    await expect(bird.dispose()).resolves.toBeUndefined();
    expect(bird.state).toBe('disposed');
    expect(fake.destroyCalls).toBe(1);
    expect(revoked).toEqual(['blob:shared-v86']);
    expect([...fake.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'log', level: 'warning', message: expect.stringContaining('forced disposal'),
    }));
  });

  it('destroys a partially initialized emulator and revokes its object URL after readiness timeout', async () => {
    const fake = new SharedFakeV86();
    const revoked: string[] = [];
    fake.emitEmulatorReady = false;
    const factories = createSharedV86RuntimeFactories({
      artifactSource: { manifestUrl: '/manifest.json', manifestSha256: 'a'.repeat(64) },
      loadArtifacts: async () => artifactBundle(),
      emulatorFactory: fake.factory,
      createObjectUrl: () => 'blob:partial-v86',
      revokeObjectUrl: (url) => revoked.push(url),
      bootTimeoutMs: 10,
      controlTimeoutMs: 10,
    });
    const bird = factories[0].create();
    await expect(
      bird.initialize(bootRequest('bird-node', '/usr/sbin/bird'), host([], [])),
    ).rejects.toThrow(/emulator did not become ready/);

    await bird.dispose();
    expect(fake.destroyCalls).toBe(1);
    expect(revoked).toEqual(['blob:partial-v86']);
    expect([...fake.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
  });

  it('allocates a clean machine and retries artifact loading after initialization fails', async () => {
    const fake = new SharedFakeV86();
    let attempts = 0;
    const factories = createSharedV86RuntimeFactories({
      artifactSource: { manifestUrl: '/manifest.json', manifestSha256: 'a'.repeat(64) },
      loadArtifacts: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('transient artifact failure');
        return artifactBundle();
      },
      emulatorFactory: fake.factory,
      createObjectUrl: () => 'blob:shared-v86',
      revokeObjectUrl: () => undefined,
      bootTimeoutMs: 100,
      controlTimeoutMs: 100,
    });
    const failed = factories[0].create();
    await expect(
      failed.initialize(bootRequest('bird-one', '/usr/sbin/bird'), host([], [])),
    ).rejects.toThrow('transient artifact failure');
    await failed.dispose();

    const retry = factories[0].create();
    await retry.initialize(bootRequest('bird-two', '/usr/sbin/bird'), host([], []));
    await retry.start();
    expect(attempts).toBe(2);
    expect(fake.factoryCalls).toBe(1);
    await retry.dispose();
  });

  it('fails every registered facade when the bootstrap archive cannot be installed', async () => {
    const fake = new SharedFakeV86();
    const revoked: string[] = [];
    fake.createFileErrors.set(
      '/anycastlab-shared-bootstrap.tar',
      new Error('synthetic bootstrap write failure'),
    );
    const factories = createSharedV86RuntimeFactories({
      artifactSource: { manifestUrl: '/manifest.json', manifestSha256: 'a'.repeat(64) },
      loadArtifacts: async () => artifactBundle(),
      emulatorFactory: fake.factory,
      createObjectUrl: () => 'blob:shared-v86',
      revokeObjectUrl: (url) => revoked.push(url),
      bootTimeoutMs: 100,
      controlTimeoutMs: 100,
    });
    const bird = factories[0].create();
    const frr = factories[1].create();
    await bird.initialize(bootRequest('bird-node', '/usr/sbin/bird'), host([], []));
    await frr.initialize(bootRequest('frr-node', '/run/frr'), host([], []));

    await expect(bird.start()).rejects.toThrow('synthetic bootstrap write failure');
    expect(bird.state).toBe('failed');
    expect(frr.state).toBe('failed');
    expect(fake.runCalls).toBe(0);
    expect(fake.files.has('/anycastlab-shared-bootstrap.tar')).toBe(false);
    await bird.dispose();
    await frr.dispose();
    expect(fake.destroyCalls).toBe(1);
    expect(revoked).toEqual(['blob:shared-v86']);
  });

  it('allocates a fresh shared machine when the same registry factories are reused', async () => {
    const fake = new SharedFakeV86();
    const factories = createSharedV86RuntimeFactories({
      artifactSource: { manifestUrl: '/manifest.json', manifestSha256: 'a'.repeat(64) },
      loadArtifacts: async () => artifactBundle(),
      emulatorFactory: fake.factory,
      createObjectUrl: () => 'blob:shared-v86',
      revokeObjectUrl: () => undefined,
      bootTimeoutMs: 500,
      controlTimeoutMs: 500,
    });

    const first = factories[0].create();
    await first.initialize(bootRequest('bird-one', '/usr/sbin/bird'), host([], []));
    await first.start();
    await first.dispose();
    const second = factories[0].create();
    await second.initialize(bootRequest('bird-two', '/usr/sbin/bird'), host([], []));
    await second.start();
    await second.dispose();

    expect(fake.factoryCalls).toBe(2);
    expect(fake.destroyCalls).toBe(2);
  });

  it('fails before emulator construction when an injected bundle has an incompatible machine model', async () => {
    const fake = new SharedFakeV86();
    const bundle = artifactBundle();
    const incompatible = {
      ...bundle,
      manifest: {
        ...bundle.manifest,
        machine: { ...bundle.manifest.machine, model: 'per-node-vm' },
      },
    } as unknown as VerifiedV86ArtifactBundle;
    const factories = createSharedV86RuntimeFactories({
      artifactSource: { manifestUrl: '/manifest.json', manifestSha256: 'a'.repeat(64) },
      loadArtifacts: async () => incompatible,
      emulatorFactory: fake.factory,
    });
    const bird = factories[0].create();
    await expect(
      bird.initialize(bootRequest('bird-node', '/usr/sbin/bird'), host([], [])),
    ).rejects.toThrow(/not a shared-namespaces image/);
    expect(bird.state).toBe('failed');
    expect(fake.factoryCalls).toBe(0);
    await bird.dispose();
  });

  it('does not trust an injected loader that returns a different manifest identity', async () => {
    const fake = new SharedFakeV86();
    const bundle = artifactBundle();
    const factories = createSharedV86RuntimeFactories({
      artifactSource: { manifestUrl: '/manifest.json', manifestSha256: 'a'.repeat(64) },
      loadArtifacts: async () => ({ ...bundle, manifestSha256: 'b'.repeat(64) }),
      emulatorFactory: fake.factory,
    });
    const bird = factories[0].create();
    await expect(
      bird.initialize(bootRequest('bird-node', '/usr/sbin/bird'), host([], [])),
    ).rejects.toThrow(/wrong trusted digest/);
    expect(fake.factoryCalls).toBe(0);
    await bird.dispose();
  });
});

class SharedFakeV86 implements V86Emulator {
  readonly listeners = new Map<string, Set<(value: unknown) => void>>();
  readonly files = new Map<string, Uint8Array>();
  readonly receivedFrames: Uint8Array[] = [];
  readonly commands: { command: string; request: string; slot: string; arguments: string[] }[] = [];
  readonly responseDelayMs = new Map<string, number>();
  readonly suppressResponses = new Set<string>();
  readonly createFileErrors = new Map<string, Error>();
  options: V86EmulatorOptions | null = null;
  factoryCalls = 0;
  runCalls = 0;
  stopCalls = 0;
  destroyCalls = 0;
  controlEmits = 0;
  nodeStartDelayMs = 0;
  nodeReadyDelayMs = 0;
  nodeExitOnStart: string | null = null;
  nodeExitAfterReadyOnStart: string | null = null;
  nodeExitAfterLink: string | null = null;
  suppressNodeReady = false;
  emitEmulatorReady = true;
  destroyError: Error | null = null;
  running = false;

  readonly bus = {
    send: (event: string, value?: unknown): void => {
      if (event === 'net0-receive' && isUint8Array(value)) this.receivedFrames.push(value.slice());
      if (event !== 'virtio-console0-input-bytes' || !isUint8Array(value)) return;
      const tokens = new TextDecoder().decode(value).trim().split(' ');
      const command = tokens[1]!;
      const request = tokens[2]!;
      const slot = tokens[3]!;
      this.commands.push({ command, request, slot, arguments: tokens.slice(4) });
      if (command === 'NODE_START' && this.nodeExitOnStart !== null) {
        this.emitControl(`ANYCASTLAB/2 NODE_EXIT ${slot} ${encodeSharedText(this.nodeExitOnStart)}`);
        return;
      }
      if (this.suppressResponses.has(command)) return;
      const respond = () => {
        if (command === 'TERM_OPEN') this.emitControl(`ANYCASTLAB/2 OK ${request} 1`);
        else this.emitControl(`ANYCASTLAB/2 OK ${request}`);
        if (command === 'LINK' && this.nodeExitAfterLink !== null) {
          this.emitControl(`ANYCASTLAB/2 NODE_EXIT ${slot} ${encodeSharedText(this.nodeExitAfterLink)}`);
        }
        if (command === 'NODE_START' && !this.suppressNodeReady) {
          const ready = () => {
            this.emitControl(`ANYCASTLAB/2 NODE_READY ${slot}`);
            if (this.nodeExitAfterReadyOnStart !== null) {
              this.emitControl(
                `ANYCASTLAB/2 NODE_EXIT ${slot} ${encodeSharedText(this.nodeExitAfterReadyOnStart)}`,
              );
            }
          };
          if (this.nodeReadyDelayMs > 0) setTimeout(ready, this.nodeReadyDelayMs);
          else ready();
        }
      };
      const delay = this.responseDelayMs.get(command) ??
        (command === 'NODE_START' ? this.nodeStartDelayMs : 0);
      if (delay > 0) setTimeout(respond, delay);
      else respond();
    },
  };

  readonly factory: V86EmulatorFactory = (options) => {
    this.factoryCalls += 1;
    this.options = options;
    if (this.emitEmulatorReady) queueMicrotask(() => this.emit('emulator-ready', undefined));
    return this;
  };

  add_listener(event: string, listener: (value: unknown) => void): void {
    const values = this.listeners.get(event) ?? new Set();
    values.add(listener);
    this.listeners.set(event, values);
  }
  remove_listener(event: string, listener: (value: unknown) => void): void {
    this.listeners.get(event)?.delete(listener);
  }
  emit(event: string, value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }
  emitControl(line: string): void {
    this.controlEmits += 1;
    this.emit('virtio-console0-output-bytes', new TextEncoder().encode(`${line}\n`));
  }
  async run(): Promise<void> {
    if (!this.running) this.runCalls += 1;
    this.running = true;
    this.emitControl('ANYCASTLAB/2 READY');
  }
  async stop(): Promise<void> { this.stopCalls += 1; this.running = false; }
  async destroy(): Promise<void> {
    this.destroyCalls += 1;
    this.running = false;
    if (this.destroyError !== null) throw this.destroyError;
  }
  is_running(): boolean { return this.running; }
  async save_state(): Promise<ArrayBuffer> { return new ArrayBuffer(0); }
  async restore_state(_state: ArrayBuffer): Promise<void> {}
  async create_file(path: string, contents: Uint8Array): Promise<void> {
    const failure = this.createFileErrors.get(path);
    if (failure !== undefined) throw failure;
    this.files.set(path, contents.slice());
  }
  async read_file(path: string): Promise<Uint8Array> { return this.files.get(path)?.slice() ?? new Uint8Array(); }
  serial_send_bytes(_serial: number, _contents: Uint8Array): void {}
}

function isUint8Array(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Uint8Array]';
}

function host(events: ApplianceObservedEvent[], frames: ApplianceFrame[]): ApplianceHostV1 {
  return {
    abiVersion: APPLIANCE_HOST_ABI_VERSION,
    nowNs: () => 0n,
    fillRandom: (target) => target.fill(1),
    transmitFrame: (frame) => frames.push({ ...frame, bytes: frame.bytes.slice() }),
    emitEvent: (event) => events.push(event),
  };
}

function bootRequest(nodeId: string, entrypoint: string): ApplianceBootRequest {
  return {
    nodeId,
    hostname: nodeId,
    entrypoint,
    argv: [],
    environment: {},
    randomSeed: 'test-seed',
    files: [{ path: '/etc/node.conf', contents: new Uint8Array([1]), mode: 0o640 }],
    interfaces: [{
      id: 'eth0-id', name: 'eth0', mac: `02:00:00:00:00:${nodeId.startsWith('bird') ? '01' : '02'}`,
      mtu: 1500, up: true, addresses: [],
    }],
  };
}

function artifactBundle(): VerifiedV86ArtifactBundle {
  const manifest = {
    buildId: V86_IMAGE_BUILD_ID,
    daemons: { bird: PINNED_BIRD_VERSION, frr: PINNED_FRR_VERSION },
    machine: {
      model: 'shared-namespaces',
      memoryBytes: 128 * 1024 * 1024,
      vgaMemoryBytes: 2 * 1024 * 1024,
      trunkMtu: 65_535,
    },
    pgo: { mode: 'use' },
  } as unknown as V86ArtifactManifest;
  return {
    manifest,
    manifestSha256: 'a'.repeat(64),
    artifacts: {
      'v86-wasm': new Uint8Array([0]), bios: new Uint8Array([1]),
      'vga-bios': new Uint8Array([2]), bzimage: new Uint8Array([3]),
    },
    filesystems: {
      complete: { size: 1, sha256: '4'.repeat(64), blob: new Blob([new Uint8Array([4])]), cacheHit: true },
    },
  };
}
