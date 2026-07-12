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
  type ApplianceStepRequest,
  type ApplianceStepResult,
  type ApplianceTerminalOpenRequest,
} from '../abi';
import type { ApplianceRuntimeFactory } from '../registry';
import type { V86Emulator, V86EmulatorFactory } from './emulator';
import { loadV86PackageFactory } from './emulator';
import { addLabVlanTag, removeLabVlanTag } from './ethernet';
import type { VerifiedV86ArtifactBundle } from './manifest';
import { V86_IMAGE_BUILD_ID, loadVerifiedV86Artifacts } from './manifest';
import {
  SHARED_LAB_MAX_NODES,
  SHARED_LAB_VLAN_BASE,
  SHARED_LAB_VLAN_MAX,
  SharedV86BootstrapBuilder,
} from './shared-bootstrap';
import {
  MAX_SHARED_CONTROL_LINE_BYTES,
  MAX_SHARED_TERMINAL_CHUNK_BYTES,
  encodeSharedBytes,
  encodeSharedGuestCommand,
  encodeSharedText,
  parseSharedGuestMessage,
} from './shared-protocol';
import { assertNormalizedAbsolutePath, createUstarArchive, readUstarArchive } from './tar';
import {
  type PgoCollectibleRuntime,
  type V86ApplianceKind,
  type V86PgoProfileCollection,
  type V86RuntimeDependencies,
  validatePgoProfileArchive,
  validateV86BootRequest,
  v86RuntimeDescriptor,
} from './runtime';

const BOOTSTRAP_ARCHIVE_PATH = '/anycastlab-shared-bootstrap.tar';
const DEFAULT_BOOT_TIMEOUT_MS = 120_000;
const DEFAULT_CONTROL_TIMEOUT_MS = 5_000;
const PGO_CONTROL_TIMEOUT_MS = 300_000;

interface SharedNodeRecord {
  readonly slot: number;
  readonly kind: V86ApplianceKind;
  readonly host: ApplianceHostV1;
  readonly owner: SharedV86ApplianceRuntime;
  request: ApplianceBootRequest;
  readonly vlanByInterface: Map<string, number>;
  readonly interfaceByVlan: Map<number, string>;
  readonly guestTerminals: Map<number, string>;
  readiness: Deferred<void> | null;
  startupExit: Deferred<void> | null;
  startupFailure: Error | null;
  active: boolean;
}

interface ControlWaiter {
  readonly resolve: (detail: readonly string[]) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (error: unknown) => void;
}

/** One v86 Linux kernel shared by all router/client runtime facades in a lab. */
export class SharedV86Machine {
  readonly #dependencies: V86RuntimeDependencies;
  readonly #nodes = new Map<number, SharedNodeRecord>();
  readonly #vlanOwners = new Map<number, SharedNodeRecord>();
  readonly #controlWaiters = new Map<number, ControlWaiter>();
  #preparePromise: Promise<void> | null = null;
  #emulator: V86Emulator | null = null;
  #artifacts: VerifiedV86ArtifactBundle | null = null;
  #wasmObjectUrl: string | null = null;
  #nextSlot = 1;
  #nextVlan = SHARED_LAB_VLAN_BASE;
  #nextRequestId = 1;
  #controlBuffer = '';
  #controlTail: Promise<void> = Promise.resolve();
  #sealed = false;
  #failed = false;
  #failure: Error | null = null;
  #destroyed = false;
  #machineReady = deferred<void>();
  #emulatorReady = deferred<void>();

  readonly #onEmulatorReady = (): void => this.#emulatorReady.resolve();
  readonly #onDownloadError = (value: unknown): void => {
    const error = new Error(`v86 artifact download failed: ${JSON.stringify(value)}`);
    this.#emulatorReady.reject(error);
    this.#failMachine(error);
  };
  readonly #onControlBytes = (value: unknown): void => {
    if (!isUint8Array(value)) return;
    this.#controlBuffer += new TextDecoder().decode(value);
    if (new TextEncoder().encode(this.#controlBuffer).byteLength > MAX_SHARED_CONTROL_LINE_BYTES) {
      this.#failMachine(new Error('Shared guest control buffer exceeded its limit'));
      return;
    }
    let newline = this.#controlBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.#controlBuffer.slice(0, newline);
      this.#controlBuffer = this.#controlBuffer.slice(newline + 1);
      try {
        this.#handleMessage(line);
      } catch (error) {
        this.#failMachine(error instanceof Error ? error : new Error(String(error)));
      }
      newline = this.#controlBuffer.indexOf('\n');
    }
  };
  readonly #onNetworkFrame = (value: unknown): void => {
    if (!isUint8Array(value)) return;
    const decoded = removeLabVlanTag(value);
    if (decoded === null) {
      this.#logAll('warning', 'Dropped an untagged frame emitted by the shared v86 trunk');
      return;
    }
    const node = this.#vlanOwners.get(decoded.vlanId);
    const interfaceId = node?.interfaceByVlan.get(decoded.vlanId);
    if (node === undefined || interfaceId === undefined || !node.active) return;
    node.host.transmitFrame({ interfaceId, bytes: decoded.bytes });
  };

  constructor(dependencies: V86RuntimeDependencies) {
    this.#dependencies = dependencies;
  }

  /** A factory may reuse this machine only while its initial node set is still open. */
  get acceptsRegistrations(): boolean {
    return !this.#sealed && !this.#failed && !this.#destroyed;
  }

  register(
    kind: V86ApplianceKind,
    request: ApplianceBootRequest,
    host: ApplianceHostV1,
    owner: SharedV86ApplianceRuntime,
  ): SharedNodeRecord {
    if (!this.acceptsRegistrations) throw new Error('Shared v86 machine no longer accepts nodes');
    validateV86BootRequest(request);
    if (this.#nextSlot > SHARED_LAB_MAX_NODES) {
      throw new Error(`Shared v86 machine supports at most ${SHARED_LAB_MAX_NODES} nodes`);
    }
    if (this.#nextVlan + request.interfaces.length - 1 > SHARED_LAB_VLAN_MAX) {
      throw new Error(`Shared v86 machine supports at most ${SHARED_LAB_VLAN_MAX - SHARED_LAB_VLAN_BASE + 1} interfaces`);
    }
    const slot = this.#nextSlot++;
    const vlanByInterface = new Map<string, number>();
    const interfaceByVlan = new Map<number, string>();
    for (const networkInterface of request.interfaces) {
      const vlan = this.#nextVlan++;
      vlanByInterface.set(networkInterface.id, vlan);
      interfaceByVlan.set(vlan, networkInterface.id);
    }
    const node: SharedNodeRecord = {
      slot,
      kind,
      host,
      owner,
      request: copyBootRequest(request),
      vlanByInterface,
      interfaceByVlan,
      guestTerminals: new Map(),
      readiness: null,
      startupExit: null,
      startupFailure: null,
      active: false,
    };
    this.#nodes.set(slot, node);
    for (const vlan of interfaceByVlan.keys()) this.#vlanOwners.set(vlan, node);
    return node;
  }

  prepare(): Promise<void> {
    this.#preparePromise ??= this.#prepare().catch((error: unknown) => {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.#failMachine(failure);
      throw failure;
    });
    return this.#preparePromise;
  }

  async startNode(node: SharedNodeRecord, pendingFiles: readonly ApplianceFile[] = []): Promise<void> {
    await this.prepare();
    this.#throwIfFailed();
    const emulator = this.#requireEmulator();
    if (!this.#sealed) {
      try {
        await emulator.create_file(BOOTSTRAP_ARCHIVE_PATH, this.#createBootstrapArchive());
        this.#sealed = true;
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        this.#failMachine(failure);
        throw failure;
      }
    }
    if (!emulator.is_running()) await emulator.run();
    await withTimeout(
      this.#machineReady.promise,
      this.#dependencies.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS,
      'Shared v86 Linux supervisor did not become ready',
    );
    this.#throwIfFailed();
    for (const file of pendingFiles) await this.applyFile(node, file);
    const timeoutMs = this.#dependencies.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS;
    node.readiness = deferred<void>();
    node.startupExit = deferred<void>();
    node.startupFailure = null;
    try {
      await this.#control('NODE_START', node.slot, [], timeoutMs, node.startupExit.promise);
      await withTimeout(
        node.readiness.promise,
        timeoutMs,
        `Shared v86 node ${node.slot} did not become ready`,
      );
      if (node.startupFailure !== null) throw node.startupFailure;
      for (const networkInterface of node.request.interfaces) {
        await this.#control(
          'LINK',
          node.slot,
          [encodeSharedText(networkInterface.name), networkInterface.up ? 'up' : 'down'],
          undefined,
          node.startupExit.promise,
        );
        if (node.startupFailure !== null) throw node.startupFailure;
      }
      node.active = true;
    } catch (error) {
      node.active = false;
      if (this.#emulator?.is_running()) {
        await this.#control('NODE_STOP', node.slot, []).catch(() => undefined);
      }
      throw error;
    } finally {
      node.readiness = null;
      node.startupExit = null;
    }
  }

  async stopNode(node: SharedNodeRecord): Promise<void> {
    if (!node.active) return;
    await this.#control('NODE_STOP', node.slot, []);
    node.active = false;
    node.guestTerminals.clear();
    if (![...this.#nodes.values()].some((candidate) => candidate.active)) {
      await this.#requireEmulator().stop();
    }
  }

  async disposeNode(node: SharedNodeRecord): Promise<void> {
    const failures: string[] = [];
    if (node.active) {
      try {
        await this.stopNode(node);
      } catch (error) {
        failures.push(errorMessage(error));
        node.active = false;
        node.guestTerminals.clear();
      }
    }
    if (this.#emulator?.is_running()) {
      try {
        await this.#control('NODE_DELETE', node.slot, []);
      } catch (error) {
        failures.push(errorMessage(error));
      }
    }
    this.#nodes.delete(node.slot);
    for (const vlan of node.interfaceByVlan.keys()) this.#vlanOwners.delete(vlan);
    if (this.#nodes.size === 0) {
      try {
        await this.#destroy();
      } catch (error) {
        failures.push(errorMessage(error));
      }
    }
    if (failures.length > 0) {
      node.host.emitEvent({
        type: 'log',
        level: 'warning',
        source: 'shared-v86-runtime',
        message: `Guest cleanup required forced disposal: ${failures.join('; ')}`,
      });
    }
  }

  deliverFrame(node: SharedNodeRecord, frame: ApplianceFrame): void {
    const vlan = node.vlanByInterface.get(frame.interfaceId);
    if (vlan === undefined) throw new Error(`Unknown interface: ${frame.interfaceId}`);
    this.#requireEmulator().bus.send('net0-receive', addLabVlanTag(frame.bytes, vlan));
  }

  async setInterfaceState(node: SharedNodeRecord, interfaceId: string, up: boolean): Promise<void> {
    const index = node.request.interfaces.findIndex((candidate) => candidate.id === interfaceId);
    const current = node.request.interfaces[index];
    if (current === undefined) throw new Error(`Unknown interface: ${interfaceId}`);
    const interfaces = node.request.interfaces.map((candidate, candidateIndex) => (
      candidateIndex === index ? { ...copyInterface(candidate), up } : copyInterface(candidate)
    ));
    node.request = { ...copyBootRequest(node.request), interfaces };
    if (node.active) {
      await this.#control('LINK', node.slot, [encodeSharedText(current.name), up ? 'up' : 'down']);
    }
  }

  updateFile(node: SharedNodeRecord, file: ApplianceFile): void {
    const files = new Map(node.request.files.map((candidate) => [candidate.path, copyFile(candidate)]));
    files.set(file.path, copyFile(file));
    node.request = { ...copyBootRequest(node.request), files: [...files.values()] };
  }

  async applyFile(node: SharedNodeRecord, file: ApplianceFile): Promise<void> {
    const path = inputArchivePath(node.slot);
    await this.#requireEmulator().create_file(path, createUstarArchive([file]));
    await this.#control('APPLY', node.slot, []);
  }

  async readFile(node: SharedNodeRecord, path: string): Promise<ApplianceFile | null> {
    try {
      await this.#control('READ', node.slot, [encodeSharedText(path)]);
    } catch (error) {
      if (errorMessage(error).includes('ENOENT')) return null;
      throw error;
    }
    const archive = await this.#requireEmulator().read_file(outputArchivePath(node.slot));
    const file = readUstarArchive(archive).find((candidate) => candidate.path === path);
    if (file === undefined) throw new Error(`Shared guest export did not contain ${path}`);
    return copyFile(file);
  }

  async openTerminal(
    node: SharedNodeRecord,
    request: ApplianceTerminalOpenRequest,
    runtimeSessionId: string,
  ): Promise<number> {
    const detail = await this.#control('TERM_OPEN', node.slot, [String(request.columns), String(request.rows)]);
    const guestSession = parsePositiveInteger(detail[0], 'guest terminal session');
    node.guestTerminals.set(guestSession, runtimeSessionId);
    return guestSession;
  }

  async writeTerminal(node: SharedNodeRecord, guestSession: number, data: Uint8Array): Promise<void> {
    for (let offset = 0; offset < data.byteLength; offset += MAX_SHARED_TERMINAL_CHUNK_BYTES) {
      const chunk = data.subarray(offset, Math.min(data.byteLength, offset + MAX_SHARED_TERMINAL_CHUNK_BYTES));
      await this.#control('TERM_WRITE', node.slot, [String(guestSession), encodeSharedBytes(chunk)]);
    }
  }

  async resizeTerminal(
    node: SharedNodeRecord,
    guestSession: number,
    columns: number,
    rows: number,
  ): Promise<void> {
    await this.#control('TERM_RESIZE', node.slot, [String(guestSession), String(columns), String(rows)]);
  }

  async closeTerminal(node: SharedNodeRecord, guestSession: number): Promise<void> {
    await this.#control('TERM_CLOSE', node.slot, [String(guestSession)]);
    node.guestTerminals.delete(guestSession);
  }

  async collectPgoProfiles(node: SharedNodeRecord): Promise<V86PgoProfileCollection> {
    await this.#control('COLLECT_PGO', node.slot, [], this.#dependencies.pgoCollectionTimeoutMs ?? PGO_CONTROL_TIMEOUT_MS);
    const archive = await this.#requireEmulator().read_file(outputArchivePath(node.slot));
    const files = await validatePgoProfileArchive(archive, node.kind as Exclude<V86ApplianceKind, 'client'>);
    node.active = false;
    return { archive: archive.slice(), files };
  }

  async #prepare(): Promise<void> {
    const loadArtifacts = this.#dependencies.loadArtifacts ?? loadVerifiedV86Artifacts;
    this.#artifacts = await loadArtifacts(this.#dependencies.artifactSource);
    if (this.#artifacts.manifestSha256 !== this.#dependencies.artifactSource.manifestSha256) {
      throw new Error('v86 artifact loader returned a manifest with the wrong trusted digest');
    }
    if (
      this.#artifacts.manifest.buildId !== V86_IMAGE_BUILD_ID ||
      this.#artifacts.manifest.machine.model !== 'shared-namespaces'
    ) {
      throw new Error(`v86 artifact ${this.#artifacts.manifest.buildId} is not a shared-namespaces image`);
    }
    const createObjectUrl = this.#dependencies.createObjectUrl ?? defaultCreateObjectUrl;
    this.#wasmObjectUrl = createObjectUrl(this.#artifacts.artifacts['v86-wasm'], 'application/wasm');
    const factory: V86EmulatorFactory = this.#dependencies.emulatorFactory ??
      (await (this.#dependencies.loadEmulatorFactory ?? loadV86PackageFactory)());
    const root = this.#artifacts.filesystems.complete?.blob;
    if (root === undefined) throw new Error('Shared v86 complete root filesystem is missing');
    this.#emulator = factory({
      wasm_path: this.#wasmObjectUrl,
      memory_size: this.#artifacts.manifest.machine.memoryBytes,
      vga_memory_size: this.#artifacts.manifest.machine.vgaMemoryBytes,
      bios: { buffer: toArrayBuffer(this.#artifacts.artifacts.bios) },
      vga_bios: { buffer: toArrayBuffer(this.#artifacts.artifacts['vga-bios']) },
      bzimage: { buffer: toArrayBuffer(this.#artifacts.artifacts.bzimage) },
      hda: { buffer: blobAsFile(root, 'rootfs-complete.squashfs'), async: true },
      cmdline:
        'console=ttyS0,115200n8 tsc=reliable mitigations=off random.trust_cpu=on ' +
        'dummy.numdummies=0 ifb.numifbs=0 ' +
        'panic=-1 oops=panic net.ifnames=0 root=/dev/sda rootfstype=squashfs ro',
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
      this.#dependencies.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS,
      'Shared v86 emulator did not become ready',
    );
  }

  #createBootstrapArchive(): Uint8Array {
    const builder = new SharedV86BootstrapBuilder();
    for (const node of [...this.#nodes.values()].sort((left, right) => left.slot - right.slot)) {
      const registered = builder.register(node.kind, node.request);
      if (registered.slot !== node.slot) throw new Error('Shared bootstrap slot assignment drifted');
      for (const networkInterface of registered.interfaces) {
        if (node.vlanByInterface.get(networkInterface.id) !== networkInterface.vlanId) {
          throw new Error('Shared bootstrap VLAN assignment drifted');
        }
      }
    }
    return builder.seal();
  }

  #control(
    command: Parameters<typeof encodeSharedGuestCommand>[0]['command'],
    nodeSlot: number,
    arguments_: readonly string[],
    timeoutMs = this.#dependencies.controlTimeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS,
    failureSignal?: Promise<unknown>,
  ): Promise<readonly string[]> {
    const operation = async (): Promise<readonly string[]> => {
      this.#throwIfFailed();
      const requestId = this.#nextRequestId++;
      const promise = new Promise<readonly string[]>((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.#controlWaiters.delete(requestId);
          reject(new Error(`Shared guest control command ${command} timed out`));
        }, timeoutMs);
        this.#controlWaiters.set(requestId, { resolve, reject, timeout });
      });
      // A node can exit before the guest sends its NODE_START response. Reject
      // that request immediately so NODE_STOP cleanup is not queued behind the
      // complete boot timeout.
      if (failureSignal !== undefined) {
        void failureSignal.catch((error: unknown) => {
          const waiter = this.#controlWaiters.get(requestId);
          if (waiter === undefined) return;
          clearTimeout(waiter.timeout);
          this.#controlWaiters.delete(requestId);
          waiter.reject(error instanceof Error ? error : new Error(String(error)));
        });
      }
      this.#requireEmulator().bus.send(
        'virtio-console0-input-bytes',
        encodeSharedGuestCommand({ command, requestId, nodeSlot, arguments: arguments_ }),
      );
      return promise;
    };
    const result = this.#controlTail.then(operation, operation);
    this.#controlTail = result.then(() => undefined, () => undefined);
    return result;
  }

  #handleMessage(line: string): void {
    const message = parseSharedGuestMessage(line);
    if (message === null) return;
    switch (message.type) {
      case 'machine-ready':
        this.#machineReady.resolve();
        return;
      case 'node-ready':
        this.#nodes.get(message.nodeSlot)?.readiness?.resolve();
        this.#nodes.get(message.nodeSlot)?.owner.machineNodeReady();
        return;
      case 'node-exit': {
        const node = this.#nodes.get(message.nodeSlot);
        if (node !== undefined) {
          const error = new Error(message.reason);
          node.active = false;
          if (node.readiness !== null) {
            node.startupFailure ??= error;
            node.readiness.reject(node.startupFailure);
            node.startupExit?.reject(node.startupFailure);
          }
          node.owner.machineNodeExited(message.reason);
        }
        return;
      }
      case 'response': {
        const waiter = this.#controlWaiters.get(message.requestId);
        if (waiter === undefined) return;
        clearTimeout(waiter.timeout);
        this.#controlWaiters.delete(message.requestId);
        if (message.ok) waiter.resolve(message.detail);
        else waiter.reject(new Error(`Shared guest control error ${message.code}: ${message.detail.join(' ')}`));
        return;
      }
      case 'terminal-data': {
        const node = this.#nodes.get(message.nodeSlot);
        const runtimeSession = node?.guestTerminals.get(message.sessionId);
        if (node !== undefined && runtimeSession !== undefined) {
          node.host.emitEvent({ type: 'terminal-output', sessionId: runtimeSession, data: message.data });
        }
        return;
      }
      case 'log':
        this.#nodes.get(message.nodeSlot)?.host.emitEvent({
          type: 'log', level: message.level, source: 'shared-v86-guest', message: message.message,
        });
    }
  }

  #failMachine(error: Error): void {
    this.#failed = true;
    this.#failure ??= error;
    const failure = this.#failure;
    this.#machineReady.reject(failure);
    for (const waiter of this.#controlWaiters.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(failure);
    }
    this.#controlWaiters.clear();
    for (const node of this.#nodes.values()) {
      node.readiness?.reject(failure);
      node.owner.machineFailed(failure.message);
    }
  }

  #throwIfFailed(): void {
    if (this.#failure !== null) throw this.#failure;
  }

  #logAll(level: 'info' | 'warning' | 'error', message: string): void {
    for (const node of this.#nodes.values()) {
      node.host.emitEvent({ type: 'log', level, source: 'shared-v86-runtime', message });
    }
  }

  #installListeners(): void {
    const emulator = this.#requireEmulator();
    emulator.add_listener('emulator-ready', this.#onEmulatorReady);
    emulator.add_listener('download-error', this.#onDownloadError);
    emulator.add_listener('virtio-console0-output-bytes', this.#onControlBytes);
    emulator.add_listener('net0-send', this.#onNetworkFrame);
  }

  #removeListeners(): void {
    const emulator = this.#requireEmulator();
    emulator.remove_listener('emulator-ready', this.#onEmulatorReady);
    emulator.remove_listener('download-error', this.#onDownloadError);
    emulator.remove_listener('virtio-console0-output-bytes', this.#onControlBytes);
    emulator.remove_listener('net0-send', this.#onNetworkFrame);
  }

  async #destroy(): Promise<void> {
    if (this.#destroyed) return;
    this.#destroyed = true;
    for (const waiter of this.#controlWaiters.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error('Shared v86 machine was destroyed'));
    }
    this.#controlWaiters.clear();
    let destroyError: unknown;
    if (this.#emulator !== null) {
      this.#removeListeners();
      const emulator = this.#emulator;
      this.#emulator = null;
      try {
        await emulator.destroy();
      } catch (error) {
        destroyError = error;
      }
    }
    if (this.#wasmObjectUrl !== null) {
      try {
        (this.#dependencies.revokeObjectUrl ?? defaultRevokeObjectUrl)(this.#wasmObjectUrl);
      } catch (error) {
        destroyError ??= error;
      }
      this.#wasmObjectUrl = null;
    }
    if (destroyError !== undefined) throw destroyError;
  }

  #requireEmulator(): V86Emulator {
    if (this.#emulator === null) throw new Error('Shared v86 machine is not prepared');
    return this.#emulator;
  }
}

export class SharedV86ApplianceRuntime implements ApplianceRuntime, PgoCollectibleRuntime {
  readonly apiVersion = APPLIANCE_RUNTIME_API_VERSION;
  readonly descriptor;
  readonly #kind: V86ApplianceKind;
  readonly #machine: SharedV86Machine;
  #node: SharedNodeRecord | null = null;
  #host: ApplianceHostV1 | null = null;
  #state: ApplianceLifecycleState = 'new';
  #files = new Map<string, ApplianceFile>();
  #interfaces: ApplianceInterfaceSpec[] = [];
  #pendingFiles = new Set<string>();
  #terminals = new Map<string, number>();
  #nextTerminalId = 1;
  #revision = 0;
  #hasStarted = false;

  constructor(kind: V86ApplianceKind, machine: SharedV86Machine) {
    this.#kind = kind;
    this.#machine = machine;
    this.descriptor = v86RuntimeDescriptor(kind);
  }

  get state(): ApplianceLifecycleState {
    return this.#state;
  }

  async initialize(request: ApplianceBootRequest, host: ApplianceHostV1): Promise<ApplianceBootResult> {
    this.#expectState('new');
    if (host.abiVersion !== APPLIANCE_HOST_ABI_VERSION) throw new Error('Incompatible appliance host ABI');
    this.#host = host;
    this.#files = new Map(request.files.map((file) => [file.path, copyFile(file)]));
    this.#interfaces = request.interfaces.map(copyInterface);
    this.#node = this.#machine.register(this.#kind, request, host, this);
    try {
      await this.#machine.prepare();
      this.#transition('initialized');
      return {
        state: 'initialized',
        warnings: [
          'All native nodes share one Linux kernel and are isolated with PID, mount, network, UTS, IPC, cgroup, and time namespaces',
          'The guest is 32-bit i686 because v86 does not emulate x86-64 CPU extensions',
        ],
      };
    } catch (error) {
      this.#transition('failed', errorMessage(error));
      throw error;
    }
  }

  async start(): Promise<void> {
    this.#expectState('initialized', 'stopped');
    try {
      const pendingFiles = this.#hasStarted
        ? [...this.#pendingFiles]
            .map((path) => this.#files.get(path))
            .filter((file): file is ApplianceFile => file !== undefined)
        : [];
      await this.#machine.startNode(this.#requireNode(), pendingFiles);
      this.#pendingFiles.clear();
      this.#hasStarted = true;
      this.#transition('running');
    } catch (error) {
      this.#transition('failed', errorMessage(error));
      throw error;
    }
  }

  async step(request: ApplianceStepRequest): Promise<ApplianceStepResult> {
    this.#expectState('running');
    if (!Number.isSafeInteger(request.maxWorkItems) || request.maxWorkItems < 1 || request.nowNs < 0n) {
      throw new Error('Invalid shared appliance step request');
    }
    return { state: this.#state, workItems: 0, nextDeadlineNs: null, hasImmediateWork: false };
  }

  async deliverFrame(frame: ApplianceFrame): Promise<void> {
    this.#expectState('running');
    this.#machine.deliverFrame(this.#requireNode(), frame);
  }

  async setInterfaceState(interfaceId: string, up: boolean): Promise<void> {
    this.#expectUsable();
    const index = this.#interfaces.findIndex((candidate) => candidate.id === interfaceId);
    const current = this.#interfaces[index];
    if (current === undefined) throw new Error(`Unknown interface: ${interfaceId}`);
    this.#interfaces[index] = { ...copyInterface(current), up };
    await this.#machine.setInterfaceState(this.#requireNode(), interfaceId, up);
    this.#inspectionChanged();
  }

  async writeFile(file: ApplianceFile): Promise<void> {
    this.#expectUsable();
    assertNormalizedAbsolutePath(file.path);
    const stored = copyFile(file);
    this.#files.set(stored.path, stored);
    this.#machine.updateFile(this.#requireNode(), stored);
    if (this.#state === 'running') await this.#machine.applyFile(this.#requireNode(), stored);
    else this.#pendingFiles.add(stored.path);
    this.#host?.emitEvent({
      type: 'file-changed', path: stored.path, contents: stored.contents.slice(), mode: stored.mode ?? 0o644,
    });
    this.#inspectionChanged();
  }

  async readFile(path: string): Promise<ApplianceFile | null> {
    this.#expectUsable();
    assertNormalizedAbsolutePath(path);
    if (this.#state === 'running') {
      const file = await this.#machine.readFile(this.#requireNode(), path);
      if (file !== null) this.#files.set(path, copyFile(file));
      return file;
    }
    const file = this.#files.get(path);
    return file === undefined ? null : copyFile(file);
  }

  async openTerminal(request: ApplianceTerminalOpenRequest): Promise<string> {
    this.#expectState('running');
    if (request.terminal !== 'serial' || request.columns < 1 || request.rows < 1) {
      throw new Error('Invalid shared terminal request');
    }
    const runtimeSession = `shared-${this.#nextTerminalId++}`;
    const guestSession = await this.#machine.openTerminal(this.#requireNode(), request, runtimeSession);
    this.#terminals.set(runtimeSession, guestSession);
    return runtimeSession;
  }

  async writeTerminal(sessionId: string, data: Uint8Array): Promise<void> {
    this.#expectState('running');
    await this.#machine.writeTerminal(this.#requireNode(), this.#requireTerminal(sessionId), data);
  }

  async resizeTerminal(sessionId: string, columns: number, rows: number): Promise<void> {
    this.#expectUsable();
    if (columns < 1 || rows < 1) throw new Error('Terminal dimensions must be positive');
    await this.#machine.resizeTerminal(
      this.#requireNode(), this.#requireTerminal(sessionId), columns, rows,
    );
  }

  async closeTerminal(sessionId: string): Promise<void> {
    this.#expectUsable();
    await this.#machine.closeTerminal(this.#requireNode(), this.#requireTerminal(sessionId));
    this.#terminals.delete(sessionId);
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
    await this.#machine.stopNode(this.#requireNode());
    this.#terminals.clear();
    this.#transition('stopped', reason);
  }

  async dispose(): Promise<void> {
    if (this.#state === 'disposed') return;
    if (this.#node !== null) await this.#machine.disposeNode(this.#node);
    this.#terminals.clear();
    this.#transition('disposed');
    this.#node = null;
    this.#host = null;
  }

  async collectPgoProfiles(): Promise<V86PgoProfileCollection> {
    if (this.#kind === 'client') throw new Error('PGO collection is unavailable for client nodes');
    this.#expectState('running');
    const result = await this.#machine.collectPgoProfiles(this.#requireNode());
    this.#transition('stopped', 'PGO profiles collected');
    return result;
  }

  machineNodeReady(): void {
    this.#host?.emitEvent({ type: 'log', level: 'info', source: 'shared-v86-runtime', message: 'Node namespace is ready' });
  }

  machineNodeExited(reason: string): void {
    if (this.#state === 'running') this.#transition('failed', reason);
  }

  machineFailed(reason: string): void {
    if (this.#state !== 'disposed') this.#transition('failed', reason);
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

  #requireNode(): SharedNodeRecord {
    if (this.#node === null) throw new Error('Shared appliance node is not initialized');
    return this.#node;
  }

  #requireTerminal(sessionId: string): number {
    const terminal = this.#terminals.get(sessionId);
    if (terminal === undefined) throw new Error(`Unknown terminal session: ${sessionId}`);
    return terminal;
  }

  #expectState(...states: ApplianceLifecycleState[]): void {
    if (!states.includes(this.#state)) throw new Error(`Invalid appliance state ${this.#state}; expected ${states.join(' or ')}`);
  }

  #expectUsable(): void {
    this.#expectState('initialized', 'running', 'stopped');
  }
}

export function createSharedV86RuntimeFactories(
  dependencies: V86RuntimeDependencies,
): readonly [ApplianceRuntimeFactory, ApplianceRuntimeFactory, ApplianceRuntimeFactory] {
  let machine: SharedV86Machine | null = null;
  const acquireMachine = (): SharedV86Machine => {
    if (machine === null || !machine.acceptsRegistrations) {
      machine = new SharedV86Machine(dependencies);
    }
    return machine;
  };
  return (['bird', 'frr', 'client'] as const).map((kind): ApplianceRuntimeFactory => ({
    descriptor: v86RuntimeDescriptor(kind),
    create: () => new SharedV86ApplianceRuntime(kind, acquireMachine()),
  })) as unknown as readonly [ApplianceRuntimeFactory, ApplianceRuntimeFactory, ApplianceRuntimeFactory];
}

function inputArchivePath(slot: number): string {
  return `/anycastlab-node-${slot}-in.tar`;
}

function outputArchivePath(slot: number): string {
  return `/anycastlab-node-${slot}-out.tar`;
}

function copyBootRequest(request: ApplianceBootRequest): ApplianceBootRequest {
  return {
    ...request,
    argv: [...request.argv],
    environment: { ...request.environment },
    files: request.files.map(copyFile),
    interfaces: request.interfaces.map(copyInterface),
  };
}

function copyFile(file: ApplianceFile): ApplianceFile {
  assertNormalizedAbsolutePath(file.path);
  return { path: file.path, contents: file.contents.slice(), ...(file.mode === undefined ? {} : { mode: file.mode }) };
}

function copyInterface(networkInterface: ApplianceInterfaceSpec): ApplianceInterfaceSpec {
  return { ...networkInterface, addresses: networkInterface.addresses.map((address) => ({ ...address })) };
}

function blobAsFile(blob: Blob, name: string): File {
  if (typeof File === 'undefined') throw new Error('Browser File support is required for shared v86 storage');
  return blob instanceof File ? blob : new File([blob], name, { type: 'application/vnd.squashfs' });
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

function parsePositiveInteger(value: string | undefined, label: string): number {
  if (value === undefined || !/^[1-9][0-9]*$/.test(value)) throw new Error(`${label} is invalid`);
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error(`${label} is invalid`);
  return result;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  // Deferred failures can occur before a lifecycle method begins awaiting them.
  void promise.catch(() => undefined);
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isUint8Array(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Uint8Array]';
}
