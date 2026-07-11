/**
 * Loader for the ABI-only feasibility module. This file is intentionally
 * dependency-free so the import object remains visible and auditable.
 */
export async function instantiateAnycastHostFeasibility(options) {
  let memory;
  const callbacks = {
    nowNs: options.nowNs,
    fillRandom: options.fillRandom,
    transmitFrame: options.transmitFrame,
    log: options.log,
  };

  const imports = {
    anycast_host_v1: {
      now_ns: () => BigInt(callbacks.nowNs()),
      fill_random: (pointer, length) => {
        try {
          callbacks.fillRandom(view(memory, pointer, length));
          return 0;
        } catch {
          return -3;
        }
      },
      transmit_frame: (interfaceIndex, pointer, length) => {
        try {
          callbacks.transmitFrame(interfaceIndex, view(memory, pointer, length).slice());
          return 0;
        } catch {
          return -3;
        }
      },
      log: (level, pointer, length) => {
        callbacks.log(level, view(memory, pointer, length).slice());
      },
    },
  };

  const binary = await resolveBinary(options.wasmBinary);
  const result = await WebAssembly.instantiate(binary, imports);
  const instance = result instanceof WebAssembly.Instance ? result : result.instance;
  memory = requiredExport(instance.exports, 'memory');

  const hostAbiVersion = requiredFunction(instance.exports, 'anycast_appliance_host_abi_version');
  const runtimeApiVersion = requiredFunction(instance.exports, 'anycast_appliance_runtime_api_version');
  const probe = requiredFunction(instance.exports, 'anycast_feasibility_probe');

  return {
    instance,
    hostAbiVersion: () => Number(hostAbiVersion()),
    runtimeApiVersion: () => Number(runtimeApiVersion()),
    probe: () => Number(probe()),
  };
}

function view(memory, pointer, length) {
  if (!(memory instanceof WebAssembly.Memory)) throw new Error('WASM memory is not initialized');
  return new Uint8Array(memory.buffer, pointer, length);
}

async function resolveBinary(value) {
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value;
  const url = value ?? new URL('./anycast-host-feasibility.wasm', import.meta.url);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Unable to load feasibility WASM: ${response.status}`);
  return response.arrayBuffer();
}

function requiredExport(exports, name) {
  const value = exports[name];
  if (value === undefined) throw new Error(`Missing WASM export: ${name}`);
  return value;
}

function requiredFunction(exports, name) {
  const value = requiredExport(exports, name);
  if (typeof value !== 'function') throw new Error(`WASM export is not callable: ${name}`);
  return value;
}
