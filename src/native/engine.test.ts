import { describe, expect, it } from 'vitest';
import {
  APPLIANCE_HOST_ABI_VERSION,
  APPLIANCE_RUNTIME_API_VERSION,
  type ApplianceBootRequest,
  type ApplianceBootResult,
  type ApplianceFile,
  type ApplianceFrame,
  type ApplianceHostV1,
  type ApplianceInspectionSnapshot,
  type ApplianceInterfaceSpec,
  type ApplianceKind,
  type ApplianceLifecycleState,
  type ApplianceRuntime,
  type ApplianceRuntimeDescriptor,
  type ApplianceStepRequest,
  type ApplianceStepResult,
  type ApplianceTerminalOpenRequest,
} from '../appliances/abi';
import { ApplianceRuntimeRegistry } from '../appliances/registry';
import { createEmptyProject, type LabLink, type LabNode, type LabProject } from '../core/types';
import { NativeLabEngine, NativeProjectIneligibleError } from './engine';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('NativeLabEngine lifecycle and appliance orchestration', () => {
  it('initializes exact native runtimes, steps them, pauses, resumes, stops, and disposes', async () => {
    const project = directProject();
    const harness = runtimeHarness();
    const engine = new NativeLabEngine(project, harness.registry, { autoRun: false });

    await engine.start();

    expect(engine.state).toBe('running');
    expect(harness.byNode.get('a')?.boot?.entrypoint).toBe('/usr/sbin/bird');
    expect(harness.byNode.get('b')?.boot?.entrypoint).toBe('/usr/sbin/bird');
    expect(harness.byNode.get('a')?.stepRequests).toEqual([{ nowNs: 0n, maxWorkItems: 1024 }]);
    expect(Object.keys(engine.runtimeDescriptors())).toEqual(['a', 'b']);

    await engine.pause();
    expect(engine.state).toBe('paused');
    expect(harness.byNode.get('a')?.state).toBe('stopped');

    await engine.resume();
    expect(engine.state).toBe('running');
    expect(harness.byNode.get('a')?.startCalls).toBe(2);

    await engine.stop('test complete');
    expect(engine.state).toBe('stopped');
    await engine.dispose();
    expect(engine.state).toBe('disposed');
    expect(harness.created.every((runtime) => runtime.state === 'disposed')).toBe(true);
  });

  it('refuses compatibility-marked projects before constructing any runtime', async () => {
    const project = directProject();
    project.nodes[0]!.appliance.runtime = 'compatibility';
    const harness = runtimeHarness();
    const engine = new NativeLabEngine(project, harness.registry, { autoRun: false });

    await expect(engine.start()).rejects.toBeInstanceOf(NativeProjectIneligibleError);
    expect(engine.state).toBe('failed');
    expect(harness.created).toHaveLength(0);
    await engine.dispose();
  });

  it('maps client and service primitives to a registered native client runtime', async () => {
    const client = clientNode('client');
    const service = serviceNode('service');
    const project = projectWith([client, service], [link('client-service', client, 0, service, 0, 0)]);
    const harness = runtimeHarness();
    const engine = new NativeLabEngine(project, harness.registry, { autoRun: false });

    await engine.start();

    expect(harness.byNode.get('client')?.descriptor.kind).toBe('client');
    expect(harness.byNode.get('service')?.descriptor.kind).toBe('client');
    expect(harness.byNode.get('service')?.boot?.interfaces[0]?.addresses).toContainEqual({
      family: 'ipv4',
      address: '203.0.113.53',
      prefixLength: 32,
    });
    await engine.dispose();
  });

  it('fails the lab and disposes every VM when one appliance exits after startup', async () => {
    const harness = runtimeHarness();
    const engine = new NativeLabEngine(directProject(), harness.registry, { autoRun: false });
    await engine.start();

    harness.byNode.get('a')!.fail('daemon exited');
    for (let index = 0; index < 20 && harness.created.some((runtime) => runtime.state !== 'disposed'); index += 1) {
      await Promise.resolve();
    }

    expect(engine.state).toBe('failed');
    expect(harness.created.every((runtime) => runtime.state === 'disposed')).toBe(true);
    await engine.dispose();
  });
});

describe('NativeLabEngine Ethernet fabric', () => {
  it('automatically wakes at the next frame deadline using the injected monotonic clock', async () => {
    const project = directProject({ latencyMs: 12 });
    const harness = runtimeHarness();
    let wallMs = 100;
    let scheduled: { callback: () => void; delayMs: number } | null = null;
    const engine = new NativeLabEngine(project, harness.registry, {
      autoRun: true,
      wallNowMs: () => wallMs,
      setTimer: (callback, delayMs) => {
        scheduled = { callback, delayMs };
        return 1;
      },
      clearTimer: () => {
        scheduled = null;
      },
    });
    await engine.start();

    harness.byNode.get('a')!.transmit(
      'uplink',
      ethernetFrame('ff:ff:ff:ff:ff:ff', '02:00:00:00:00:01', 0x0800),
    );
    expect(scheduled).toEqual(expect.objectContaining({ delayMs: 12 }));
    wallMs = 112;
    const wake = scheduled as { callback: () => void; delayMs: number } | null;
    wake?.callback();
    for (let index = 0; index < 20 && harness.byNode.get('b')!.deliveredFrames.length === 0; index += 1) {
      await Promise.resolve();
    }

    expect(engine.nowNs).toBe(12_000_000n);
    expect(harness.byNode.get('b')!.deliveredFrames).toHaveLength(1);
    await engine.dispose();
  });

  it('timestamps asynchronous VM frames from wall time and reschedules an earlier deadline', async () => {
    const a = birdNode('a');
    const b = birdNode('b');
    const c = birdNode('c', '02:00:00:00:00:03');
    const d = birdNode('d', '02:00:00:00:00:04');
    const project = projectWith(
      [a, b, c, d],
      [link('slow', a, 0, b, 0, 100), link('fast', c, 0, d, 0, 1)],
    );
    const harness = runtimeHarness();
    let wallMs = 0;
    let scheduled: { callback: () => void; delayMs: number; handle: number } | null = null;
    let nextHandle = 1;
    const cleared: number[] = [];
    const engine = new NativeLabEngine(project, harness.registry, {
      autoRun: true,
      wallNowMs: () => wallMs,
      setTimer: (callback, delayMs) => {
        const handle = nextHandle++;
        scheduled = { callback, delayMs, handle };
        return handle;
      },
      clearTimer: (handle) => {
        cleared.push(handle as number);
        if (scheduled?.handle === handle) scheduled = null;
      },
    });
    await engine.start();
    const frame = ethernetFrame('ff:ff:ff:ff:ff:ff', '02:00:00:00:00:01', 0x0800);

    harness.byNode.get('a')!.transmit('uplink', frame);
    expect(scheduled).toEqual(expect.objectContaining({ delayMs: 100, handle: 1 }));
    wallMs = 50;
    harness.byNode.get('c')!.transmit('uplink', frame);
    expect(cleared).toEqual([1]);
    expect(scheduled).toEqual(expect.objectContaining({ delayMs: 1, handle: 2 }));
    expect(engine.getCapture().frames.filter((entry) => entry.direction === 'egress').map((entry) => entry.atNs)).toEqual([
      0n,
      50_000_000n,
    ]);

    wallMs = 51;
    const wake = scheduled as { callback: () => void } | null;
    wake?.callback();
    for (let index = 0; index < 20 && harness.byNode.get('d')!.deliveredFrames.length === 0; index += 1) {
      await Promise.resolve();
    }
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
    expect(harness.byNode.get('d')!.deliveredFrames).toHaveLength(1);
    expect(harness.byNode.get('b')!.deliveredFrames).toHaveLength(0);
    expect(scheduled).toEqual(expect.objectContaining({ delayMs: 49, handle: 3 }));
    await engine.dispose();
  });

  it('delivers raw frames only after link latency and records byte-exact egress/ingress capture', async () => {
    const project = directProject({ latencyMs: 10 });
    const harness = runtimeHarness();
    const engine = new NativeLabEngine(project, harness.registry, { autoRun: false });
    await engine.start();
    const frame = ethernetFrame('02:00:00:00:00:02', '02:00:00:00:00:01', 0x0800, [1, 2, 3]);

    harness.byNode.get('a')!.transmit('uplink', frame);
    await engine.advanceBy(9.999);
    expect(harness.byNode.get('b')!.deliveredFrames).toHaveLength(0);
    await engine.advanceBy(0.001);

    expect(harness.byNode.get('b')!.deliveredFrames).toHaveLength(1);
    expect([...harness.byNode.get('b')!.deliveredFrames[0]!.bytes]).toEqual([...frame]);
    const capture = engine.getCapture();
    expect(capture.frames.map(({ direction, nodeId, atNs }) => ({ direction, nodeId, atNs }))).toEqual([
      { direction: 'egress', nodeId: 'a', atNs: 0n },
      { direction: 'ingress', nodeId: 'b', atNs: 10_000_000n },
    ]);
    expect(capture.frames.every((entry) => entry.frameId === capture.frames[0]!.frameId)).toBe(true);
    await engine.dispose();
  });

  it('implements deterministic total loss, MTU drops, and malformed frame drops', async () => {
    const project = directProject({ loss: 1, mtu: 60 });
    const harness = runtimeHarness();
    const engine = new NativeLabEngine(project, harness.registry, { autoRun: false });
    await engine.start();

    harness.byNode.get('a')!.transmit(
      'uplink',
      ethernetFrame('ff:ff:ff:ff:ff:ff', '02:00:00:00:00:01', 0x0800, [1]),
    );
    harness.byNode.get('a')!.transmit('uplink', new Uint8Array(100));
    harness.byNode.get('a')!.transmit('uplink', new Uint8Array([1, 2, 3]));
    await engine.advanceBy(100);

    expect(harness.byNode.get('b')!.deliveredFrames).toHaveLength(0);
    expect(
      engine.getCapture().frames.filter((frame) => frame.direction === 'dropped').map((frame) => frame.dropReason),
    ).toEqual(['loss', 'mtu-exceeded', 'malformed-frame']);
    await engine.dispose();
  });

  it('replays seeded jitter identically for the same project and frame sequence', async () => {
    const firstHarness = runtimeHarness();
    const secondHarness = runtimeHarness();
    const first = new NativeLabEngine(directProject({ latencyMs: 10, jitterMs: 5 }), firstHarness.registry, { autoRun: false });
    const second = new NativeLabEngine(directProject({ latencyMs: 10, jitterMs: 5 }), secondHarness.registry, { autoRun: false });
    await first.start();
    await second.start();
    const frame = ethernetFrame('ff:ff:ff:ff:ff:ff', '02:00:00:00:00:01', 0x0800);

    for (let index = 0; index < 10; index += 1) {
      firstHarness.byNode.get('a')!.transmit('uplink', frame);
      secondHarness.byNode.get('a')!.transmit('uplink', frame);
    }
    await first.advanceBy(20);
    await second.advanceBy(20);

    const ingressTimes = (engine: NativeLabEngine) => engine.getCapture().frames
      .filter((capture) => capture.direction === 'ingress')
      .map((capture) => capture.atNs);
    expect(ingressTimes(first)).toEqual(ingressTimes(second));
    expect(new Set(ingressTimes(first)).size).toBeGreaterThan(1);
    await first.dispose();
    await second.dispose();
  });

  it('fails and restores links and interfaces while notifying native guests', async () => {
    const project = directProject();
    const harness = runtimeHarness();
    const engine = new NativeLabEngine(project, harness.registry, { autoRun: false });
    await engine.start();
    const frame = ethernetFrame('ff:ff:ff:ff:ff:ff', '02:00:00:00:00:01', 0x0800);

    await engine.setLinkState('a-b', 'down');
    expect(harness.byNode.get('a')!.interfaceStateCalls.at(-1)).toEqual({ interfaceId: 'uplink', up: false });
    expect(harness.byNode.get('b')!.interfaceStateCalls.at(-1)).toEqual({ interfaceId: 'uplink', up: false });
    harness.byNode.get('a')!.transmit('uplink', frame);
    expect(engine.getCapture().frames.at(-1)?.dropReason).toBe('link-down');

    await engine.setLinkState('a-b', 'up');
    await engine.setInterfaceState('b', 'uplink', 'down');
    harness.byNode.get('a')!.transmit('uplink', frame);
    expect(engine.getCapture().frames.at(-1)?.dropReason).toBe('interface-down');
    await engine.setInterfaceState('b', 'uplink', 'up');
    harness.byNode.get('a')!.transmit('uplink', frame);
    await engine.advanceBy(1);
    expect(harness.byNode.get('b')!.deliveredFrames).toHaveLength(1);
    await engine.dispose();
  });

  it('drops a frame already in flight if its link fails before arrival', async () => {
    const project = directProject({ latencyMs: 20 });
    const harness = runtimeHarness();
    const engine = new NativeLabEngine(project, harness.registry, { autoRun: false });
    await engine.start();
    harness.byNode.get('a')!.transmit(
      'uplink',
      ethernetFrame('ff:ff:ff:ff:ff:ff', '02:00:00:00:00:01', 0x86dd),
    );
    await engine.advanceBy(5);
    await engine.setLinkState('a-b', 'down');
    await engine.advanceBy(15);

    expect(harness.byNode.get('b')!.deliveredFrames).toHaveLength(0);
    expect(engine.getCapture().frames.at(-1)).toEqual(
      expect.objectContaining({ direction: 'dropped', dropReason: 'link-down', atNs: 20_000_000n }),
    );
    await engine.dispose();
  });

  it('floods a switch broadcast domain and then uses learned MACs for unicast', async () => {
    const a = birdNode('a', '02:00:00:00:00:0a');
    const b = birdNode('b', '02:00:00:00:00:0b');
    const c = birdNode('c', '02:00:00:00:00:0c');
    const sw = switchNode('sw', 3);
    const project = projectWith(
      [a, b, c, sw],
      [
        link('a-sw', a, 0, sw, 0, 1),
        link('b-sw', b, 0, sw, 1, 1),
        link('c-sw', c, 0, sw, 2, 1),
      ],
    );
    const harness = runtimeHarness();
    const engine = new NativeLabEngine(project, harness.registry, { autoRun: false });
    await engine.start();

    harness.byNode.get('a')!.transmit(
      'uplink',
      ethernetFrame('ff:ff:ff:ff:ff:ff', '02:00:00:00:00:0a', 0x0800),
    );
    await engine.advanceBy(2);
    expect(harness.byNode.get('b')!.deliveredFrames).toHaveLength(1);
    expect(harness.byNode.get('c')!.deliveredFrames).toHaveLength(1);

    harness.byNode.get('b')!.transmit(
      'uplink',
      ethernetFrame('02:00:00:00:00:0a', '02:00:00:00:00:0b', 0x0800),
    );
    await engine.advanceBy(2);
    expect(harness.byNode.get('a')!.deliveredFrames).toHaveLength(1);
    expect(harness.byNode.get('c')!.deliveredFrames).toHaveLength(1);
    expect(harness.created).toHaveLength(3);
    await engine.dispose();
  });

  it('bounds frame and event capture independently and returns defensive byte copies', async () => {
    const project = directProject({ loss: 1 });
    project.settings.captureLimit = 3;
    const harness = runtimeHarness();
    const engine = new NativeLabEngine(project, harness.registry, { autoRun: false });
    await engine.start();
    const frame = ethernetFrame('ff:ff:ff:ff:ff:ff', '02:00:00:00:00:01', 0x0800);

    for (let index = 0; index < 5; index += 1) harness.byNode.get('a')!.transmit('uplink', frame);
    const first = engine.getCapture();
    expect(first.frames).toHaveLength(3);
    expect(first.events).toHaveLength(3);
    first.frames[0]!.bytes[0] = 0;
    expect(engine.getCapture().frames[0]!.bytes[0]).toBe(0xff);

    engine.clearCapture();
    const cleared = engine.getCapture();
    expect(cleared.frames).toEqual([]);
    expect(cleared.events).toHaveLength(1);
    expect(cleared.events[0]!.type).toBe('capture.cleared');
    await engine.dispose();
  });
});

describe('NativeLabEngine terminal, files, inspection, and node controls', () => {
  it('routes terminal output emitted during open and later writes to per-session and global callbacks', async () => {
    const harness = runtimeHarness({ synchronousTerminalGreeting: 'ready> ' });
    const outputs: string[] = [];
    const global: string[] = [];
    const engine = new NativeLabEngine(directProject(), harness.registry, {
      autoRun: false,
      onTerminalOutput: (output) => global.push(decoder.decode(output.data)),
    });
    await engine.start();

    const session = await engine.openTerminal('a', {
      onOutput: (output) => outputs.push(decoder.decode(output.data)),
    });
    expect(outputs).toEqual(['ready> ']);
    expect(global).toEqual(['ready> ']);
    await engine.writeTerminal(session.id, 'show route\n');
    expect(decoder.decode(harness.byNode.get('a')!.terminalWrites[0]!.data)).toBe('show route\n');
    harness.byNode.get('a')!.terminalOutput('serial-1', 'native output\r\n');
    expect(outputs).toEqual(['ready> ', 'native output\r\n']);
    await engine.resizeTerminal(session.id, 120, 40);
    expect(harness.byNode.get('a')!.terminalResizes).toEqual([{ sessionId: 'serial-1', columns: 120, rows: 40 }]);
    await engine.closeTerminal(session.id);
    expect(harness.byNode.get('a')!.closedTerminals).toEqual(['serial-1']);
    await engine.dispose();
  });

  it('proxies exact files, inspection, and node failure/recovery', async () => {
    const harness = runtimeHarness();
    const engine = new NativeLabEngine(directProject(), harness.registry, { autoRun: false });
    await engine.start();
    const bytes = encoder.encode('define TEST = 1;\n');

    await engine.writeFile('a', '/etc/bird/filters.conf', bytes, 0o640);
    bytes[0] = 0;
    expect(decoder.decode((await engine.readFile('a', '/etc/bird/filters.conf'))!.contents)).toBe('define TEST = 1;\n');
    expect((await engine.inspect('a'))[0]).toEqual(
      expect.objectContaining({ nodeId: 'a', descriptor: expect.objectContaining({ fidelity: 'native' }) }),
    );

    await engine.setNodeState('a', 'down');
    expect(harness.byNode.get('a')!.state).toBe('stopped');
    await engine.setNodeState('a', 'up');
    expect(harness.byNode.get('a')!.state).toBe('running');
    expect(harness.byNode.get('a')!.startCalls).toBe(2);
    await engine.dispose();
  });

  it('fails a runtime that never yields immediate cooperative work', async () => {
    const harness = runtimeHarness({ immediateForever: true });
    const engine = new NativeLabEngine(directProject(), harness.registry, {
      autoRun: false,
      maxImmediateSteps: 2,
    });

    await expect(engine.start()).rejects.toThrow(/immediate-step limit/);
    expect(engine.state).toBe('failed');
    expect(harness.created.every((runtime) => runtime.state === 'disposed')).toBe(true);
    await engine.dispose();
  });
});

interface HarnessOptions {
  readonly synchronousTerminalGreeting?: string;
  readonly immediateForever?: boolean;
}

function runtimeHarness(options: HarnessOptions = {}) {
  const registry = new ApplianceRuntimeRegistry();
  const created: FakeRuntime[] = [];
  const byNode = new Map<string, FakeRuntime>();
  for (const kind of ['bird', 'frr', 'client'] as const) {
    const value = runtimeDescriptor(kind);
    registry.register({
      descriptor: value,
      create: () => {
        const runtime = new FakeRuntime(value, options, byNode);
        created.push(runtime);
        return runtime;
      },
    });
  }
  return { registry, created, byNode };
}

class FakeRuntime implements ApplianceRuntime {
  readonly apiVersion = APPLIANCE_RUNTIME_API_VERSION;
  state: ApplianceLifecycleState = 'new';
  boot: ApplianceBootRequest | null = null;
  host: ApplianceHostV1 | null = null;
  readonly deliveredFrames: ApplianceFrame[] = [];
  readonly interfaceStateCalls: Array<{ interfaceId: string; up: boolean }> = [];
  readonly stepRequests: ApplianceStepRequest[] = [];
  readonly terminalWrites: Array<{ sessionId: string; data: Uint8Array }> = [];
  readonly terminalResizes: Array<{ sessionId: string; columns: number; rows: number }> = [];
  readonly closedTerminals: string[] = [];
  readonly files = new Map<string, ApplianceFile>();
  startCalls = 0;
  #nextTerminal = 1;

  constructor(
    readonly descriptor: ApplianceRuntimeDescriptor,
    readonly options: HarnessOptions,
    readonly byNode: Map<string, FakeRuntime>,
  ) {}

  async initialize(request: ApplianceBootRequest, host: ApplianceHostV1): Promise<ApplianceBootResult> {
    expect(this.state).toBe('new');
    this.boot = copyBoot(request);
    this.host = host;
    this.files.clear();
    for (const file of request.files) this.files.set(file.path, copyFile(file));
    this.byNode.set(request.nodeId, this);
    this.state = 'initialized';
    host.emitEvent({ type: 'lifecycle', state: 'initialized' });
    return { state: 'initialized', warnings: [] };
  }

  async start(): Promise<void> {
    this.state = 'running';
    this.startCalls += 1;
    this.host?.emitEvent({ type: 'lifecycle', state: 'running' });
  }

  async step(request: ApplianceStepRequest): Promise<ApplianceStepResult> {
    this.stepRequests.push({ ...request });
    return {
      state: this.state,
      workItems: this.options.immediateForever ? 1 : 0,
      nextDeadlineNs: null,
      hasImmediateWork: this.options.immediateForever ?? false,
    };
  }

  async deliverFrame(frame: ApplianceFrame): Promise<void> {
    this.deliveredFrames.push({ ...frame, bytes: frame.bytes.slice() });
  }

  async setInterfaceState(interfaceId: string, up: boolean): Promise<void> {
    this.interfaceStateCalls.push({ interfaceId, up });
  }

  async writeFile(file: ApplianceFile): Promise<void> {
    this.files.set(file.path, copyFile(file));
    this.host?.emitEvent({
      type: 'file-changed',
      path: file.path,
      contents: file.contents.slice(),
      mode: file.mode ?? 0o644,
    });
  }

  async readFile(path: string): Promise<ApplianceFile | null> {
    const file = this.files.get(path);
    return file === undefined ? null : copyFile(file);
  }

  async openTerminal(_request: ApplianceTerminalOpenRequest): Promise<string> {
    const id = `serial-${this.#nextTerminal++}`;
    if (this.options.synchronousTerminalGreeting !== undefined) {
      this.terminalOutput(id, this.options.synchronousTerminalGreeting);
    }
    return id;
  }

  async writeTerminal(sessionId: string, data: Uint8Array): Promise<void> {
    this.terminalWrites.push({ sessionId, data: data.slice() });
  }

  async resizeTerminal(sessionId: string, columns: number, rows: number): Promise<void> {
    this.terminalResizes.push({ sessionId, columns, rows });
  }

  async closeTerminal(sessionId: string): Promise<void> {
    this.closedTerminals.push(sessionId);
  }

  async inspect(): Promise<ApplianceInspectionSnapshot> {
    return {
      revision: 1,
      lifecycle: this.state,
      interfaces: this.boot?.interfaces.map(copyInterface) ?? [],
      routes: [],
      protocols: [],
    };
  }

  async stop(): Promise<void> {
    this.state = 'stopped';
    this.host?.emitEvent({ type: 'lifecycle', state: 'stopped' });
  }

  async dispose(): Promise<void> {
    this.state = 'disposed';
  }

  transmit(interfaceId: string, bytes: Uint8Array): void {
    this.host!.transmitFrame({ interfaceId, bytes });
  }

  terminalOutput(sessionId: string, value: string): void {
    this.host!.emitEvent({ type: 'terminal-output', sessionId, data: encoder.encode(value) });
  }

  fail(detail: string): void {
    this.state = 'failed';
    this.host!.emitEvent({ type: 'lifecycle', state: 'failed', detail });
  }
}

function directProject(overrides: Partial<LabLink> = {}): LabProject {
  const a = birdNode('a', '02:00:00:00:00:01');
  const b = birdNode('b', '02:00:00:00:00:02');
  return projectWith([a, b], [{ ...link('a-b', a, 0, b, 0, 1), ...overrides }]);
}

function projectWith(nodes: LabNode[], links: LabLink[]): LabProject {
  return {
    ...createEmptyProject({ id: 'native-engine', name: 'Native engine', seed: 678 }),
    nodes,
    links,
    settings: { defaultTtl: 32, maxConvergenceIterations: 64, captureLimit: 1_000 },
  };
}

function birdNode(id: string, mac = `02:00:00:00:00:${id === 'a' ? '01' : '02'}`): LabNode {
  return {
    id,
    name: id,
    kind: 'router',
    appliance: { kind: 'bird', runtime: 'wasm', version: '2.17.1', entrypoint: '/etc/bird/bird.conf' },
    interfaces: [{ id: 'uplink', name: 'eth0', mac, addresses: [], state: 'up', mtu: 1500 }],
    files: [{ path: '/etc/bird/bird.conf', content: 'router id 192.0.2.1;\n', entrypoint: true }],
    state: 'up',
  };
}

function clientNode(id: string): LabNode {
  return {
    id,
    name: id,
    kind: 'client',
    appliance: { kind: 'client', runtime: 'wasm', version: '1' },
    interfaces: [{ id: 'uplink', name: 'eth0', addresses: ['10.0.0.2/24'], state: 'up' }],
    files: [],
    state: 'up',
    client: { defaultGateway: '10.0.0.1' },
  };
}

function serviceNode(id: string): LabNode {
  return {
    id,
    name: id,
    kind: 'service',
    appliance: { kind: 'service', runtime: 'wasm', version: '1' },
    interfaces: [{ id: 'uplink', name: 'eth0', addresses: ['10.0.0.3/24'], state: 'up' }],
    files: [],
    state: 'up',
    service: { addresses: ['203.0.113.53/32'], protocols: ['icmp'] },
  };
}

function switchNode(id: string, count: number): LabNode {
  return {
    id,
    name: id,
    kind: 'switch',
    appliance: { kind: 'switch', runtime: 'compatibility' },
    interfaces: Array.from({ length: count }, (_, index) => ({
      id: `port-${index}`,
      name: `p${index}`,
      addresses: [],
      state: 'up' as const,
      mtu: 1500,
    })),
    files: [],
    state: 'up',
  };
}

function link(
  id: string,
  first: LabNode,
  firstInterface: number,
  second: LabNode,
  secondInterface: number,
  latencyMs: number,
): LabLink {
  return {
    id,
    endpoints: [
      { nodeId: first.id, interfaceId: first.interfaces[firstInterface]!.id },
      { nodeId: second.id, interfaceId: second.interfaces[secondInterface]!.id },
    ],
    state: 'up',
    latencyMs,
    jitterMs: 0,
    loss: 0,
    bandwidthMbps: undefined,
  };
}

function runtimeDescriptor(kind: ApplianceKind): ApplianceRuntimeDescriptor {
  return {
    runtimeId: `${kind}-native-test`,
    displayName: `${kind} native test`,
    kind,
    fidelity: 'native',
    upstreamVersion: kind === 'bird' ? '2.17.1' : kind === 'frr' ? '10.5.1' : null,
    buildId: 'native-test',
    runtimeApiVersion: APPLIANCE_RUNTIME_API_VERSION,
    hostAbiVersion: APPLIANCE_HOST_ABI_VERSION,
    capabilities: {
      ethernet: true,
      ipv4: true,
      ipv6: true,
      nativeConfig: true,
      packetCapture: true,
      terminals: ['serial'],
      protocols: kind === 'client' ? [] : ['BGP'],
    },
    limitations: [],
  };
}

function ethernetFrame(
  destination: string,
  source: string,
  etherType: number,
  payload: readonly number[] = [],
): Uint8Array {
  const output = new Uint8Array(14 + payload.length);
  output.set(macBytes(destination), 0);
  output.set(macBytes(source), 6);
  output[12] = etherType >>> 8;
  output[13] = etherType & 0xff;
  output.set(payload, 14);
  return output;
}

function macBytes(value: string): number[] {
  return value.split(':').map((part) => Number.parseInt(part, 16));
}

function copyFile(file: ApplianceFile): ApplianceFile {
  return { ...file, contents: file.contents.slice() };
}

function copyInterface(value: ApplianceInterfaceSpec): ApplianceInterfaceSpec {
  return { ...value, addresses: value.addresses.map((address) => ({ ...address })) };
}

function copyBoot(value: ApplianceBootRequest): ApplianceBootRequest {
  return {
    ...value,
    argv: [...value.argv],
    environment: { ...value.environment },
    files: value.files.map(copyFile),
    interfaces: value.interfaces.map(copyInterface),
  };
}
