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
} from '../abi';
import type { ApplianceRuntimeFactory } from '../registry';
import {
  type V86Emulator,
  type V86EmulatorFactory,
  loadV86PackageFactory,
} from './emulator';
import { addLabVlanTag, removeLabVlanTag } from './ethernet';
import {
  PINNED_BIRD_VERSION,
  PINNED_FRR_VERSION,
  V86_IMAGE_BUILD_ID,
  type V86ArtifactSource,
  type VerifiedV86ArtifactBundle,
  loadVerifiedV86Artifacts,
  sha256Hex,
} from './manifest';
import { assertNormalizedAbsolutePath, createUstarArchive, readUstarArchive } from './tar';

const BOOTSTRAP_ARCHIVE_PATH = '/anycastlab-bootstrap.tar';
const INPUT_ARCHIVE_PATH = '/anycastlab-in.tar';
const OUTPUT_ARCHIVE_PATH = '/anycastlab-out.tar';
const CONTROL_PROTOCOL = 'ANYCASTLAB/1';
const LAB_VLAN_BASE = 100;
const MAX_SERIAL_BACKLOG = 64 * 1024;
const PGO_GENERATE_GUEST_BOOT_TIMEOUT_MS = 300_000;
const PGO_COLLECTION_TIMEOUT_MS = 300_000;
const GUEST_READINESS_ATTEMPTS = 480;
const MAX_PGO_RAW_PROFILE_BYTES = 64 * 1024 * 1024;
const MAX_PGO_PROFILE_ARCHIVE_BYTES = MAX_PGO_RAW_PROFILE_BYTES + 1024 * 1024;
const MAX_PGO_PROFILE_ENTRIES = 128;
const TAR_BLOCK_SIZE = 512;
const PGO_PROFILE_PATH = /^\/daemon-(bird|frr)_[A-Za-z0-9][A-Za-z0-9._-]*\.profraw$/;
const encoder = new TextEncoder();

export type V86ApplianceKind = Extract<ApplianceKind, 'bird' | 'frr' | 'client'>;

export interface V86ApplianceSnapshot {
  readonly schemaVersion: 1;
  readonly runtimeId: string;
  readonly buildId: string;
  readonly manifestSha256: string;
  readonly emulatorState: Uint8Array;
  readonly files: readonly ApplianceFile[];
  readonly interfaces: readonly ApplianceInterfaceSpec[];
}

export interface V86PgoProfileFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface V86PgoProfileCollection {
  /** Byte-exact archive exported by the guest for host-side llvm-profdata. */
  readonly archive: Uint8Array;
  readonly files: readonly V86PgoProfileFile[];
}

/** Optional training-only extension; deliberately not part of the appliance ABI. */
export interface PgoCollectibleRuntime {
  collectPgoProfiles(): Promise<V86PgoProfileCollection>;
}

export function isPgoCollectibleRuntime(
  runtime: ApplianceRuntime,
): runtime is ApplianceRuntime & PgoCollectibleRuntime {
  return (
    (runtime.descriptor.kind === 'bird' || runtime.descriptor.kind === 'frr') &&
    typeof (runtime as ApplianceRuntime & Partial<PgoCollectibleRuntime>).collectPgoProfiles === 'function'
  );
}

export interface V86RuntimeDependencies {
  readonly artifactSource: V86ArtifactSource;
  readonly loadArtifacts?: (source: V86ArtifactSource) => Promise<VerifiedV86ArtifactBundle>;
  readonly emulatorFactory?: V86EmulatorFactory;
  readonly loadEmulatorFactory?: () => Promise<V86EmulatorFactory>;
  readonly createObjectUrl?: (contents: Uint8Array, mediaType: string) => string;
  readonly revokeObjectUrl?: (url: string) => void;
  readonly bootTimeoutMs?: number;
  readonly controlTimeoutMs?: number;
  readonly pgoCollectionTimeoutMs?: number;
}

interface ControlWaiter {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

interface TerminalSession {
  readonly id: string;
}

const NATIVE_LIMITATIONS = [
  'v86 advances on browser wall-clock time rather than the deterministic lab clock',
  'All guest interfaces are multiplexed over a private 802.1Q trunk to v86 net0',
  'The guest is 32-bit i686 because v86 does not emulate x86-64 CPU extensions',
  'Snapshots require the exact same v86 package, VM image build, and artifact manifest',
  'The appliance is isolated from the public Internet; only lab Ethernet frames are delivered',
] as const;

export function v86RuntimeDescriptor(kind: V86ApplianceKind): ApplianceRuntimeDescriptor {
  const bird = kind === 'bird';
  const client = kind === 'client';
  return {
    runtimeId: bird ? 'bird-2.15.1-v86' : client ? 'linux-client-v86' : 'frr-10.5.1-v86',
    displayName: bird ? 'BIRD 2.15.1 (Linux VM)' : client ? 'Linux client (VM)' : 'FRRouting 10.5.1 (Linux VM)',
    kind,
    fidelity: 'native',
    upstreamVersion: bird ? PINNED_BIRD_VERSION : client ? null : PINNED_FRR_VERSION,
    buildId: V86_IMAGE_BUILD_ID,
    runtimeApiVersion: APPLIANCE_RUNTIME_API_VERSION,
    hostAbiVersion: APPLIANCE_HOST_ABI_VERSION,
    capabilities: {
      ethernet: true,
      ipv4: true,
      ipv6: true,
      nativeConfig: true,
      packetCapture: true,
      terminals: ['serial'],
      protocols: client
        ? ['ICMP']
        : bird
        ? ['BGP', 'OSPFv2', 'OSPFv3', 'BFD', 'RIP', 'Babel', 'RPKI', 'Static']
        : ['BGP', 'OSPFv2', 'OSPFv3', 'IS-IS', 'BFD', 'RIP', 'Babel', 'PIM', 'Static'],
    },
    limitations: client
      ? [...NATIVE_LIMITATIONS, 'Service addresses receive kernel ICMP; application servers must be started from the serial shell']
      : NATIVE_LIMITATIONS,
  };
}

export class V86ApplianceRuntime implements ApplianceRuntime {
  readonly apiVersion = APPLIANCE_RUNTIME_API_VERSION;
  readonly descriptor: ApplianceRuntimeDescriptor;
  readonly #dependencies: V86RuntimeDependencies;
  #state: ApplianceLifecycleState = 'new';
  #host: ApplianceHostV1 | null = null;
  #emulator: V86Emulator | null = null;
  #artifacts: VerifiedV86ArtifactBundle | null = null;
  #boot: ApplianceBootRequest | null = null;
  #files = new Map<string, ApplianceFile>();
  #interfaces: ApplianceInterfaceSpec[] = [];
  #interfaceToVlan = new Map<string, number>();
  #vlanToInterface = new Map<number, string>();
  #revision = 0;
  #hasBooted = false;
  #pendingFilePaths = new Set<string>();
  #pendingInterfaceIds = new Set<string>();
  #terminals = new Map<string, TerminalSession>();
  #nextTerminalId = 1;
  #serialBacklog: number[] = [];
  #serialPending: number[] = [];
  #serialFlushQueued = false;
  #controlBuffer = '';
  #controlWaiters = new Map<string, ControlWaiter>();
  #nextControlId = 1;
  #controlTail: Promise<void> = Promise.resolve();
  #pgoCollectionInProgress = false;
  #emulatorReady = deferred<void>();
  #guestReady = deferred<void>();
  #serialShellReady = deferred<void>();
  #serialProbeBuffer = '';
  #wasmObjectUrl: string | null = null;
  #droppedUntaggedFrameWarning = false;

  readonly #onEmulatorReady = (): void => this.#emulatorReady.resolve();
  readonly #onDownloadError = (value: unknown): void => {
    this.#emulatorReady.reject(new Error(`v86 artifact download failed: ${JSON.stringify(value)}`));
  };
  readonly #onSerialByte = (value: unknown): void => {
    if (typeof value !== 'number' || value < 0 || value > 255) return;
    this.#serialProbeBuffer = (this.#serialProbeBuffer + String.fromCharCode(value)).slice(-256);
    if (this.#serialProbeBuffer.includes('ANYCASTLAB-SHELL-READY')) this.#serialShellReady.resolve();
    this.#serialBacklog.push(value);
    if (this.#serialBacklog.length > MAX_SERIAL_BACKLOG) {
      this.#serialBacklog.splice(0, this.#serialBacklog.length - MAX_SERIAL_BACKLOG);
    }
    this.#serialPending.push(value);
    if (!this.#serialFlushQueued) {
      this.#serialFlushQueued = true;
      queueMicrotask(() => this.#flushSerialOutput());
    }
  };
  readonly #onControlBytes = (value: unknown): void => {
    if (!isUint8Array(value)) return;
    this.#controlBuffer += new TextDecoder().decode(value);
    let newline = this.#controlBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.#controlBuffer.slice(0, newline).replace(/\r$/, '');
      this.#controlBuffer = this.#controlBuffer.slice(newline + 1);
      this.#handleControlLine(line);
      newline = this.#controlBuffer.indexOf('\n');
    }
  };
  readonly #onNetworkFrame = (value: unknown): void => {
    if (!isUint8Array(value)) return;
    const decoded = removeLabVlanTag(value);
    if (decoded === null) {
      if (!this.#droppedUntaggedFrameWarning) {
        this.#droppedUntaggedFrameWarning = true;
        this.#emitLog('warning', 'Dropped an untagged frame emitted by the private v86 trunk');
      }
      return;
    }
    const interfaceId = this.#vlanToInterface.get(decoded.vlanId);
    if (interfaceId === undefined) {
      this.#emitLog('warning', `Dropped frame for unknown private VLAN ${decoded.vlanId}`);
      return;
    }
    this.#host?.transmitFrame({ interfaceId, bytes: decoded.bytes });
  };

  constructor(kind: V86ApplianceKind, dependencies: V86RuntimeDependencies) {
    this.descriptor = v86RuntimeDescriptor(kind);
    this.#dependencies = dependencies;
  }

  get state(): ApplianceLifecycleState {
    return this.#state;
  }

  async initialize(request: ApplianceBootRequest, host: ApplianceHostV1): Promise<ApplianceBootResult> {
    this.#expectState('new');
    if (host.abiVersion !== APPLIANCE_HOST_ABI_VERSION) {
      throw new Error(`Host ABI ${host.abiVersion} is incompatible with ${APPLIANCE_HOST_ABI_VERSION}`);
    }
    try {
      validateBootRequest(request);
      this.#host = host;
      this.#boot = copyBootRequest(request);
      this.#files = new Map(request.files.map((file) => [file.path, copyFile(file)]));
      this.#interfaces = request.interfaces.map(copyInterface);
      this.#rebuildVlanMap();

      const loadArtifacts = this.#dependencies.loadArtifacts ?? loadVerifiedV86Artifacts;
      this.#artifacts = await loadArtifacts(this.#dependencies.artifactSource);
      this.#assertArtifactCompatibility();
      const maximumMtu = Math.max(0, ...this.#interfaces.map((candidate) => candidate.mtu + 4));
      if (maximumMtu > this.#artifacts.manifest.machine.trunkMtu) {
        throw new Error(
          `Guest interface requires trunk MTU ${maximumMtu}; image supports ${this.#artifacts.manifest.machine.trunkMtu}`,
        );
      }

      const createObjectUrl = this.#dependencies.createObjectUrl ?? defaultCreateObjectUrl;
      this.#wasmObjectUrl = createObjectUrl(this.#artifacts.artifacts['v86-wasm'], 'application/wasm');
      const factory =
        this.#dependencies.emulatorFactory ??
        (await (this.#dependencies.loadEmulatorFactory ?? loadV86PackageFactory)());
      this.#emulator = factory({
        wasm_path: this.#wasmObjectUrl,
        memory_size: this.#artifacts.manifest.machine.memoryBytes,
        vga_memory_size: this.#artifacts.manifest.machine.vgaMemoryBytes,
        bios: { buffer: toArrayBuffer(this.#artifacts.artifacts.bios) },
        vga_bios: { buffer: toArrayBuffer(this.#artifacts.artifacts['vga-bios']) },
        bzimage: { buffer: toArrayBuffer(this.#artifacts.artifacts.bzimage) },
        cmdline:
          'console=ttyS0,115200n8 tsc=reliable mitigations=off random.trust_cpu=on ' +
          'panic=-1 oops=panic net.ifnames=0',
        filesystem: {},
        net_device: { type: 'virtio', mtu: this.#artifacts.manifest.machine.trunkMtu },
        virtio_console: true,
        serial_console: { type: 'none' },
        screen: { container: null },
        autostart: false,
        disable_keyboard: true,
        disable_mouse: true,
        disable_speaker: true,
        acpi: false,
      });
      this.#installListeners();
      await withTimeout(
        this.#emulatorReady.promise,
        this.#dependencies.bootTimeoutMs ?? 120_000,
        'v86 did not become ready',
      );
      await this.#writeBootstrapArchive();
      this.#transition('initialized');
      this.#emitLog('info', `Verified and loaded ${this.#artifacts.manifest.buildId}`);
      return { state: 'initialized', warnings: [...NATIVE_LIMITATIONS] };
    } catch (error) {
      this.#transition('failed', errorMessage(error));
      throw error;
    }
  }

  async start(): Promise<void> {
    this.#expectState('initialized', 'stopped');
    const emulator = this.#requireEmulator();
    const configuredBootTimeoutMs = this.#dependencies.bootTimeoutMs ?? 120_000;
    const guestBootTimeoutMs = this.#requireArtifacts().manifest.pgo.mode === 'generate'
      ? Math.max(configuredBootTimeoutMs, PGO_GENERATE_GUEST_BOOT_TIMEOUT_MS)
      : configuredBootTimeoutMs;
    try {
      this.#transition('running');
      await emulator.run();
      await withTimeout(
        this.#guestReady.promise,
        guestBootTimeoutMs,
        `${this.descriptor.displayName} did not pass its guest readiness probe`,
      );
      await withTimeout(
        this.#serialShellReady.promise,
        guestBootTimeoutMs,
        `${this.descriptor.displayName} did not reach its serial shell`,
      );
      if (this.#state !== 'running') {
        throw new Error(`${this.descriptor.displayName} exited while completing guest startup`);
      }
      if (this.#hasBooted) await this.#applyPendingChanges();
      this.#hasBooted = true;
    } catch (error) {
      this.#transition('failed', errorMessage(error));
      throw error;
    }
  }

  async step(request: ApplianceStepRequest): Promise<ApplianceStepResult> {
    this.#expectState('running');
    if (request.maxWorkItems < 1) throw new Error('maxWorkItems must be positive');
    if (request.nowNs < 0n) throw new Error('nowNs must not be negative');
    return {
      state: this.#state,
      workItems: 0,
      // v86 is already driven by browser wall-clock time. Fabric arrivals
      // schedule their own wakeups, so polling every simulated millisecond
      // would only burn CPU while an idle lab is open.
      nextDeadlineNs: null,
      hasImmediateWork: false,
    };
  }

  async deliverFrame(frame: ApplianceFrame): Promise<void> {
    this.#expectState('running');
    const vlanId = this.#interfaceToVlan.get(frame.interfaceId);
    if (vlanId === undefined) throw new Error(`Unknown interface: ${frame.interfaceId}`);
    this.#requireEmulator().bus.send('net0-receive', addLabVlanTag(frame.bytes, vlanId));
  }

  async setInterfaceState(interfaceId: string, up: boolean): Promise<void> {
    this.#expectUsable();
    const index = this.#interfaces.findIndex((candidate) => candidate.id === interfaceId);
    const current = this.#interfaces[index];
    if (current === undefined) throw new Error(`Unknown interface: ${interfaceId}`);
    if (current.up === up) return;
    this.#interfaces[index] = { ...current, up };
    if (this.#state === 'running' && this.#hasBooted) {
      await this.#enqueueControl(async () => {
        await this.#sendControl('LINK', [encodeBase64(current.name), up ? 'up' : 'down']);
      });
    } else if (this.#state === 'initialized' && !this.#hasBooted) {
      await this.#writeBootstrapArchive();
    } else {
      this.#pendingInterfaceIds.add(interfaceId);
    }
    this.#inspectionChanged();
  }

  async writeFile(file: ApplianceFile): Promise<void> {
    this.#expectUsable();
    const stored = copyFile(file);
    if (stored.path === '/run/anycastlab/start.sh') {
      throw new Error('The appliance bootstrap script path is reserved');
    }
    if (this.#state === 'running' && this.#hasBooted) {
      await this.#enqueueControl(async () => this.#applyFile(stored));
    } else if (this.#state === 'initialized' && !this.#hasBooted) {
      this.#files.set(stored.path, stored);
      await this.#writeBootstrapArchive();
    } else {
      this.#files.set(stored.path, stored);
      this.#pendingFilePaths.add(stored.path);
    }
    this.#files.set(stored.path, stored);
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
    assertNormalizedAbsolutePath(path);
    if (this.#state === 'running' && this.#hasBooted) {
      return this.#enqueueControl(async () => {
        try {
          await this.#sendControl('READ', [encodeBase64(path)]);
        } catch (error) {
          if (errorMessage(error).includes('ENOENT')) return null;
          throw error;
        }
        const archive = await this.#requireEmulator().read_file(OUTPUT_ARCHIVE_PATH);
        const file = readUstarArchive(archive).find((candidate) => candidate.path === path);
        if (file === undefined) throw new Error(`Guest export did not contain ${path}`);
        const stored = copyFile(file);
        this.#files.set(path, stored);
        return copyFile(stored);
      });
    }
    const cached = this.#files.get(path);
    return cached === undefined ? null : copyFile(cached);
  }

  /**
   * Gracefully stop an instrumented router and export its raw LLVM profiles.
   * This is a terminal training operation: the real daemon has exited before
   * the guest acknowledges the command, and the emulator is stopped afterward.
   */
  async collectPgoProfiles(): Promise<V86PgoProfileCollection> {
    const daemonKind = this.descriptor.kind;
    if (daemonKind === 'client') {
      throw new Error('PGO profile collection is only supported for BIRD and FRR appliances');
    }
    this.#expectState('running');
    return this.#enqueueControl(async () => {
      this.#expectState('running');
      this.#pgoCollectionInProgress = true;
      try {
        await this.#sendControl(
          'COLLECT_PGO',
          [],
          this.#dependencies.pgoCollectionTimeoutMs ?? PGO_COLLECTION_TIMEOUT_MS,
        );
        const archive = await this.#requireEmulator().read_file(OUTPUT_ARCHIVE_PATH);
        const files = await validatePgoProfileArchive(archive, daemonKind);
        await this.#requireEmulator().stop();
        this.#transition('stopped', 'PGO profiles collected');
        return { archive: archive.slice(), files };
      } catch (error) {
        if (this.#state !== 'disposed' && this.#state !== 'failed') {
          this.#transition('failed', `PGO profile collection failed: ${errorMessage(error)}`);
        }
        throw error;
      } finally {
        this.#pgoCollectionInProgress = false;
      }
    });
  }

  async openTerminal(request: ApplianceTerminalOpenRequest): Promise<string> {
    this.#expectUsable();
    if (request.terminal !== 'serial') throw new Error(`Unsupported v86 terminal: ${request.terminal}`);
    if (request.columns < 1 || request.rows < 1) throw new Error('Terminal dimensions must be positive');
    const id = `serial-${this.#nextTerminalId++}`;
    this.#terminals.set(id, { id });
    if (this.#serialBacklog.length > 0) {
      this.#host?.emitEvent({
        type: 'terminal-output',
        sessionId: id,
        data: Uint8Array.from(this.#serialBacklog),
      });
    }
    return id;
  }

  async writeTerminal(sessionId: string, data: Uint8Array): Promise<void> {
    this.#expectState('running');
    if (!this.#terminals.has(sessionId)) throw new Error(`Unknown terminal session: ${sessionId}`);
    this.#requireEmulator().serial_send_bytes(0, data.slice());
  }

  async resizeTerminal(sessionId: string, columns: number, rows: number): Promise<void> {
    this.#expectUsable();
    if (!this.#terminals.has(sessionId)) throw new Error(`Unknown terminal session: ${sessionId}`);
    if (columns < 1 || rows < 1) throw new Error('Terminal dimensions must be positive');
    // ttyS0 has no window-size bus event in v86; applications still receive a faithful byte stream.
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
    await this.#requireEmulator().stop();
    this.#transition('stopped', reason);
  }

  async dispose(): Promise<void> {
    if (this.#state === 'disposed') return;
    for (const waiter of this.#controlWaiters.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error('v86 appliance was disposed'));
    }
    this.#controlWaiters.clear();
    if (this.#emulator !== null) {
      this.#removeListeners();
      await this.#emulator.destroy();
    }
    if (this.#wasmObjectUrl !== null) {
      (this.#dependencies.revokeObjectUrl ?? defaultRevokeObjectUrl)(this.#wasmObjectUrl);
      this.#wasmObjectUrl = null;
    }
    this.#terminals.clear();
    this.#transition('disposed');
    this.#emulator = null;
    this.#host = null;
  }

  /** Capture a v86 machine snapshot plus the host-side 9p configuration files. */
  async saveSnapshot(): Promise<V86ApplianceSnapshot> {
    this.#expectUsable();
    const emulator = this.#requireEmulator();
    const resume = emulator.is_running();
    if (resume) await emulator.stop();
    try {
      return {
        schemaVersion: 1,
        runtimeId: this.descriptor.runtimeId,
        buildId: this.descriptor.buildId,
        manifestSha256: this.#requireArtifacts().manifestSha256,
        emulatorState: new Uint8Array(await emulator.save_state()),
        files: [...this.#files.values()].map(copyFile),
        interfaces: this.#interfaces.map(copyInterface),
      };
    } finally {
      if (resume) await emulator.run();
    }
  }

  /** Restore only snapshots made by this exact emulator/image/artifact set. */
  async restoreSnapshot(snapshot: V86ApplianceSnapshot): Promise<void> {
    this.#expectUsable();
    if (
      snapshot.schemaVersion !== 1 ||
      snapshot.runtimeId !== this.descriptor.runtimeId ||
      snapshot.buildId !== this.descriptor.buildId ||
      snapshot.manifestSha256 !== this.#requireArtifacts().manifestSha256
    ) {
      throw new Error('Snapshot is incompatible with this v86 appliance runtime');
    }
    const expectedInterfaces = [...this.#interfaceToVlan.keys()].sort().join('\0');
    const snapshotInterfaces = snapshot.interfaces.map((candidate) => candidate.id).sort().join('\0');
    if (expectedInterfaces !== snapshotInterfaces) {
      throw new Error('Snapshot interface set does not match this appliance');
    }
    const emulator = this.#requireEmulator();
    const resume = emulator.is_running();
    if (resume) await emulator.stop();
    this.#files = new Map(snapshot.files.map((file) => [file.path, copyFile(file)]));
    this.#interfaces = snapshot.interfaces.map(copyInterface);
    await this.#writeBootstrapArchive();
    await emulator.restore_state(toArrayBuffer(snapshot.emulatorState));
    this.#inspectionChanged();
    if (resume) await emulator.run();
  }

  async #writeBootstrapArchive(): Promise<void> {
    const bootstrap = this.#requireBoot();
    const startScript: ApplianceFile = {
      path: '/run/anycastlab/start.sh',
      contents: encoder.encode(
        createGuestStartScript(
          bootstrap,
          this.#interfaces,
          this.#interfaceToVlan,
          this.#requireArtifacts().manifest.machine.trunkMtu,
          this.descriptor.kind,
        ),
      ),
      mode: 0o755,
    };
    await this.#requireEmulator().create_file(
      BOOTSTRAP_ARCHIVE_PATH,
      createUstarArchive([...this.#files.values(), startScript]),
    );
  }

  async #applyFile(file: ApplianceFile): Promise<void> {
    await this.#requireEmulator().create_file(INPUT_ARCHIVE_PATH, createUstarArchive([file]));
    await this.#sendControl('APPLY', []);
  }

  async #applyPendingChanges(): Promise<void> {
    for (const path of this.#pendingFilePaths) {
      const file = this.#files.get(path);
      if (file !== undefined) await this.#enqueueControl(async () => this.#applyFile(file));
    }
    this.#pendingFilePaths.clear();
    for (const interfaceId of this.#pendingInterfaceIds) {
      const value = this.#interfaces.find((candidate) => candidate.id === interfaceId);
      if (value !== undefined) {
        await this.#enqueueControl(async () => {
          await this.#sendControl('LINK', [encodeBase64(value.name), value.up ? 'up' : 'down']);
        });
      }
    }
    this.#pendingInterfaceIds.clear();
  }

  #sendControl(
    command: string,
    arguments_: readonly string[],
    timeoutMs = this.#dependencies.controlTimeoutMs ?? 5_000,
  ): Promise<void> {
    const id = String(this.#nextControlId++);
    const emulator = this.#requireEmulator();
    const promise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#controlWaiters.delete(id);
        reject(new Error(`Guest control command ${command} timed out`));
      }, timeoutMs);
      this.#controlWaiters.set(id, { resolve, reject, timeout });
    });
    emulator.bus.send(
      'virtio-console0-input-bytes',
      encoder.encode([CONTROL_PROTOCOL, command, id, ...arguments_].join(' ') + '\n'),
    );
    return promise;
  }

  #enqueueControl<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#controlTail.then(operation, operation);
    this.#controlTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #handleControlLine(line: string): void {
    const [protocol, status, id, ...detail] = line.split(' ');
    if (protocol !== CONTROL_PROTOCOL) return;
    if (status === 'READY') {
      this.#guestReady.resolve();
      this.#emitLog('info', 'Linux guest control agent and appliance are ready');
      return;
    }
    if (status === 'FAILED') {
      const reason = [id, ...detail].filter((value) => value !== undefined).join(' ') || 'unknown startup failure';
      const serialTail = cleanSerialTail(Uint8Array.from(this.#serialBacklog));
      const error = new Error(
        `Linux guest startup failed: ${reason}` +
        (serialTail.length === 0 ? '' : `\nGuest serial tail:\n${serialTail}`),
      );
      this.#guestReady.reject(error);
      this.#emitLog('error', error.message);
      return;
    }
    if (status === 'EXIT') {
      const reason = [id, ...detail].filter((value) => value !== undefined).join(' ') || 'appliance process exited';
      if (this.#pgoCollectionInProgress) {
        this.#emitLog('info', `Expected appliance exit during PGO collection: ${reason}`);
        return;
      }
      if (this.#state === 'running') this.#transition('failed', reason);
      else this.#emitLog('error', reason);
      return;
    }
    if (id === undefined) return;
    const waiter = this.#controlWaiters.get(id);
    if (waiter === undefined) return;
    clearTimeout(waiter.timeout);
    this.#controlWaiters.delete(id);
    if (status === 'OK') waiter.resolve();
    else waiter.reject(new Error(`Guest control error: ${detail.join(' ') || status || 'unknown error'}`));
  }

  #flushSerialOutput(): void {
    this.#serialFlushQueued = false;
    if (this.#serialPending.length === 0) return;
    const data = Uint8Array.from(this.#serialPending);
    this.#serialPending = [];
    for (const { id } of this.#terminals.values()) {
      this.#host?.emitEvent({ type: 'terminal-output', sessionId: id, data: data.slice() });
    }
  }

  #installListeners(): void {
    const emulator = this.#requireEmulator();
    emulator.add_listener('emulator-ready', this.#onEmulatorReady);
    emulator.add_listener('download-error', this.#onDownloadError);
    emulator.add_listener('serial0-output-byte', this.#onSerialByte);
    emulator.add_listener('virtio-console0-output-bytes', this.#onControlBytes);
    emulator.add_listener('net0-send', this.#onNetworkFrame);
  }

  #removeListeners(): void {
    const emulator = this.#requireEmulator();
    emulator.remove_listener('emulator-ready', this.#onEmulatorReady);
    emulator.remove_listener('download-error', this.#onDownloadError);
    emulator.remove_listener('serial0-output-byte', this.#onSerialByte);
    emulator.remove_listener('virtio-console0-output-bytes', this.#onControlBytes);
    emulator.remove_listener('net0-send', this.#onNetworkFrame);
  }

  #assertArtifactCompatibility(): void {
    const manifest = this.#requireArtifacts().manifest;
    if (manifest.buildId !== this.descriptor.buildId) throw new Error('v86 artifact build does not match runtime');
    const version = this.descriptor.kind === 'bird'
      ? manifest.daemons.bird
      : this.descriptor.kind === 'frr'
        ? manifest.daemons.frr
        : null;
    if (version !== this.descriptor.upstreamVersion) {
      throw new Error(`${this.descriptor.kind} image version ${version} does not match runtime descriptor`);
    }
  }

  #rebuildVlanMap(): void {
    this.#interfaceToVlan.clear();
    this.#vlanToInterface.clear();
    this.#interfaces.forEach((value, index) => {
      const vlanId = LAB_VLAN_BASE + index;
      this.#interfaceToVlan.set(value.id, vlanId);
      this.#vlanToInterface.set(vlanId, value.id);
    });
  }

  #transition(state: ApplianceLifecycleState, detail?: string): void {
    this.#state = state;
    this.#host?.emitEvent({ type: 'lifecycle', state, ...(detail === undefined ? {} : { detail }) });
    this.#inspectionChanged();
  }

  #inspectionChanged(): void {
    this.#revision += 1;
    this.#host?.emitEvent({ type: 'inspection-changed', revision: this.#revision });
  }

  #emitLog(level: 'info' | 'warning' | 'error', message: string): void {
    this.#host?.emitEvent({ type: 'log', level, source: 'v86-runtime', message });
  }

  #expectState(...states: ApplianceLifecycleState[]): void {
    if (!states.includes(this.#state)) {
      throw new Error(`Invalid appliance state ${this.#state}; expected ${states.join(' or ')}`);
    }
  }

  #expectUsable(): void {
    this.#expectState('initialized', 'running', 'stopped');
  }

  #requireEmulator(): V86Emulator {
    if (this.#emulator === null) throw new Error('v86 emulator is not initialized');
    return this.#emulator;
  }

  #requireArtifacts(): VerifiedV86ArtifactBundle {
    if (this.#artifacts === null) throw new Error('v86 artifacts are not loaded');
    return this.#artifacts;
  }

  #requireBoot(): ApplianceBootRequest {
    if (this.#boot === null) throw new Error('v86 boot request is not initialized');
    return this.#boot;
  }
}

export function createV86RuntimeFactory(
  kind: V86ApplianceKind,
  dependencies: V86RuntimeDependencies,
): ApplianceRuntimeFactory {
  const descriptor = v86RuntimeDescriptor(kind);
  return {
    descriptor,
    create: () => new V86ApplianceRuntime(kind, dependencies),
  };
}

export function createV86RuntimeFactories(
  dependencies: V86RuntimeDependencies,
): readonly [ApplianceRuntimeFactory, ApplianceRuntimeFactory, ApplianceRuntimeFactory] {
  return [
    createV86RuntimeFactory('bird', dependencies),
    createV86RuntimeFactory('frr', dependencies),
    createV86RuntimeFactory('client', dependencies),
  ];
}

function validateBootRequest(request: ApplianceBootRequest): void {
  if (request.interfaces.length > 4095 - LAB_VLAN_BASE) {
    throw new Error(`v86 appliances support at most ${4095 - LAB_VLAN_BASE} interfaces`);
  }
  const paths = new Set<string>();
  for (const file of request.files) {
    assertNormalizedAbsolutePath(file.path);
    if (paths.has(file.path)) throw new Error(`Duplicate appliance file: ${file.path}`);
    if (file.path === '/run/anycastlab/start.sh') throw new Error('Reserved appliance file path');
    paths.add(file.path);
  }
  const interfaceIds = new Set<string>();
  const interfaceNames = new Set<string>();
  for (const value of request.interfaces) {
    if (!/^[a-zA-Z0-9_.-]{1,15}$/.test(value.name) || value.name === 'lo' || value.name === 'labtrunk0') {
      throw new Error(`Invalid or reserved Linux interface name: ${value.name}`);
    }
    if (interfaceIds.has(value.id)) throw new Error(`Duplicate interface id: ${value.id}`);
    if (interfaceNames.has(value.name)) throw new Error(`Duplicate interface name: ${value.name}`);
    if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(value.mac)) throw new Error(`Invalid MAC address: ${value.mac}`);
    if (!Number.isSafeInteger(value.mtu) || value.mtu < 576 || value.mtu > 65_531) {
      throw new Error(`Invalid interface MTU: ${value.mtu}`);
    }
    interfaceIds.add(value.id);
    interfaceNames.add(value.name);
  }
  for (const name of Object.keys(request.environment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid environment variable name: ${name}`);
  }
}

function createGuestStartScript(
  boot: ApplianceBootRequest,
  interfaces: readonly ApplianceInterfaceSpec[],
  vlanByInterface: ReadonlyMap<string, number>,
  trunkMtu: number,
  kind: V86ApplianceKind,
): string {
  const lines = [
    '#!/bin/sh',
    'set -eu',
    `hostname ${shellQuote(boot.hostname)}`,
    'ip link set lo up',
    'sysctl -q -w net.ipv4.ip_forward=1',
    'sysctl -q -w net.ipv6.conf.all.forwarding=1',
    'if [ -f /etc/anycastlab/pgo-generate ]; then',
    '  if [ -e /tmp/anycast-pgo ] || [ -L /tmp/anycast-pgo ]; then',
    '    [ -d /tmp/anycast-pgo ] && [ ! -L /tmp/anycast-pgo ] || { echo "anycastlab: unsafe PGO profile directory" >&2; exit 1; }',
    '  else',
    '    mkdir /tmp/anycast-pgo',
    '  fi',
    '  chmod 1777 /tmp/anycast-pgo',
    'fi',
  ];
  if (interfaces.length > 0) {
    lines.push(
      "physical=''",
      "for candidate in /sys/class/net/*; do candidate=${candidate##*/}; [ \"$candidate\" = lo ] || { physical=$candidate; break; }; done",
      '[ -n "$physical" ] || { echo "anycastlab: v86 NIC not found" >&2; exit 1; }',
      'ip link set "$physical" down',
      'ip link set "$physical" name labtrunk0',
      `ip link set labtrunk0 mtu ${trunkMtu} promisc on up`,
    );
    for (const value of interfaces) {
      const vlanId = vlanByInterface.get(value.id);
      if (vlanId === undefined) throw new Error(`No private VLAN allocated for ${value.id}`);
      lines.push(
        `ip link add link labtrunk0 name ${shellQuote(value.name)} type vlan id ${vlanId}`,
        `ip link set dev ${shellQuote(value.name)} address ${shellQuote(value.mac)} mtu ${value.mtu}`,
      );
      for (const address of value.addresses) {
        lines.push(
          `ip address add ${shellQuote(`${address.address}/${address.prefixLength}`)} dev ${shellQuote(value.name)}`,
        );
      }
      lines.push(`ip link set dev ${shellQuote(value.name)} ${value.up ? 'up' : 'down'}`);
    }
  }
  lines.push('(');
  for (const [name, value] of Object.entries(boot.environment).sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`  export ${name}=${shellQuote(value)}`);
  }
  if (kind !== 'client') {
    lines.push(
      '  if [ -f /etc/anycastlab/pgo-generate ]; then',
      `    export LLVM_PROFILE_FILE=${shellQuote(`/tmp/anycast-pgo/daemon-${kind}_%m_%p.profraw`)}`,
      '  fi',
    );
  }
  const command = [boot.entrypoint, ...boot.argv].map(shellQuote).join(' ');
  const readiness = kind === 'bird'
    ? "[ -S /var/run/bird.ctl ] && LLVM_PROFILE_FILE=/dev/null /usr/sbin/birdc show status >/dev/null 2>&1"
    : kind === 'frr'
      ? "[ -f /run/anycastlab/frr.ready ] && /usr/sbin/frrinit.sh status >/dev/null 2>&1"
      : 'true';
  lines.push(
    `  exec ${command}`,
    ') </dev/null >/dev/ttyS0 2>&1 &',
    'appliance_pid=$!',
    'echo "$appliance_pid" >/run/anycastlab/appliance.pid',
    'sleep 0.1',
    "ready=0",
    "attempt=0",
    `while kill -0 "$appliance_pid" 2>/dev/null && [ "$attempt" -lt ${GUEST_READINESS_ATTEMPTS} ]; do`,
    `  if ${readiness}; then ready=1; break; fi`,
    '  attempt=$((attempt + 1))',
    '  sleep 0.25',
    'done',
    'if ! kill -0 "$appliance_pid" 2>/dev/null; then',
    '  wait "$appliance_pid" || status=$?',
    '  echo "anycastlab: appliance exited during startup (status ${status:-unknown})" >&2',
    '  exit "${status:-1}"',
    'fi',
    'if [ "$ready" -ne 1 ]; then',
    '  echo "anycastlab: appliance readiness probe timed out" >&2',
    '  kill "$appliance_pid" 2>/dev/null || true',
    '  exit 1',
    'fi',
    'exit 0',
    '',
  );
  return lines.join('\n');
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function encodeBase64(value: string): string {
  const bytes = encoder.encode(value);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let result = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const combined = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    result += alphabet[(combined >>> 18) & 63];
    result += alphabet[(combined >>> 12) & 63];
    result += second === undefined ? '=' : alphabet[(combined >>> 6) & 63];
    result += third === undefined ? '=' : alphabet[combined & 63];
  }
  return result;
}

function copyFile(file: ApplianceFile): ApplianceFile {
  assertNormalizedAbsolutePath(file.path);
  return {
    path: file.path,
    contents: file.contents.slice(),
    ...(file.mode === undefined ? {} : { mode: file.mode }),
  };
}

function copyInterface(value: ApplianceInterfaceSpec): ApplianceInterfaceSpec {
  return { ...value, addresses: value.addresses.map((address) => ({ ...address })) };
}

function copyBootRequest(value: ApplianceBootRequest): ApplianceBootRequest {
  return {
    ...value,
    argv: [...value.argv],
    environment: { ...value.environment },
    files: value.files.map(copyFile),
    interfaces: value.interfaces.map(copyInterface),
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.slice().buffer as ArrayBuffer;
}

function defaultCreateObjectUrl(contents: Uint8Array, mediaType: string): string {
  return URL.createObjectURL(new Blob([toArrayBuffer(contents)], { type: mediaType }));
}

function defaultRevokeObjectUrl(url: string): void {
  URL.revokeObjectURL(url);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cleanSerialTail(bytes: Uint8Array): string {
  return new TextDecoder()
    .decode(bytes.slice(-4_096))
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '')
    .trim();
}

async function validatePgoProfileArchive(
  archive: Uint8Array,
  kind: Exclude<V86ApplianceKind, 'client'>,
): Promise<readonly V86PgoProfileFile[]> {
  if (archive.byteLength > MAX_PGO_PROFILE_ARCHIVE_BYTES) {
    throw new Error(
      `PGO profile archive exceeds ${MAX_PGO_PROFILE_ARCHIVE_BYTES} bytes`,
    );
  }
  assertBoundedUstarEntries(archive);
  const entries = readUstarArchive(archive);
  if (entries.length === 0) throw new Error('PGO profile archive contains no raw profiles');
  if (entries.length > MAX_PGO_PROFILE_ENTRIES) {
    throw new Error(`PGO profile archive contains more than ${MAX_PGO_PROFILE_ENTRIES} files`);
  }

  const paths = new Set<string>();
  let totalBytes = 0;
  const profiles: V86PgoProfileFile[] = [];
  for (const entry of entries) {
    if (!PGO_PROFILE_PATH.test(entry.path) || !entry.path.startsWith(`/daemon-${kind}_`)) {
      throw new Error(`Unexpected PGO profile archive entry: ${entry.path}`);
    }
    if (paths.has(entry.path)) throw new Error(`Duplicate PGO profile archive entry: ${entry.path}`);
    paths.add(entry.path);
    if (entry.contents.byteLength === 0) throw new Error(`PGO raw profile is empty: ${entry.path}`);
    totalBytes += entry.contents.byteLength;
    if (totalBytes > MAX_PGO_RAW_PROFILE_BYTES) {
      throw new Error(`PGO raw profiles exceed ${MAX_PGO_RAW_PROFILE_BYTES} bytes`);
    }
    profiles.push({
      path: entry.path,
      size: entry.contents.byteLength,
      sha256: await sha256Hex(entry.contents),
    });
  }
  return profiles.sort((left, right) => left.path.localeCompare(right.path));
}

/** Preflight the full archive, including directory entries omitted by readUstarArchive. */
function assertBoundedUstarEntries(archive: Uint8Array): void {
  if (archive.byteLength < TAR_BLOCK_SIZE * 2 || archive.byteLength % TAR_BLOCK_SIZE !== 0) {
    throw new Error('PGO profile archive is not a complete ustar archive');
  }
  let offset = 0;
  let entries = 0;
  while (offset + TAR_BLOCK_SIZE <= archive.byteLength) {
    const header = archive.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) {
      if (offset + TAR_BLOCK_SIZE * 2 > archive.byteLength) {
        throw new Error('PGO profile archive is missing its second end marker');
      }
      const trailer = archive.subarray(offset);
      if (!trailer.every((byte) => byte === 0)) {
        throw new Error('PGO profile archive contains data after its end marker');
      }
      return;
    }
    entries += 1;
    if (entries > MAX_PGO_PROFILE_ENTRIES) {
      throw new Error(`PGO profile archive contains more than ${MAX_PGO_PROFILE_ENTRIES} entries`);
    }
    const type = header[156];
    if (type !== 0 && type !== 0x30) {
      throw new Error('PGO profile archive contains a non-regular entry');
    }
    const size = readTarOctal(header.subarray(124, 136));
    const payloadBlocks = Math.ceil(size / TAR_BLOCK_SIZE);
    offset += TAR_BLOCK_SIZE + payloadBlocks * TAR_BLOCK_SIZE;
    if (offset > archive.byteLength) throw new Error('PGO profile archive contains a truncated entry');
  }
  throw new Error('PGO profile archive has no end marker');
}

function readTarOctal(field: Uint8Array): number {
  const value = new TextDecoder()
    .decode(field)
    .replace(/\0.*$/, '')
    .trim();
  if (!/^[0-7]+$/.test(value)) throw new Error('PGO profile archive has an invalid size field');
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('PGO profile archive entry size is out of range');
  }
  return parsed;
}

function isUint8Array(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Uint8Array]';
}
