# BIRD WebAssembly appliance port

Status: **feasibility scaffold; no native BIRD runtime is produced yet.**

This directory pins BIRD, defines the C side of appliance host ABI v1, and
contains reproducible fetch/build entrypoints. The TypeScript compatibility
runtime in `src/appliances/mock` is an explicit UI/development fallback; it
does not run BIRD, parse `bird.conf`, establish sessions, or forward packets.

## What works now

- BIRD 2.17.1 downloads are SHA-256 verified before extraction.
- `scripts/test-native-harness.sh` compiles and executes the host ABI probe on
  the native host. This validates the C callback shapes and ownership rules,
  not BIRD itself.
- `scripts/build-host-shim.sh` compiles the same probe to WebAssembly when a
  pinned Emscripten toolchain is installed.
- `scripts/build-bird-wasm.sh` contains the configure/link recipe and refuses
  to label an unported Unix build as a browser appliance.

## Reproduce the currently passing probe

```sh
cd appliances/bird
./scripts/test-native-harness.sh
```

With Emscripten 4.0.10 available:

```sh
./scripts/build-host-shim.sh
```

That produces `dist/anycast-host-feasibility.{mjs,wasm}`. It still does not
contain BIRD.

## Attempt the BIRD build

```sh
./scripts/fetch-upstream.sh
./scripts/prepare-source.sh
./scripts/build-bird-wasm.sh
```

The final command currently exits at the native-port readiness gate. This is
intentional and prevents a Unix build that happens to emit a `.wasm` file from
being registered as a working appliance. Once the required patch series below
is present, the same command runs `emconfigure`, `configure`, and `emmake` with
the pinned BGP-focused feature set.

## Required upstream-facing port work

Patches belong in `patches/`, in the order named by `patches/series`. Keep the
patches small and organized around the OS boundary:

1. Add `sysdep/cf/anycast-wasm.h` and a `sysdep/anycast-wasm` backend.
2. Replace the Unix `main()`/infinite `io_loop()` with exported create, step,
   next-deadline, and dispose entrypoints.
3. Route monotonic time and entropy through `anycast_host_abi.h`.
4. Map BIRD sockets/poll readiness to the appliance userspace TCP/IP stack.
5. Map interface discovery and Kernel protocol route synchronization to the
   appliance virtual kernel.
6. Replace Unix control sockets with an in-memory `birdc` transport.
7. Prove configuration parsing, BGP packet exchange, RIB-to-FIB installation,
   and data-plane forwarding in differential tests against native BIRD.

The port is not complete merely when it links. A native runtime descriptor
must not be registered until the end-to-end route/packet tests pass.

## ABI ownership rules

- Guest memory belongs to the appliance. The host copies frame/log/random data
  during an import call and never retains guest pointers.
- The engine owns simulated time. Daemon code must not read wall-clock time.
- Calls are synchronous within one cooperative appliance step.
- Ethernet frames, not BGP-specific objects, cross the host boundary.
- ABI additions are append-only within v1 and guarded by `struct_size`; a
  breaking change increments both the C and TypeScript versions.

## Licensing

BIRD is GPL-2.0-or-later. The upstream tarball is downloaded at build time and
is not vendored here. Distribution of a compiled appliance must include the
corresponding source and patch set as required by BIRD's license.
