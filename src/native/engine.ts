import {
  APPLIANCE_HOST_ABI_VERSION,
  type ApplianceBootRequest,
  type ApplianceFrame,
  type ApplianceHostV1,
  type ApplianceObservedEvent,
  type ApplianceRuntime,
  type ApplianceRuntimeDescriptor,
} from '../appliances/abi';
import type { ApplianceRuntimeRegistry } from '../appliances/registry';
import { SeededRandom } from '../core/scheduler';
import type {
  LabInterface,
  LabLink,
  LabNode,
  LabProject,
  LinkEndpoint,
  OperationalState,
} from '../core/types';
import {
  analyzeNativeProject,
  buildNativeBootRequest,
  runtimeKindForNode,
} from './boot';
import { exportNativePcapng } from './pcapng';
import type {
  NativeApplianceInspection,
  NativeCapturedFrame,
  NativeFrameDropReason,
  NativeLabEngineOptions,
  NativeLabEngineState,
  NativeLabEvent,
  NativePacketCapture,
  NativeProjectDiagnostic,
  NativeTerminalOpenOptions,
  NativeTerminalOutput,
  NativeTerminalSession,
} from './types';

const MAX_SWITCH_HOPS = 64;
const BROADCAST_MAC = 'ff:ff:ff:ff:ff:ff';

interface ApplianceEntry {
  readonly node: LabNode;
  readonly runtime: ApplianceRuntime;
  readonly descriptor: ApplianceRuntimeDescriptor;
  active: boolean;
  nextDeadlineNs: bigint | null;
}

interface PendingArrival {
  readonly order: number;
  readonly dueNs: bigint;
  readonly frameId: number;
  readonly from: LinkEndpoint;
  readonly to: LinkEndpoint;
  readonly linkId: string;
  readonly bytes: Uint8Array;
  readonly visitedDirections: ReadonlySet<string>;
  readonly switchHops: number;
}

interface TerminalEntry {
  session: NativeTerminalSession;
  readonly runtimeSessionId: string;
  readonly onOutput?: (output: NativeTerminalOutput) => void;
}

class BoundedCapture<T> {
  readonly #values: T[] = [];
  constructor(readonly limit: number) {}

  push(value: T): void {
    this.#values.push(value);
    if (this.#values.length > this.limit) {
      this.#values.splice(0, this.#values.length - this.limit);
    }
  }

  clear(): void {
    this.#values.length = 0;
  }

  values(): readonly T[] {
    return this.#values;
  }
}

export class NativeProjectIneligibleError extends Error {
  constructor(readonly diagnostics: readonly NativeProjectDiagnostic[]) {
    super(
      `Project is not eligible for the native lab:\n${diagnostics
        .filter((diagnostic) => diagnostic.severity === 'error')
        .map((diagnostic) => `- ${diagnostic.message}`)
        .join('\n')}`,
    );
    this.name = 'NativeProjectIneligibleError';
  }
}

/**
 * Hosts native appliances and connects their raw Ethernet interfaces through
 * the project links. Routing policy and packet forwarding remain entirely
 * inside the registered appliance runtimes.
 */
export class NativeLabEngine {
  readonly #project: LabProject;
  readonly #registry: ApplianceRuntimeRegistry;
  readonly #options: Required<
    Pick<
      NativeLabEngineOptions,
      'autoRun' | 'maxWorkItemsPerStep' | 'maxImmediateSteps' | 'maxEventsPerAdvance'
    >
  > & NativeLabEngineOptions;
  readonly #nodes = new Map<string, LabNode>();
  readonly #interfaces = new Map<string, LabInterface>();
  readonly #links = new Map<string, LabLink>();
  readonly #linkByEndpoint = new Map<string, LabLink>();
  readonly #nodeStates = new Map<string, OperationalState>();
  readonly #interfaceStates = new Map<string, OperationalState>();
  readonly #linkStates = new Map<string, OperationalState>();
  readonly #appliances = new Map<string, ApplianceEntry>();
  readonly #switchLearning = new Map<string, Map<string, string>>();
  readonly #frames: BoundedCapture<NativeCapturedFrame>;
  readonly #events: BoundedCapture<NativeLabEvent>;
  readonly #random: SeededRandom;
  readonly #terminals = new Map<string, TerminalEntry>();
  readonly #runtimeTerminalIds = new Map<string, string>();
  readonly #pendingTerminalOutput = new Map<string, Uint8Array[]>();
  #state: NativeLabEngineState = 'new';
  #nowNs = 0n;
  #eventSequence = 0;
  #frameSequence = 0;
  #nextFrameId = 1;
  #nextArrivalOrder = 1;
  #nextTerminalId = 1;
  #pendingArrivals: PendingArrival[] = [];
  #timer: unknown = null;
  #timerDueNs: bigint | null = null;
  #wallLastMs = 0;
  #driveTail: Promise<void> = Promise.resolve();
  #failureCleanup: Promise<void> | null = null;

  constructor(
    project: LabProject,
    registry: ApplianceRuntimeRegistry,
    options: NativeLabEngineOptions = {},
  ) {
    this.#project = project;
    this.#registry = registry;
    this.#options = {
      ...options,
      autoRun: options.autoRun ?? true,
      maxWorkItemsPerStep: options.maxWorkItemsPerStep ?? 1_024,
      maxImmediateSteps: options.maxImmediateSteps ?? 64,
      maxEventsPerAdvance: options.maxEventsPerAdvance ?? 100_000,
    };
    if (this.#options.maxWorkItemsPerStep < 1 || !Number.isSafeInteger(this.#options.maxWorkItemsPerStep)) {
      throw new RangeError('maxWorkItemsPerStep must be a positive integer');
    }
    if (this.#options.maxImmediateSteps < 1 || !Number.isSafeInteger(this.#options.maxImmediateSteps)) {
      throw new RangeError('maxImmediateSteps must be a positive integer');
    }
    if (this.#options.maxEventsPerAdvance < 1 || !Number.isSafeInteger(this.#options.maxEventsPerAdvance)) {
      throw new RangeError('maxEventsPerAdvance must be a positive integer');
    }

    for (const node of project.nodes) {
      this.#nodes.set(node.id, node);
      this.#nodeStates.set(node.id, node.state);
      for (const networkInterface of node.interfaces) {
        const key = endpointKey(node.id, networkInterface.id);
        this.#interfaces.set(key, networkInterface);
        this.#interfaceStates.set(key, networkInterface.state);
      }
      if (node.kind === 'switch') this.#switchLearning.set(node.id, new Map());
    }
    for (const link of project.links) {
      this.#links.set(link.id, link);
      this.#linkStates.set(link.id, link.state);
      for (const endpoint of link.endpoints) this.#linkByEndpoint.set(endpointKeyOf(endpoint), link);
    }
    this.#frames = new BoundedCapture(project.settings.captureLimit);
    this.#events = new BoundedCapture(project.settings.captureLimit);
    this.#random = new SeededRandom(project.seed);
  }

  get state(): NativeLabEngineState {
    return this.#state;
  }

  get nowNs(): bigint {
    return this.#nowNs;
  }

  get nowMs(): number {
    return Number(this.#nowNs) / 1_000_000;
  }

  get project(): LabProject {
    return this.#project;
  }

  eligibility() {
    return analyzeNativeProject(this.#project, this.#registry);
  }

  runtimeDescriptors(): Readonly<Record<string, ApplianceRuntimeDescriptor>> {
    return Object.fromEntries(
      [...this.#appliances].map(([nodeId, entry]) => [nodeId, entry.descriptor]),
    );
  }

  async start(): Promise<void> {
    this.#expectState('new', 'paused', 'stopped');
    const resuming = this.#state === 'paused' || (this.#state === 'stopped' && this.#appliances.size > 0);
    this.#transition('starting', resuming ? 'Resuming native appliances' : 'Starting native appliances');
    try {
      if (this.#appliances.size === 0) await this.#initializeAppliances();
      for (const entry of this.#appliances.values()) {
        if (this.#nodeStates.get(entry.node.id) !== 'up') continue;
        if (entry.runtime.state === 'initialized' || entry.runtime.state === 'stopped') {
          await entry.runtime.start();
        }
        if (this.#state === 'failed' || entry.runtime.state !== 'running') {
          throw new Error(`Native appliance ${entry.node.id} failed while the lab was starting`);
        }
        entry.active = entry.runtime.state === 'running';
        entry.nextDeadlineNs = entry.active ? this.#nowNs : null;
      }
      await this.#driveTo(this.#nowNs);
      if (this.#state === 'failed') throw new Error('A native appliance failed while the lab was starting');
      this.#transition('running', resuming ? 'Native lab resumed' : 'Native lab started');
      this.#wallLastMs = this.#wallNowMs();
      this.#scheduleAutomaticWake();
    } catch (error) {
      this.#transition('failed', errorMessage(error));
      await this.#beginFailureCleanup('native lab startup failed');
      throw error;
    }
  }

  async pause(): Promise<void> {
    this.#expectState('running');
    this.#cancelTimer();
    if (this.#options.autoRun) await this.#advanceFromWallClock();
    this.#transition('pausing', 'Pausing native lab');
    for (const entry of this.#appliances.values()) {
      if (entry.runtime.state === 'running') await entry.runtime.stop('lab paused');
      entry.active = false;
      entry.nextDeadlineNs = null;
    }
    this.#transition('paused', 'Native lab paused');
  }

  async resume(): Promise<void> {
    this.#expectState('paused');
    await this.start();
  }

  async stop(reason = 'lab stopped'): Promise<void> {
    this.#expectState('new', 'starting', 'running', 'paused', 'failed', 'stopped');
    if (this.#state === 'stopped') return;
    this.#cancelTimer();
    this.#transition('stopping', reason);
    const failures: unknown[] = [];
    for (const entry of this.#appliances.values()) {
      try {
        if (entry.runtime.state === 'running') await entry.runtime.stop(reason);
      } catch (error) {
        failures.push(error);
      }
      entry.active = false;
      entry.nextDeadlineNs = null;
    }
    this.#pendingArrivals = [];
    this.#transition('stopped', reason);
    if (failures.length > 0) throw new AggregateError(failures, 'One or more native appliances failed to stop');
  }

  async dispose(): Promise<void> {
    if (this.#state === 'disposed') return;
    this.#cancelTimer();
    await this.#failureCleanup;
    const failures: unknown[] = [];
    for (const entry of this.#appliances.values()) {
      try {
        if (entry.runtime.state === 'running') await entry.runtime.stop('lab disposed');
        await entry.runtime.dispose();
      } catch (error) {
        failures.push(error);
      }
    }
    this.#appliances.clear();
    this.#pendingArrivals = [];
    this.#terminals.clear();
    this.#runtimeTerminalIds.clear();
    this.#pendingTerminalOutput.clear();
    this.#transition('disposed', 'Native lab disposed');
    if (failures.length > 0) throw new AggregateError(failures, 'One or more native appliances failed to dispose');
  }

  /** Advance deterministic appliance/fabric time. Primarily used when `autoRun` is false. */
  async advanceBy(milliseconds: number): Promise<void> {
    this.#expectState('running');
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new RangeError('advanceBy requires a non-negative finite duration');
    }
    const target = this.#nowNs + millisecondsToNs(milliseconds);
    await this.#enqueueDrive(async () => this.#driveTo(target));
    this.#scheduleAutomaticWake();
  }

  async setLinkState(linkId: string, state: OperationalState): Promise<void> {
    this.#expectUsable();
    const link = this.#links.get(linkId);
    if (link === undefined) throw new Error(`Unknown link: ${linkId}`);
    if (this.#linkStates.get(linkId) === state) return;
    this.#linkStates.set(linkId, state);
    this.#emitEvent({
      type: 'link.state',
      linkId,
      message: `Link ${link.name ?? link.id} is ${state}`,
      detail: { state },
    });
    for (const endpoint of link.endpoints) await this.#applyEffectiveInterfaceState(endpoint);
    if (state === 'down') this.#clearLearningForLink(link);
  }

  async setInterfaceState(
    nodeId: string,
    interfaceId: string,
    state: OperationalState,
  ): Promise<void> {
    this.#expectUsable();
    const key = endpointKey(nodeId, interfaceId);
    if (!this.#interfaces.has(key)) throw new Error(`Unknown interface: ${nodeId}:${interfaceId}`);
    if (this.#interfaceStates.get(key) === state) return;
    this.#interfaceStates.set(key, state);
    await this.#applyEffectiveInterfaceState({ nodeId, interfaceId });
    this.#emitEvent({
      type: 'interface.state',
      nodeId,
      interfaceId,
      message: `Interface ${nodeId}:${interfaceId} is ${state}`,
      detail: { state },
    });
    this.#clearLearningForEndpoint({ nodeId, interfaceId });
  }

  async setNodeState(nodeId: string, state: OperationalState): Promise<void> {
    this.#expectUsable();
    const node = this.#nodes.get(nodeId);
    if (node === undefined) throw new Error(`Unknown node: ${nodeId}`);
    if (this.#nodeStates.get(nodeId) === state) return;
    const entry = this.#appliances.get(nodeId);
    if (state === 'down' && entry?.runtime.state === 'running') {
      await entry.runtime.stop('node failed');
      entry.active = false;
      entry.nextDeadlineNs = null;
    }
    this.#nodeStates.set(nodeId, state);
    if (state === 'up' && entry !== undefined && this.#state === 'running') {
      await entry.runtime.start();
      entry.active = true;
      entry.nextDeadlineNs = this.#nowNs;
      for (const networkInterface of node.interfaces) {
        await this.#applyEffectiveInterfaceState({ nodeId, interfaceId: networkInterface.id });
      }
      await this.#enqueueDrive(async () => this.#driveTo(this.#nowNs));
    }
    this.#emitEvent({
      type: 'node.state',
      nodeId,
      message: `Node ${node.name} is ${state}`,
      detail: { state },
    });
    if (state === 'down') this.#switchLearning.get(nodeId)?.clear();
    this.#scheduleAutomaticWake();
  }

  async inspect(nodeId?: string): Promise<readonly NativeApplianceInspection[]> {
    this.#expectUsable();
    const entries = nodeId === undefined
      ? [...this.#appliances.entries()]
      : [[nodeId, this.#requireAppliance(nodeId)] as const];
    const output: NativeApplianceInspection[] = [];
    for (const [id, entry] of entries) {
      output.push({ nodeId: id, descriptor: entry.descriptor, snapshot: await entry.runtime.inspect() });
    }
    return output;
  }

  async writeFile(nodeId: string, path: string, contents: Uint8Array, mode = 0o644): Promise<void> {
    this.#expectUsable();
    await this.#requireAppliance(nodeId).runtime.writeFile({ path, contents: contents.slice(), mode });
  }

  async readFile(nodeId: string, path: string) {
    this.#expectUsable();
    return this.#requireAppliance(nodeId).runtime.readFile(path);
  }

  async openTerminal(
    nodeId: string,
    options: NativeTerminalOpenOptions = {},
  ): Promise<NativeTerminalSession> {
    this.#expectUsable();
    const entry = this.#requireAppliance(nodeId);
    const terminal = options.terminal ??
      (entry.descriptor.capabilities.terminals.includes('serial')
        ? 'serial'
        : entry.descriptor.capabilities.terminals[0]);
    if (terminal === undefined) throw new Error(`Runtime ${entry.descriptor.runtimeId} exposes no terminal`);
    if (!entry.descriptor.capabilities.terminals.includes(terminal)) {
      throw new Error(`Runtime ${entry.descriptor.runtimeId} does not expose terminal ${terminal}`);
    }
    const columns = options.columns ?? 100;
    const rows = options.rows ?? 30;
    const runtimeSessionId = await entry.runtime.openTerminal({ terminal, columns, rows });
    const id = `terminal-${this.#nextTerminalId++}`;
    const session = { id, nodeId, terminal, columns, rows } satisfies NativeTerminalSession;
    this.#terminals.set(id, { session, runtimeSessionId, onOutput: options.onOutput });
    const runtimeKey = runtimeTerminalKey(nodeId, runtimeSessionId);
    this.#runtimeTerminalIds.set(runtimeKey, id);
    for (const data of this.#pendingTerminalOutput.get(runtimeKey) ?? []) {
      this.#publishTerminalOutput(id, data);
    }
    this.#pendingTerminalOutput.delete(runtimeKey);
    return session;
  }

  async writeTerminal(sessionId: string, data: Uint8Array | string): Promise<void> {
    this.#expectUsable();
    const terminal = this.#requireTerminal(sessionId);
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data.slice();
    await this.#requireAppliance(terminal.session.nodeId).runtime.writeTerminal(
      terminal.runtimeSessionId,
      bytes,
    );
  }

  async resizeTerminal(sessionId: string, columns: number, rows: number): Promise<void> {
    this.#expectUsable();
    const terminal = this.#requireTerminal(sessionId);
    await this.#requireAppliance(terminal.session.nodeId).runtime.resizeTerminal(
      terminal.runtimeSessionId,
      columns,
      rows,
    );
    terminal.session = { ...terminal.session, columns, rows };
  }

  async closeTerminal(sessionId: string): Promise<void> {
    this.#expectUsable();
    const terminal = this.#requireTerminal(sessionId);
    await this.#requireAppliance(terminal.session.nodeId).runtime.closeTerminal(terminal.runtimeSessionId);
    this.#terminals.delete(sessionId);
    this.#runtimeTerminalIds.delete(runtimeTerminalKey(terminal.session.nodeId, terminal.runtimeSessionId));
  }

  getCapture(): NativePacketCapture {
    return {
      format: 'anycast-lab-ethernet-capture-v1',
      projectId: this.#project.id,
      generatedAtNs: this.#nowNs,
      captureLimit: this.#project.settings.captureLimit,
      frames: this.#frames.values().map(copyCapturedFrame),
      events: this.#events.values().map(copyLabEvent),
    };
  }

  clearCapture(): void {
    this.#frames.clear();
    this.#events.clear();
    this.#emitEvent({ type: 'capture.cleared', message: 'Packet and event capture cleared' });
  }

  exportPcapng(): Uint8Array {
    return exportNativePcapng(this.#project, this.getCapture());
  }

  async #initializeAppliances(): Promise<void> {
    const eligibility = analyzeNativeProject(this.#project, this.#registry);
    if (!eligibility.eligible) throw new NativeProjectIneligibleError(eligibility.diagnostics);

    for (const node of this.#project.nodes) {
      const kind = runtimeKindForNode(node);
      if (kind === null) continue;
      const selector = {
        kind,
        ...(
          kind === 'client' || node.appliance.version === undefined
            ? {}
            : { upstreamVersion: node.appliance.version }
        ),
      } as const;
      const runtime = this.#registry.create(selector);
      if (runtime.descriptor.fidelity !== 'native') {
        throw new Error(`Native lab refused non-native runtime ${runtime.descriptor.runtimeId}`);
      }
      if (runtime.descriptor.kind !== kind) {
        throw new Error(`Runtime ${runtime.descriptor.runtimeId} has kind ${runtime.descriptor.kind}; expected ${kind}`);
      }
      const entry: ApplianceEntry = {
        node,
        runtime,
        descriptor: runtime.descriptor,
        active: false,
        nextDeadlineNs: null,
      };
      this.#appliances.set(node.id, entry);
      const host = this.#createHost(node.id);
      const baseBoot = buildNativeBootRequest(this.#project, node);
      const boot: ApplianceBootRequest = {
        ...baseBoot,
        interfaces: baseBoot.interfaces.map((networkInterface) => ({
          ...networkInterface,
          up: this.#endpointOperational({ nodeId: node.id, interfaceId: networkInterface.id }),
        })),
      };
      const result = await runtime.initialize(boot, host);
      this.#emitEvent({
        type: 'runtime.initialized',
        nodeId: node.id,
        message: `${runtime.descriptor.displayName} initialized for ${node.name}`,
        detail: { runtimeId: runtime.descriptor.runtimeId, warnings: [...result.warnings] },
      });
    }
  }

  #createHost(nodeId: string): ApplianceHostV1 {
    return {
      abiVersion: APPLIANCE_HOST_ABI_VERSION,
      nowNs: () => this.#nowNs,
      fillRandom: (target) => {
        for (let index = 0; index < target.length; index += 1) {
          target[index] = this.#random.nextUint32() & 0xff;
        }
      },
      transmitFrame: (frame) => this.#handleTransmitFrame(nodeId, frame),
      emitEvent: (event) => this.#handleRuntimeEvent(nodeId, event),
    };
  }

  #handleTransmitFrame(nodeId: string, frame: ApplianceFrame): void {
    const bytes = frame.bytes.slice();
    const frameId = this.#nextFrameId++;
    const endpoint = { nodeId, interfaceId: frame.interfaceId };
    if (this.#state !== 'running' && this.#state !== 'starting') {
      this.#captureDrop(frameId, endpoint, bytes, 'engine-not-running');
      return;
    }
    const atNs = this.#projectedWallNowNs();
    this.#sendAcrossLink(frameId, endpoint, bytes, new Set(), 0, atNs);
    this.#scheduleAutomaticWake();
  }

  #sendAcrossLink(
    frameId: number,
    from: LinkEndpoint,
    bytes: Uint8Array,
    visitedDirections: ReadonlySet<string>,
    switchHops: number,
    atNs: bigint,
  ): void {
    const node = this.#nodes.get(from.nodeId);
    if (node === undefined) {
      this.#captureDrop(frameId, from, bytes, 'unknown-node', undefined, atNs);
      return;
    }
    if (!this.#interfaces.has(endpointKeyOf(from))) {
      this.#captureDrop(frameId, from, bytes, 'unknown-interface', undefined, atNs);
      return;
    }
    if (this.#nodeStates.get(from.nodeId) !== 'up') {
      this.#captureDrop(frameId, from, bytes, 'node-down', undefined, atNs);
      return;
    }
    if (this.#interfaceStates.get(endpointKeyOf(from)) !== 'up') {
      this.#captureDrop(frameId, from, bytes, 'interface-down', undefined, atNs);
      return;
    }
    if (bytes.byteLength < 14) {
      this.#captureDrop(frameId, from, bytes, 'malformed-frame', undefined, atNs);
      return;
    }
    const link = this.#linkByEndpoint.get(endpointKeyOf(from));
    if (link === undefined) {
      this.#captureDrop(frameId, from, bytes, 'no-link', undefined, atNs);
      return;
    }
    const direction = `${link.id}\u0000${endpointKeyOf(from)}`;
    if (visitedDirections.has(direction) || switchHops > MAX_SWITCH_HOPS) {
      this.#captureDrop(frameId, from, bytes, 'switch-loop', link.id, atNs);
      return;
    }
    if (this.#linkStates.get(link.id) !== 'up') {
      this.#captureDrop(frameId, from, bytes, 'link-down', link.id, atNs);
      return;
    }
    const to = otherEndpoint(link, from);
    if (!this.#endpointOperational(to)) {
      const reason = this.#nodeStates.get(to.nodeId) !== 'up' ? 'node-down' : 'interface-down';
      this.#captureDrop(frameId, from, bytes, reason, link.id, atNs);
      return;
    }
    const mtu = Math.min(
      link.mtu ?? Number.POSITIVE_INFINITY,
      this.#interfaces.get(endpointKeyOf(from))?.mtu ?? Number.POSITIVE_INFINITY,
      this.#interfaces.get(endpointKeyOf(to))?.mtu ?? Number.POSITIVE_INFINITY,
    );
    // Appliance frames do not carry an Ethernet FCS; an untagged L2 header is 14 bytes.
    if (Number.isFinite(mtu) && bytes.byteLength > mtu + 14) {
      this.#captureDrop(frameId, from, bytes, 'mtu-exceeded', link.id, atNs);
      return;
    }

    this.#captureFrame({ frameId, atNs, direction: 'egress', endpoint: from, linkId: link.id, bytes });
    if ((link.loss ?? 0) > 0 && this.#random.next() < (link.loss ?? 0)) {
      this.#captureDrop(frameId, from, bytes, 'loss', link.id, atNs);
      return;
    }
    const jitterMs = link.jitterMs ?? 0;
    const jitter = jitterMs === 0 ? 0 : this.#random.between(-jitterMs, jitterMs);
    const serializationMs = link.bandwidthMbps === undefined || link.bandwidthMbps <= 0
      ? 0
      : (bytes.byteLength * 8) / (link.bandwidthMbps * 1_000);
    const delayMs = Math.max(0, link.latencyMs + jitter + serializationMs);
    const visited = new Set(visitedDirections);
    visited.add(direction);
    this.#insertArrival({
      order: this.#nextArrivalOrder++,
      dueNs: atNs + millisecondsToNs(delayMs),
      frameId,
      from,
      to,
      linkId: link.id,
      bytes: bytes.slice(),
      visitedDirections: visited,
      switchHops,
    });
    this.#emitEvent({
      type: 'frame.transmitted',
      nodeId: from.nodeId,
      interfaceId: from.interfaceId,
      linkId: link.id,
      message: `Frame ${frameId} transmitted on ${link.name ?? link.id}`,
      detail: { frameId, bytes: bytes.byteLength, dueNs: atNs + millisecondsToNs(delayMs) },
      atNs,
    });
  }

  async #processArrival(arrival: PendingArrival): Promise<void> {
    if (this.#linkStates.get(arrival.linkId) !== 'up') {
      this.#captureDrop(arrival.frameId, arrival.to, arrival.bytes, 'link-down', arrival.linkId, arrival.dueNs);
      return;
    }
    if (!this.#endpointOperational(arrival.to)) {
      const reason = this.#nodeStates.get(arrival.to.nodeId) !== 'up' ? 'node-down' : 'interface-down';
      this.#captureDrop(arrival.frameId, arrival.to, arrival.bytes, reason, arrival.linkId, arrival.dueNs);
      return;
    }
    this.#captureFrame({
      frameId: arrival.frameId,
      atNs: arrival.dueNs,
      direction: 'ingress',
      endpoint: arrival.to,
      linkId: arrival.linkId,
      bytes: arrival.bytes,
    });
    const node = this.#nodes.get(arrival.to.nodeId);
    if (node?.kind === 'switch') {
      this.#forwardThroughSwitch(arrival, node);
      return;
    }
    const appliance = this.#appliances.get(arrival.to.nodeId);
    if (appliance === undefined || !appliance.active) {
      this.#captureDrop(
        arrival.frameId,
        arrival.to,
        arrival.bytes,
        'runtime-unavailable',
        arrival.linkId,
        arrival.dueNs,
      );
      return;
    }
    try {
      await appliance.runtime.deliverFrame({
        interfaceId: arrival.to.interfaceId,
        bytes: arrival.bytes.slice(),
      });
      this.#emitEvent({
        type: 'frame.delivered',
        nodeId: arrival.to.nodeId,
        interfaceId: arrival.to.interfaceId,
        linkId: arrival.linkId,
        message: `Frame ${arrival.frameId} delivered to ${node?.name ?? arrival.to.nodeId}`,
        detail: { frameId: arrival.frameId, bytes: arrival.bytes.byteLength },
        atNs: arrival.dueNs,
      });
    } catch (error) {
      this.#captureDrop(
        arrival.frameId,
        arrival.to,
        arrival.bytes,
        'runtime-error',
        arrival.linkId,
        arrival.dueNs,
      );
      this.#emitEvent({
        type: 'runtime.error',
        nodeId: arrival.to.nodeId,
        interfaceId: arrival.to.interfaceId,
        message: `Runtime rejected frame ${arrival.frameId}: ${errorMessage(error)}`,
        atNs: arrival.dueNs,
      });
      throw error;
    }
  }

  #forwardThroughSwitch(arrival: PendingArrival, node: LabNode): void {
    if (arrival.switchHops >= MAX_SWITCH_HOPS) {
      this.#captureDrop(
        arrival.frameId,
        arrival.to,
        arrival.bytes,
        'switch-loop',
        arrival.linkId,
        arrival.dueNs,
      );
      return;
    }
    const learning = this.#switchLearning.get(node.id)!;
    const source = macAt(arrival.bytes, 6);
    const destination = macAt(arrival.bytes, 0);
    if (!isMulticastMac(source)) learning.set(source, arrival.to.interfaceId);
    const learnedPort = !isMulticastMac(destination) ? learning.get(destination) : undefined;
    const outputInterfaces = learnedPort === undefined
      ? node.interfaces.filter((networkInterface) => networkInterface.id !== arrival.to.interfaceId)
      : node.interfaces.filter(
          (networkInterface) =>
            networkInterface.id === learnedPort && networkInterface.id !== arrival.to.interfaceId,
        );
    for (const networkInterface of outputInterfaces) {
      const endpoint = { nodeId: node.id, interfaceId: networkInterface.id };
      if (!this.#endpointOperational(endpoint)) continue;
      this.#sendAcrossLink(
        arrival.frameId,
        endpoint,
        arrival.bytes,
        new Set(arrival.visitedDirections),
        arrival.switchHops + 1,
        arrival.dueNs,
      );
    }
  }

  #handleRuntimeEvent(nodeId: string, event: ApplianceObservedEvent): void {
    const copied = copyObservedEvent(event);
    this.#emitEvent({
      type: 'runtime.event',
      nodeId,
      message: runtimeEventMessage(copied),
      runtimeEvent: copied,
    });
    if (copied.type === 'lifecycle' && copied.state === 'failed') {
      const entry = this.#appliances.get(nodeId);
      if (entry !== undefined) {
        entry.active = false;
        entry.nextDeadlineNs = null;
      }
      if (this.#state === 'running' || this.#state === 'starting') {
        const failedDuringStartup = this.#state === 'starting';
        this.#cancelTimer();
        this.#transition('failed', `Native appliance ${nodeId} failed${copied.detail ? `: ${copied.detail}` : ''}`);
        if (!failedDuringStartup) void this.#beginFailureCleanup(`native appliance ${nodeId} failed`);
      }
    }
    if (copied.type !== 'terminal-output') return;
    const key = runtimeTerminalKey(nodeId, copied.sessionId);
    const engineSessionId = this.#runtimeTerminalIds.get(key);
    if (engineSessionId !== undefined) {
      this.#publishTerminalOutput(engineSessionId, copied.data);
      return;
    }
    const pending = this.#pendingTerminalOutput.get(key) ?? [];
    pending.push(copied.data.slice());
    this.#pendingTerminalOutput.set(key, pending);
  }

  #publishTerminalOutput(sessionId: string, data: Uint8Array): void {
    const terminal = this.#terminals.get(sessionId);
    if (terminal === undefined) return;
    const output: NativeTerminalOutput = {
      sessionId,
      nodeId: terminal.session.nodeId,
      terminal: terminal.session.terminal,
      atNs: this.#nowNs,
      data: data.slice(),
    };
    terminal.onOutput?.({ ...output, data: output.data.slice() });
    this.#options.onTerminalOutput?.({ ...output, data: output.data.slice() });
  }

  async #driveTo(targetNs: bigint): Promise<void> {
    if (targetNs < this.#nowNs) throw new RangeError('Native lab time cannot move backwards');
    let processed = 0;
    while (true) {
      const nextNs = this.#nextWakeNs();
      if (nextNs === null || nextNs > targetNs) break;
      if (nextNs > this.#nowNs) this.#nowNs = nextNs;
      processed += await this.#runCurrentTime();
      if (processed > this.#options.maxEventsPerAdvance) {
        throw new Error(`Native engine event limit (${this.#options.maxEventsPerAdvance}) reached`);
      }
    }
    this.#nowNs = targetNs;
    processed += await this.#runCurrentTime();
    if (processed > this.#options.maxEventsPerAdvance) {
      throw new Error(`Native engine event limit (${this.#options.maxEventsPerAdvance}) reached`);
    }
  }

  async #runCurrentTime(): Promise<number> {
    let processed = 0;
    const immediateCounts = new Map<string, number>();
    while (true) {
      let didWork = false;
      while ((this.#pendingArrivals[0]?.dueNs ?? this.#nowNs + 1n) <= this.#nowNs) {
        const arrival = this.#pendingArrivals.shift();
        if (arrival === undefined) break;
        await this.#processArrival(arrival);
        processed += 1;
        didWork = true;
      }
      for (const [nodeId, entry] of this.#appliances) {
        if (!entry.active || entry.nextDeadlineNs === null || entry.nextDeadlineNs > this.#nowNs) continue;
        const result = await entry.runtime.step({
          nowNs: this.#nowNs,
          maxWorkItems: this.#options.maxWorkItemsPerStep,
        });
        processed += Math.max(1, result.workItems);
        didWork = true;
        if (result.nextDeadlineNs !== null && result.nextDeadlineNs < this.#nowNs) {
          throw new Error(
            `Runtime ${entry.descriptor.runtimeId} returned a deadline in the past for ${nodeId}`,
          );
        }
        if (result.hasImmediateWork) {
          const count = (immediateCounts.get(nodeId) ?? 0) + 1;
          immediateCounts.set(nodeId, count);
          if (count > this.#options.maxImmediateSteps) {
            throw new Error(
              `Runtime ${entry.descriptor.runtimeId} exceeded the immediate-step limit ` +
              `(${this.#options.maxImmediateSteps})`,
            );
          }
          entry.nextDeadlineNs = this.#nowNs;
        } else {
          entry.nextDeadlineNs = result.nextDeadlineNs;
          immediateCounts.set(nodeId, 0);
        }
      }
      if (!didWork) break;
      if (processed > this.#options.maxEventsPerAdvance) break;
      const dueArrival = this.#pendingArrivals[0]?.dueNs !== undefined &&
        this.#pendingArrivals[0].dueNs <= this.#nowNs;
      const dueRuntime = [...this.#appliances.values()].some(
        (entry) => entry.active && entry.nextDeadlineNs !== null && entry.nextDeadlineNs <= this.#nowNs,
      );
      if (!dueArrival && !dueRuntime) break;
    }
    return processed;
  }

  #nextWakeNs(): bigint | null {
    let next = this.#pendingArrivals[0]?.dueNs ?? null;
    for (const entry of this.#appliances.values()) {
      if (!entry.active || entry.nextDeadlineNs === null) continue;
      if (next === null || entry.nextDeadlineNs < next) next = entry.nextDeadlineNs;
    }
    return next;
  }

  #insertArrival(arrival: PendingArrival): void {
    let low = 0;
    let high = this.#pendingArrivals.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const current = this.#pendingArrivals[middle]!;
      if (current.dueNs < arrival.dueNs || (current.dueNs === arrival.dueNs && current.order < arrival.order)) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    this.#pendingArrivals.splice(low, 0, arrival);
  }

  #scheduleAutomaticWake(): void {
    if (!this.#options.autoRun || this.#state !== 'running') return;
    const next = this.#nextWakeNs();
    if (next === null) {
      this.#cancelTimer();
      return;
    }
    if (this.#timer !== null) {
      if (this.#timerDueNs !== null && this.#timerDueNs <= next) return;
      this.#cancelTimer();
    }
    const delayMs = Math.max(0, Number(next - this.#projectedWallNowNs()) / 1_000_000);
    const setTimer = this.#options.setTimer ?? ((callback: () => void, delay: number) => setTimeout(callback, delay));
    this.#timerDueNs = next;
    this.#timer = setTimer(() => {
      this.#timer = null;
      this.#timerDueNs = null;
      void this.#enqueueDrive(async () => {
        try {
          await this.#advanceFromWallClock();
        } catch (error) {
          this.#transition('failed', errorMessage(error));
          this.#cancelTimer();
          return;
        }
        this.#scheduleAutomaticWake();
      });
    }, Math.min(delayMs, 2_147_483_647));
  }

  async #advanceFromWallClock(): Promise<void> {
    const wallNow = this.#wallNowMs();
    const elapsed = Math.max(0, wallNow - this.#wallLastMs);
    this.#wallLastMs = wallNow;
    await this.#driveTo(this.#nowNs + millisecondsToNs(elapsed));
  }

  #cancelTimer(): void {
    if (this.#timer === null) {
      this.#timerDueNs = null;
      return;
    }
    const clearTimer = this.#options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    clearTimer(this.#timer);
    this.#timer = null;
    this.#timerDueNs = null;
  }

  #wallNowMs(): number {
    return (this.#options.wallNowMs ?? (() => performance.now()))();
  }

  #projectedWallNowNs(): bigint {
    if (!this.#options.autoRun || this.#state !== 'running') return this.#nowNs;
    const elapsed = Math.max(0, this.#wallNowMs() - this.#wallLastMs);
    return this.#nowNs + millisecondsToNs(elapsed);
  }

  #enqueueDrive(operation: () => Promise<void>): Promise<void> {
    const result = this.#driveTail.then(operation, operation);
    this.#driveTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #applyEffectiveInterfaceState(endpoint: LinkEndpoint): Promise<void> {
    const entry = this.#appliances.get(endpoint.nodeId);
    if (entry === undefined || entry.runtime.state === 'new' || entry.runtime.state === 'disposed') return;
    await entry.runtime.setInterfaceState(endpoint.interfaceId, this.#endpointOperational(endpoint));
  }

  #endpointOperational(endpoint: LinkEndpoint): boolean {
    if (this.#nodeStates.get(endpoint.nodeId) !== 'up') return false;
    if (this.#interfaceStates.get(endpointKeyOf(endpoint)) !== 'up') return false;
    const link = this.#linkByEndpoint.get(endpointKeyOf(endpoint));
    return link === undefined || this.#linkStates.get(link.id) === 'up';
  }

  #clearLearningForLink(link: LabLink): void {
    for (const endpoint of link.endpoints) this.#clearLearningForEndpoint(endpoint);
  }

  #clearLearningForEndpoint(endpoint: LinkEndpoint): void {
    const node = this.#nodes.get(endpoint.nodeId);
    if (node?.kind === 'switch') this.#switchLearning.get(node.id)?.clear();
  }

  #captureFrame(input: {
    frameId: number;
    atNs: bigint;
    direction: NativeCapturedFrame['direction'];
    endpoint: LinkEndpoint;
    bytes: Uint8Array;
    linkId?: string;
    dropReason?: NativeFrameDropReason;
  }): void {
    const frame: NativeCapturedFrame = {
      sequence: ++this.#frameSequence,
      frameId: input.frameId,
      atNs: input.atNs,
      direction: input.direction,
      nodeId: input.endpoint.nodeId,
      interfaceId: input.endpoint.interfaceId,
      ...(input.linkId === undefined ? {} : { linkId: input.linkId }),
      bytes: input.bytes.slice(),
      ...(input.dropReason === undefined ? {} : { dropReason: input.dropReason }),
    };
    this.#frames.push(frame);
    this.#options.onFrame?.(copyCapturedFrame(frame));
  }

  #captureDrop(
    frameId: number,
    endpoint: LinkEndpoint,
    bytes: Uint8Array,
    reason: NativeFrameDropReason,
    linkId?: string,
    atNs = this.#nowNs,
  ): void {
    this.#captureFrame({
      frameId,
      atNs,
      direction: 'dropped',
      endpoint,
      bytes,
      ...(linkId === undefined ? {} : { linkId }),
      dropReason: reason,
    });
    this.#emitEvent({
      type: 'frame.dropped',
      nodeId: endpoint.nodeId,
      interfaceId: endpoint.interfaceId,
      ...(linkId === undefined ? {} : { linkId }),
      message: `Frame ${frameId} dropped: ${reason}`,
      detail: { frameId, reason, bytes: bytes.byteLength },
      atNs,
    });
  }

  #emitEvent(
    input: Omit<NativeLabEvent, 'sequence' | 'atNs'> & { readonly atNs?: bigint },
  ): void {
    const event: NativeLabEvent = {
      ...input,
      sequence: ++this.#eventSequence,
      atNs: input.atNs ?? this.#nowNs,
    };
    this.#events.push(event);
    this.#options.onEvent?.(copyLabEvent(event));
  }

  #transition(state: NativeLabEngineState, message: string): void {
    this.#state = state;
    this.#emitEvent({ type: 'engine.state', message, detail: { state } });
  }

  #requireAppliance(nodeId: string): ApplianceEntry {
    const entry = this.#appliances.get(nodeId);
    if (entry === undefined) throw new Error(`Node ${nodeId} has no native appliance`);
    return entry;
  }

  #requireTerminal(sessionId: string): TerminalEntry {
    const terminal = this.#terminals.get(sessionId);
    if (terminal === undefined) throw new Error(`Unknown native terminal session: ${sessionId}`);
    return terminal;
  }

  #expectState(...states: NativeLabEngineState[]): void {
    if (!states.includes(this.#state)) {
      throw new Error(`Invalid native lab state ${this.#state}; expected ${states.join(' or ')}`);
    }
  }

  #expectUsable(): void {
    this.#expectState('running', 'paused', 'stopped');
  }

  #beginFailureCleanup(reason: string): Promise<void> {
    this.#failureCleanup ??= this.#disposeAppliancesAfterFailure(reason);
    return this.#failureCleanup;
  }

  async #disposeAppliancesAfterFailure(reason: string): Promise<void> {
    for (const entry of this.#appliances.values()) {
      try {
        if (entry.runtime.state === 'running') await entry.runtime.stop(reason);
        await entry.runtime.dispose();
      } catch {
        // The original startup error remains authoritative.
      }
    }
    this.#appliances.clear();
  }
}

function endpointKey(nodeId: string, interfaceId: string): string {
  return `${nodeId}\u0000${interfaceId}`;
}

function endpointKeyOf(endpoint: LinkEndpoint): string {
  return endpointKey(endpoint.nodeId, endpoint.interfaceId);
}

function otherEndpoint(link: LabLink, from: LinkEndpoint): LinkEndpoint {
  const [first, second] = link.endpoints;
  return first.nodeId === from.nodeId && first.interfaceId === from.interfaceId ? second : first;
}

function millisecondsToNs(milliseconds: number): bigint {
  return BigInt(Math.round(milliseconds * 1_000_000));
}

function macAt(bytes: Uint8Array, offset: number): string {
  return [...bytes.slice(offset, offset + 6)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join(':');
}

function isMulticastMac(mac: string): boolean {
  if (mac === BROADCAST_MAC) return true;
  return (Number.parseInt(mac.slice(0, 2), 16) & 1) === 1;
}

function runtimeTerminalKey(nodeId: string, runtimeSessionId: string): string {
  return `${nodeId}\u0000${runtimeSessionId}`;
}

function runtimeEventMessage(event: ApplianceObservedEvent): string {
  if (event.type === 'lifecycle') return `Appliance lifecycle: ${event.state}${event.detail ? ` (${event.detail})` : ''}`;
  if (event.type === 'log') return `${event.source}: ${event.message}`;
  if (event.type === 'file-changed') return `Appliance file changed: ${event.path}`;
  if (event.type === 'terminal-output') return `Terminal output on ${event.sessionId}`;
  return `Appliance inspection revision ${event.revision}`;
}

function copyObservedEvent(event: ApplianceObservedEvent): ApplianceObservedEvent {
  if (event.type === 'terminal-output') return { ...event, data: event.data.slice() };
  if (event.type === 'file-changed') return { ...event, contents: event.contents.slice() };
  return { ...event };
}

function copyCapturedFrame(frame: NativeCapturedFrame): NativeCapturedFrame {
  return { ...frame, bytes: frame.bytes.slice() };
}

function copyLabEvent(event: NativeLabEvent): NativeLabEvent {
  return {
    ...event,
    ...(event.runtimeEvent === undefined ? {} : { runtimeEvent: copyObservedEvent(event.runtimeEvent) }),
    ...(event.detail === undefined ? {} : { detail: { ...event.detail } }),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
