import { describe, expect, it } from 'vitest';
import {
  APPLIANCE_HOST_ABI_VERSION,
  type ApplianceBootRequest,
  type ApplianceFrame,
  type ApplianceHostV1,
  type ApplianceObservedEvent,
} from '../abi';
import type { V86Emulator, V86EmulatorFactory, V86EmulatorOptions } from './emulator';
import { addLabVlanTag, removeLabVlanTag } from './ethernet';
import {
  PINNED_BIRD_VERSION,
  PINNED_BUILDROOT_VERSION,
  PINNED_FRR_VERSION,
  PINNED_V86_COMMIT,
  PINNED_V86_PACKAGE_VERSION,
  V86_IMAGE_BUILD_ID,
  type VerifiedV86ArtifactBundle,
} from './manifest';
import { V86ApplianceRuntime, createV86RuntimeFactories, v86RuntimeDescriptor } from './runtime';
import { createUstarArchive, readUstarArchive } from './tar';

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

describe('V86ApplianceRuntime', () => {
  it('exposes native router and Linux client factories without compatibility fallbacks', () => {
    const dependencies = {
      artifactSource: { manifestUrl: '/manifest.json', manifestSha256: 'a'.repeat(64) },
    };
    expect(createV86RuntimeFactories(dependencies).map((factory) => factory.descriptor.kind)).toEqual([
      'bird', 'frr', 'client',
    ]);
    expect(v86RuntimeDescriptor('client')).toMatchObject({
      runtimeId: 'linux-client-v86', fidelity: 'native', kind: 'client', upstreamVersion: null,
    });
  });

  it('boots Linux, exchanges frames, drives serial, updates files, and snapshots through v86 APIs', async () => {
    const fake = new FakeV86();
    const observed: ApplianceObservedEvent[] = [];
    const transmitted: ApplianceFrame[] = [];
    const revoked: string[] = [];
    const host: ApplianceHostV1 = {
      abiVersion: APPLIANCE_HOST_ABI_VERSION,
      nowNs: () => 10n,
      fillRandom: (target) => target.fill(7),
      transmitFrame: (frame) => transmitted.push({ ...frame, bytes: frame.bytes.slice() }),
      emitEvent: (event) => observed.push(event),
    };
    const runtime = new V86ApplianceRuntime('bird', {
      artifactSource: { manifestUrl: '/manifest.json', manifestSha256: 'a'.repeat(64) },
      loadArtifacts: async () => artifactBundle(),
      emulatorFactory: fake.factory,
      createObjectUrl: () => 'blob:verified-v86',
      revokeObjectUrl: (url) => revoked.push(url),
      bootTimeoutMs: 500,
      controlTimeoutMs: 500,
    });

    await runtime.initialize(bootRequest(), host);
    expect(fake.options?.autostart).toBe(false);
    expect(fake.options?.net_device).toEqual({ type: 'virtio', mtu: 65_535 });
    expect(fake.files.has('/anycastlab-bootstrap.tar')).toBe(true);
    const startScript = new TextDecoder().decode(
      readUstarArchive(fake.files.get('/anycastlab-bootstrap.tar')!)
        .find((file) => file.path === '/run/anycastlab/start.sh')!.contents,
    );
    expect(startScript).toContain('/usr/sbin/birdc show status');
    expect(startScript).toContain('kill -0 "$appliance_pid"');
    expect(startScript).toContain('appliance readiness probe timed out');
    expect(runtime.state).toBe('initialized');

    await runtime.start();
    expect(runtime.state).toBe('running');
    expect([...fake.guestFiles.get('/etc/bird/bird.conf')!]).toEqual([...text('router id 192.0.2.1;\n')]);

    const ingress = ethernetFrame(0x86dd);
    await runtime.deliverFrame({ interfaceId: 'uplink-id', bytes: ingress });
    const injected = fake.receivedFrames.at(-1)!;
    const decodedIngress = removeLabVlanTag(injected);
    expect(decodedIngress?.vlanId).toBe(100);
    expect([...(decodedIngress?.bytes ?? [])]).toEqual([...ingress]);

    const egress = ethernetFrame(0x0800);
    fake.emit('net0-send', addLabVlanTag(egress, 101));
    expect(transmitted.map((frame) => ({ ...frame, bytes: [...frame.bytes] }))).toEqual([
      { interfaceId: 'service-id', bytes: [...egress] },
    ]);

    const sessionId = await runtime.openTerminal({ terminal: 'serial', columns: 80, rows: 24 });
    fake.emit('serial0-output-byte', 0x4f);
    fake.emit('serial0-output-byte', 0x4b);
    await Promise.resolve();
    expect(
      observed.some(
        (event) =>
          event.type === 'terminal-output' &&
          event.sessionId === sessionId &&
          new TextDecoder().decode(event.data) === 'OK',
      ),
    ).toBe(true);
    await runtime.writeTerminal(sessionId, text('birdc show route\n'));
    expect(new TextDecoder().decode(fake.serialInput.at(-1))).toBe('birdc show route\n');

    await runtime.writeFile({ path: '/etc/bird/filters.conf', contents: text('define OUR_AS = 65000;\n'), mode: 0o640 });
    expect([...fake.guestFiles.get('/etc/bird/filters.conf')!]).toEqual([...text('define OUR_AS = 65000;\n')]);
    const readBack = await runtime.readFile('/etc/bird/filters.conf');
    expect(readBack === null ? null : { ...readBack, contents: [...readBack.contents] }).toEqual({
      path: '/etc/bird/filters.conf',
      contents: [...text('define OUR_AS = 65000;\n')],
      mode: 0o640,
    });

    await runtime.setInterfaceState('service-id', false);
    expect(fake.controlCommands.some((command) => command.includes(' LINK ') && command.endsWith(' down'))).toBe(true);

    const snapshot = await runtime.saveSnapshot();
    expect(snapshot.runtimeId).toBe('bird-2.15.1-v86');
    expect([...snapshot.emulatorState]).toEqual([9, 8, 7]);
    await runtime.restoreSnapshot(snapshot);
    expect([...(fake.restoredState ?? [])]).toEqual([9, 8, 7]);

    await runtime.stop('test complete');
    await runtime.dispose();
    expect(revoked).toEqual(['blob:verified-v86']);
    expect(fake.destroyed).toBe(true);
  });

  it('refuses a snapshot from a different artifact manifest', async () => {
    const fake = new FakeV86();
    const runtime = new V86ApplianceRuntime('frr', {
      artifactSource: { manifestUrl: '/manifest.json', manifestSha256: 'a'.repeat(64) },
      loadArtifacts: async () => artifactBundle(),
      emulatorFactory: fake.factory,
      createObjectUrl: () => 'blob:v86',
      revokeObjectUrl: () => undefined,
      bootTimeoutMs: 500,
    });
    await runtime.initialize(bootRequest(), hostStub());
    const startScript = new TextDecoder().decode(
      readUstarArchive(fake.files.get('/anycastlab-bootstrap.tar')!)
        .find((file) => file.path === '/run/anycastlab/start.sh')!.contents,
    );
    expect(startScript).toContain('[ -f /run/anycastlab/frr.ready ]');
    expect(startScript).toContain('/usr/sbin/frrinit.sh status');
    const snapshot = await runtime.saveSnapshot();
    await expect(runtime.restoreSnapshot({ ...snapshot, manifestSha256: 'f'.repeat(64) })).rejects.toThrow(
      /incompatible/,
    );
    await runtime.dispose();
  });

  it('does not report running until both the appliance and serial shell are ready', async () => {
    const fake = new FakeV86();
    fake.emitShellPromptOnBoot = false;
    const runtime = new V86ApplianceRuntime('bird', {
      artifactSource: { manifestUrl: '/manifest.json', manifestSha256: 'a'.repeat(64) },
      loadArtifacts: async () => artifactBundle(),
      emulatorFactory: fake.factory,
      createObjectUrl: () => 'blob:v86-shell-wait',
      revokeObjectUrl: () => undefined,
      bootTimeoutMs: 500,
    });
    await runtime.initialize(bootRequest(), hostStub());
    let settled = false;
    const started = runtime.start().then(() => { settled = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    fake.emitSerialText('\r\n/ # ');
    await Promise.resolve();
    expect(settled).toBe(false);
    fake.emitSerialText('\r\nANYCASTLAB-SHELL-READY\r\n');
    await started;
    expect(runtime.state).toBe('running');
    await runtime.dispose();
  });

  it('rejects guest startup failures and reports a later appliance exit', async () => {
    const failedGuest = new FakeV86();
    failedGuest.startupControlLine = 'ANYCASTLAB/1 FAILED appliance-readiness';
    const failedRuntime = new V86ApplianceRuntime('bird', {
      artifactSource: { manifestUrl: '/manifest.json', manifestSha256: 'a'.repeat(64) },
      loadArtifacts: async () => artifactBundle(),
      emulatorFactory: failedGuest.factory,
      createObjectUrl: () => 'blob:v86-failed',
      revokeObjectUrl: () => undefined,
      bootTimeoutMs: 500,
    });
    await failedRuntime.initialize(bootRequest(), hostStub());
    await expect(failedRuntime.start()).rejects.toThrow(/Linux guest startup failed: appliance-readiness/);
    expect(failedRuntime.state).toBe('failed');
    await failedRuntime.dispose();

    const exitedGuest = new FakeV86();
    const events: ApplianceObservedEvent[] = [];
    const exitedRuntime = new V86ApplianceRuntime('frr', {
      artifactSource: { manifestUrl: '/manifest.json', manifestSha256: 'a'.repeat(64) },
      loadArtifacts: async () => artifactBundle(),
      emulatorFactory: exitedGuest.factory,
      createObjectUrl: () => 'blob:v86-exited',
      revokeObjectUrl: () => undefined,
      bootTimeoutMs: 500,
    });
    const host = hostStub();
    await exitedRuntime.initialize(bootRequest(), { ...host, emitEvent: (event) => events.push(event) });
    await exitedRuntime.start();
    exitedGuest.emit('virtio-console0-output-bytes', text('ANYCASTLAB/1 EXIT appliance-process-exited\n'));
    expect(exitedRuntime.state).toBe('failed');
    expect(events).toContainEqual(expect.objectContaining({
      type: 'lifecycle', state: 'failed', detail: 'appliance-process-exited',
    }));
    await exitedRuntime.dispose();
  });

  it('rejects READY followed by an immediate appliance exit in the same control chunk', async () => {
    const fake = new FakeV86();
    fake.startupControlLine = 'ANYCASTLAB/1 READY\nANYCASTLAB/1 EXIT appliance-process-exited';
    const runtime = new V86ApplianceRuntime('frr', {
      artifactSource: { manifestUrl: '/manifest.json', manifestSha256: 'a'.repeat(64) },
      loadArtifacts: async () => artifactBundle(),
      emulatorFactory: fake.factory,
      createObjectUrl: () => 'blob:v86-immediate-exit',
      revokeObjectUrl: () => undefined,
      bootTimeoutMs: 500,
    });
    await runtime.initialize(bootRequest(), hostStub());
    await expect(runtime.start()).rejects.toThrow(/exited while completing guest startup/);
    expect(runtime.state).toBe('failed');
    await runtime.dispose();
  });
});

class FakeV86 implements V86Emulator {
  readonly listeners = new Map<string, Set<(value: unknown) => void>>();
  readonly files = new Map<string, Uint8Array>();
  readonly guestFiles = new Map<string, Uint8Array>();
  readonly guestModes = new Map<string, number>();
  readonly receivedFrames: Uint8Array[] = [];
  readonly serialInput: Uint8Array[] = [];
  readonly controlCommands: string[] = [];
  readonly bus = {
    send: (event: string, value?: unknown): void => {
      if (event === 'net0-receive' && isByteArray(value)) this.receivedFrames.push(value.slice());
      if (event === 'virtio-console0-input-bytes' && isByteArray(value)) {
        this.handleControl(new TextDecoder().decode(value).trim());
      }
    },
  };
  options: V86EmulatorOptions | null = null;
  running = false;
  destroyed = false;
  restoredState: Uint8Array | null = null;
  booted = false;
  startupControlLine = 'ANYCASTLAB/1 READY';
  emitShellPromptOnBoot = true;

  readonly factory: V86EmulatorFactory = (options) => {
    this.options = options;
    queueMicrotask(() => this.emit('emulator-ready', undefined));
    return this;
  };

  add_listener(event: string, listener: (value: unknown) => void): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  remove_listener(event: string, listener: (value: unknown) => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: string, value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }

  async run(): Promise<void> {
    this.running = true;
    this.emit('emulator-started', undefined);
    if (!this.booted) {
      this.booted = true;
      const bootstrap = this.files.get('/anycastlab-bootstrap.tar');
      if (bootstrap !== undefined) this.extractIntoGuest(bootstrap);
      queueMicrotask(() => {
        this.emitControl(this.startupControlLine);
        if (this.emitShellPromptOnBoot) this.emitSerialText('\r\nANYCASTLAB-SHELL-READY\r\n~ # ');
      });
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.emit('emulator-stopped', undefined);
  }

  async destroy(): Promise<void> {
    this.running = false;
    this.destroyed = true;
  }

  is_running(): boolean {
    return this.running;
  }

  async save_state(): Promise<ArrayBuffer> {
    return new Uint8Array([9, 8, 7]).buffer;
  }

  async restore_state(state: ArrayBuffer): Promise<void> {
    this.restoredState = new Uint8Array(state.slice(0));
  }

  async create_file(path: string, contents: Uint8Array): Promise<void> {
    this.files.set(path, contents.slice());
  }

  async read_file(path: string): Promise<Uint8Array> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`missing fake 9p file: ${path}`);
    return value.slice();
  }

  serial_send_bytes(_serial: number, contents: Uint8Array): void {
    this.serialInput.push(contents.slice());
  }

  emitSerialText(value: string): void {
    for (const byte of text(value)) this.emit('serial0-output-byte', byte);
  }

  private handleControl(line: string): void {
    this.controlCommands.push(line);
    const [, command, id, argument] = line.split(' ');
    if (command === 'APPLY') {
      const archive = this.files.get('/anycastlab-in.tar');
      if (archive !== undefined) this.extractIntoGuest(archive);
      queueMicrotask(() => this.emitControl(`ANYCASTLAB/1 OK ${id}`));
      return;
    }
    if (command === 'READ') {
      const path = new TextDecoder().decode(Uint8Array.from(atob(argument!), (character) => character.charCodeAt(0)));
      const contents = this.guestFiles.get(path);
      if (contents === undefined) {
        queueMicrotask(() => this.emitControl(`ANYCASTLAB/1 ERR ${id} ENOENT`));
      } else {
        this.files.set(
          '/anycastlab-out.tar',
          createUstarArchive([{ path, contents, mode: this.guestModes.get(path) ?? 0o644 }]),
        );
        queueMicrotask(() => this.emitControl(`ANYCASTLAB/1 OK ${id}`));
      }
      return;
    }
    queueMicrotask(() => this.emitControl(`ANYCASTLAB/1 OK ${id}`));
  }

  private emitControl(line: string): void {
    this.emit('virtio-console0-output-bytes', text(`${line}\n`));
  }

  private extractIntoGuest(archive: Uint8Array): void {
    for (const file of readUstarArchive(archive)) {
      this.guestFiles.set(file.path, file.contents.slice());
      this.guestModes.set(file.path, file.mode ?? 0o644);
    }
  }
}

function bootRequest(): ApplianceBootRequest {
  return {
    nodeId: 'router-1',
    hostname: 'router-1',
    entrypoint: '/usr/sbin/bird',
    argv: ['-f', '-c', '/etc/bird/bird.conf'],
    environment: { BIRD_LOG_LEVEL: 'debug' },
    randomSeed: 'test-seed',
    files: [{ path: '/etc/bird/bird.conf', contents: text('router id 192.0.2.1;\n'), mode: 0o640 }],
    interfaces: [
      {
        id: 'uplink-id',
        name: 'eth0',
        mac: '02:00:00:00:00:01',
        mtu: 1500,
        up: true,
        addresses: [{ family: 'ipv4', address: '192.0.2.1', prefixLength: 31 }],
      },
      {
        id: 'service-id',
        name: 'eth1',
        mac: '02:00:00:00:00:02',
        mtu: 1500,
        up: true,
        addresses: [{ family: 'ipv6', address: '2001:db8::1', prefixLength: 64 }],
      },
    ],
  };
}

function artifactBundle(): VerifiedV86ArtifactBundle {
  return {
    manifestSha256: 'a'.repeat(64),
    manifest: {
      schemaVersion: 1,
      imageId: 'anycast-lab-router',
      buildId: V86_IMAGE_BUILD_ID,
      sourceDateEpoch: 1_781_643_617,
      buildroot: {
        version: PINNED_BUILDROOT_VERSION,
        sha256: '5a59e7501b0b4ec52c41f4bfa79412320e0b37eae5f719605a258e8d0c6fc7fb',
      },
      v86: { packageVersion: PINNED_V86_PACKAGE_VERSION, commit: PINNED_V86_COMMIT },
      daemons: { bird: PINNED_BIRD_VERSION, frr: PINNED_FRR_VERSION },
      machine: { memoryBytes: 256 * 1024 * 1024, vgaMemoryBytes: 2 * 1024 * 1024, trunkMtu: 65_535 },
      artifacts: [
        { id: 'v86-wasm', file: 'v86.wasm', size: 1, sha256: '0'.repeat(64) },
        { id: 'bios', file: 'seabios.bin', size: 1, sha256: '1'.repeat(64) },
        { id: 'vga-bios', file: 'vgabios.bin', size: 1, sha256: '2'.repeat(64) },
        { id: 'bzimage', file: 'router-bzimage.bin', size: 1, sha256: '3'.repeat(64) },
      ],
    },
    artifacts: {
      'v86-wasm': new Uint8Array([0]),
      bios: new Uint8Array([1]),
      'vga-bios': new Uint8Array([2]),
      bzimage: new Uint8Array([3]),
    },
  };
}

function ethernetFrame(etherType: number): Uint8Array {
  const frame = new Uint8Array(18);
  frame.set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  frame[12] = etherType >>> 8;
  frame[13] = etherType & 0xff;
  frame.set([1, 2, 3, 4], 14);
  return frame;
}

function hostStub(): ApplianceHostV1 {
  return {
    abiVersion: APPLIANCE_HOST_ABI_VERSION,
    nowNs: () => 0n,
    fillRandom: () => undefined,
    transmitFrame: () => undefined,
    emitEvent: () => undefined,
  };
}

function isByteArray(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Uint8Array]';
}
