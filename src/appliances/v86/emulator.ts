/**
 * Narrow facade over the public v86 starter API.
 *
 * v86 intentionally exposes its event bus (`emulator.bus`) in its official
 * multi-instance and BroadcastChannel networking examples.  The lab uses the
 * same `net0-send`/`net0-receive` events so frames never touch a relay or the
 * browser's real network.
 */

export interface V86Bus {
  send(event: string, value?: unknown): void;
}

export interface V86Emulator {
  readonly bus: V86Bus;

  add_listener(event: string, listener: (value: unknown) => void): void;
  remove_listener(event: string, listener: (value: unknown) => void): void;
  run(): Promise<void>;
  stop(): Promise<void>;
  destroy(): Promise<void>;
  is_running(): boolean;
  save_state(): Promise<ArrayBuffer>;
  restore_state(state: ArrayBuffer): Promise<void>;
  create_file(path: string, contents: Uint8Array): Promise<void>;
  read_file(path: string): Promise<Uint8Array>;
  serial_send_bytes(serial: number, contents: Uint8Array): void;
}

export interface V86EmulatorOptions {
  readonly wasm_path: string;
  readonly memory_size: number;
  readonly vga_memory_size: number;
  readonly bios: { readonly buffer: ArrayBuffer };
  readonly vga_bios: { readonly buffer: ArrayBuffer };
  readonly bzimage: { readonly buffer: ArrayBuffer };
  readonly cmdline: string;
  readonly filesystem: Record<string, never>;
  readonly net_device: {
    readonly type: 'virtio';
    readonly mtu: number;
  };
  readonly virtio_console: true;
  readonly serial_console: { readonly type: 'none' };
  readonly screen: { readonly container: null };
  readonly autostart: false;
  readonly disable_keyboard: true;
  readonly disable_mouse: true;
  readonly disable_speaker: true;
  readonly acpi: boolean;
}

export type V86EmulatorFactory = (options: V86EmulatorOptions) => V86Emulator;

/** Load the pinned npm package lazily so unit tests can inject a fake VM. */
export async function loadV86PackageFactory(): Promise<V86EmulatorFactory> {
  const module = await import('v86');
  const Constructor = module.V86 as unknown as new (options: V86EmulatorOptions) => V86Emulator;
  if (typeof Constructor !== 'function') {
    throw new Error('The v86 package does not export V86');
  }
  return (options) => new Constructor(options);
}
