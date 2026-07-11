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
  type ApplianceLifecycleState,
  type ApplianceRuntime,
  type ApplianceRuntimeDescriptor,
  type ApplianceStepRequest,
  type ApplianceStepResult,
  type ApplianceTerminalOpenRequest,
} from '../abi';
import type { ApplianceRuntimeFactory } from '../registry';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Explicit development fallback. It does not parse BIRD configuration or run
 * routing protocols and must never be presented as a native BIRD appliance.
 */
export const BIRD_COMPATIBILITY_RUNTIME_DESCRIPTOR: ApplianceRuntimeDescriptor = {
  runtimeId: 'bird-compatibility-v1',
  displayName: 'BIRD compatibility shell (no daemon)',
  kind: 'bird',
  fidelity: 'compatibility',
  upstreamVersion: null,
  buildId: 'compatibility-v1',
  runtimeApiVersion: APPLIANCE_RUNTIME_API_VERSION,
  hostAbiVersion: APPLIANCE_HOST_ABI_VERSION,
  capabilities: {
    ethernet: false,
    ipv4: false,
    ipv6: false,
    nativeConfig: false,
    packetCapture: false,
    terminals: ['compat-shell'],
    protocols: [],
  },
  limitations: [
    'Does not contain or execute BIRD',
    'Does not parse or validate bird.conf',
    'Does not establish routing sessions',
    'Does not forward Ethernet frames',
  ],
};

interface TerminalSession {
  pending: string;
}

export class BirdCompatibilityRuntime implements ApplianceRuntime {
  readonly apiVersion = APPLIANCE_RUNTIME_API_VERSION;
  readonly descriptor = BIRD_COMPATIBILITY_RUNTIME_DESCRIPTOR;
  #state: ApplianceLifecycleState = 'new';
  #host: ApplianceHostV1 | null = null;
  #files = new Map<string, ApplianceFile>();
  #interfaces: ApplianceInterfaceSpec[] = [];
  #terminals = new Map<string, TerminalSession>();
  #nextTerminalId = 1;
  #revision = 0;
  #warnedAboutFrames = false;

  get state(): ApplianceLifecycleState {
    return this.#state;
  }

  async initialize(request: ApplianceBootRequest, host: ApplianceHostV1): Promise<ApplianceBootResult> {
    this.#expectState('new');
    if (host.abiVersion !== APPLIANCE_HOST_ABI_VERSION) {
      throw new Error(
        `Host ABI ${host.abiVersion} is incompatible with ${APPLIANCE_HOST_ABI_VERSION}`,
      );
    }

    this.#host = host;
    this.#files = new Map(request.files.map((file) => [file.path, copyFile(file)]));
    this.#interfaces = request.interfaces.map(copyInterface);
    this.#transition('initialized', 'Explicit compatibility runtime initialized; BIRD is not running');
    this.#emitLog(
      'warning',
      'This is the compatibility shell only. Configuration and protocol behavior are not being validated by BIRD.',
    );

    return { state: 'initialized', warnings: [...this.descriptor.limitations] };
  }

  async start(): Promise<void> {
    this.#expectState('initialized', 'stopped');
    this.#transition('running');
  }

  async step(request: ApplianceStepRequest): Promise<ApplianceStepResult> {
    this.#expectState('running');
    if (request.maxWorkItems < 1) throw new Error('maxWorkItems must be positive');
    if (request.nowNs < 0n) throw new Error('nowNs must not be negative');
    return {
      state: this.#state,
      workItems: 0,
      nextDeadlineNs: null,
      hasImmediateWork: false,
    };
  }

  async deliverFrame(_frame: ApplianceFrame): Promise<void> {
    this.#expectState('running');
    if (!this.#warnedAboutFrames) {
      this.#warnedAboutFrames = true;
      this.#emitLog('warning', 'Dropped frame: the compatibility runtime has no network stack');
    }
  }

  async setInterfaceState(interfaceId: string, up: boolean): Promise<void> {
    this.#expectUsable();
    const index = this.#interfaces.findIndex((candidate) => candidate.id === interfaceId);
    const current = this.#interfaces[index];
    if (index < 0 || current === undefined) throw new Error(`Unknown interface: ${interfaceId}`);
    this.#interfaces[index] = { ...current, up };
    this.#inspectionChanged();
  }

  async writeFile(file: ApplianceFile): Promise<void> {
    this.#expectUsable();
    assertAbsolutePath(file.path);
    const stored = copyFile(file);
    this.#files.set(file.path, stored);
    this.#host?.emitEvent({
      type: 'file-changed',
      path: stored.path,
      contents: stored.contents.slice(),
      mode: stored.mode ?? 0o644,
    });
    this.#inspectionChanged();
  }

  async readFile(path: string): Promise<ApplianceFile | null> {
    this.#expectUsable();
    const file = this.#files.get(path);
    return file === undefined ? null : copyFile(file);
  }

  async openTerminal(request: ApplianceTerminalOpenRequest): Promise<string> {
    this.#expectUsable();
    if (request.terminal !== 'compat-shell') {
      throw new Error(`Unsupported compatibility terminal: ${request.terminal}`);
    }
    if (request.columns < 1 || request.rows < 1) throw new Error('Terminal dimensions must be positive');

    const sessionId = `compat-${this.#nextTerminalId++}`;
    this.#terminals.set(sessionId, { pending: '' });
    this.#terminalOutput(
      sessionId,
      'Compatibility shell — BIRD is NOT running. Type "help" for supported commands.\r\ncompat> ',
    );
    return sessionId;
  }

  async writeTerminal(sessionId: string, data: Uint8Array): Promise<void> {
    this.#expectUsable();
    const session = this.#terminals.get(sessionId);
    if (session === undefined) throw new Error(`Unknown terminal session: ${sessionId}`);
    session.pending += decoder
      .decode(data, { stream: true })
      .replaceAll('\r\n', '\n')
      .replaceAll('\r', '\n');

    let newline = session.pending.indexOf('\n');
    while (newline >= 0) {
      const command = session.pending.slice(0, newline).trim();
      session.pending = session.pending.slice(newline + 1);
      this.#runCommand(sessionId, command);
      newline = session.pending.indexOf('\n');
    }
  }

  async resizeTerminal(sessionId: string, columns: number, rows: number): Promise<void> {
    this.#expectUsable();
    if (!this.#terminals.has(sessionId)) throw new Error(`Unknown terminal session: ${sessionId}`);
    if (columns < 1 || rows < 1) throw new Error('Terminal dimensions must be positive');
  }

  async closeTerminal(sessionId: string): Promise<void> {
    this.#expectUsable();
    if (!this.#terminals.delete(sessionId)) throw new Error(`Unknown terminal session: ${sessionId}`);
  }

  async inspect(): Promise<ApplianceInspectionSnapshot> {
    this.#expectUsable();
    return {
      revision: this.#revision,
      lifecycle: this.#state,
      interfaces: this.#interfaces.map(copyInterface),
      routes: [],
      protocols: [],
    };
  }

  async stop(reason?: string): Promise<void> {
    this.#expectState('running');
    this.#transition('stopped', reason);
  }

  async dispose(): Promise<void> {
    if (this.#state === 'disposed') return;
    this.#terminals.clear();
    this.#files.clear();
    this.#interfaces = [];
    this.#transition('disposed');
    this.#host = null;
  }

  #runCommand(sessionId: string, command: string): void {
    if (command === '' || command === 'help') {
      this.#terminalOutput(
        sessionId,
        'Commands: help, status, files, cat <absolute-path>\r\nNo birdc commands are available.\r\ncompat> ',
      );
      return;
    }
    if (command === 'status') {
      this.#terminalOutput(sessionId, `Runtime: compatibility (BIRD is NOT running)\r\nState: ${this.#state}\r\ncompat> `);
      return;
    }
    if (command === 'files') {
      const paths = [...this.#files.keys()].sort();
      this.#terminalOutput(sessionId, `${paths.join('\r\n') || '(no files)'}\r\ncompat> `);
      return;
    }
    if (command.startsWith('cat ')) {
      const path = command.slice(4).trim();
      const file = this.#files.get(path);
      this.#terminalOutput(
        sessionId,
        file === undefined
          ? `cat: ${path}: no such file\r\ncompat> `
          : `${decoder.decode(file.contents)}\r\ncompat> `,
      );
      return;
    }

    this.#terminalOutput(
      sessionId,
      `${command}: unavailable; this fallback does not execute BIRD\r\ncompat> `,
    );
  }

  #terminalOutput(sessionId: string, output: string): void {
    this.#host?.emitEvent({ type: 'terminal-output', sessionId, data: encoder.encode(output) });
  }

  #inspectionChanged(): void {
    this.#revision += 1;
    this.#host?.emitEvent({ type: 'inspection-changed', revision: this.#revision });
  }

  #emitLog(level: 'warning' | 'info', message: string): void {
    this.#host?.emitEvent({ type: 'log', level, source: 'compatibility-runtime', message });
  }

  #transition(state: ApplianceLifecycleState, detail?: string): void {
    this.#state = state;
    this.#host?.emitEvent({ type: 'lifecycle', state, ...(detail === undefined ? {} : { detail }) });
    this.#inspectionChanged();
  }

  #expectState(...states: ApplianceLifecycleState[]): void {
    if (!states.includes(this.#state)) {
      throw new Error(`Invalid appliance state ${this.#state}; expected ${states.join(' or ')}`);
    }
  }

  #expectUsable(): void {
    this.#expectState('initialized', 'running', 'stopped');
  }
}

export const birdCompatibilityRuntimeFactory: ApplianceRuntimeFactory = {
  descriptor: BIRD_COMPATIBILITY_RUNTIME_DESCRIPTOR,
  create: () => new BirdCompatibilityRuntime(),
};

function assertAbsolutePath(path: string): void {
  if (!path.startsWith('/') || path.includes('/../') || path.endsWith('/..')) {
    throw new Error(`Appliance file path must be absolute and normalized: ${path}`);
  }
}

function copyFile(file: ApplianceFile): ApplianceFile {
  assertAbsolutePath(file.path);
  return { path: file.path, contents: file.contents.slice(), ...(file.mode === undefined ? {} : { mode: file.mode }) };
}

function copyInterface(value: ApplianceInterfaceSpec): ApplianceInterfaceSpec {
  return { ...value, addresses: value.addresses.map((address) => ({ ...address })) };
}
