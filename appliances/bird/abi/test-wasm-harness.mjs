import { readFile } from 'node:fs/promises';
import { instantiateAnycastHostFeasibility } from './feasibility-loader.mjs';

const wasmPath = process.argv[2];
if (!wasmPath) throw new Error('usage: node test-wasm-harness.mjs <module.wasm>');

const calls = { random: 0, frame: 0, log: 0 };
const appliance = await instantiateAnycastHostFeasibility({
  wasmBinary: await readFile(wasmPath),
  nowNs: () => 42_000_000n,
  fillRandom: (target) => {
    calls.random += 1;
    target.fill(7);
  },
  transmitFrame: (interfaceIndex, frame) => {
    calls.frame += 1;
    if (interfaceIndex !== 7 || frame.byteLength !== 14) throw new Error('unexpected probe frame');
  },
  log: (level, message) => {
    calls.log += 1;
    if (level !== 1 || new TextDecoder().decode(message) !== 'anycast host ABI v1 probe') {
      throw new Error('unexpected probe log');
    }
  },
});

if (appliance.hostAbiVersion() !== 1) throw new Error('unexpected host ABI version');
if (appliance.runtimeApiVersion() !== 1) throw new Error('unexpected runtime API version');
if (appliance.probe() !== 0) throw new Error('feasibility probe failed');
if (calls.random !== 1 || calls.frame !== 1 || calls.log !== 1) {
  throw new Error(`unexpected callback counts: ${JSON.stringify(calls)}`);
}

console.log('anycast host ABI v1 WebAssembly feasibility probe: ok');
