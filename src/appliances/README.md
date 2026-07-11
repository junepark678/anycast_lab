# Appliance boundary

`abi.ts` is the engine/appliance contract. The lab engine owns simulated time
and the Ethernet fabric; an appliance owns its filesystem, daemon processes,
socket stack, RIB, and FIB. Routing-protocol semantics do not cross this ABI.

The normal worker lifecycle is:

1. send `hello` and choose a runtime descriptor;
2. send `initialize` with native files and virtual interfaces;
3. send `start`;
4. alternate `deliver-frame` and budgeted `step` requests using engine time;
5. schedule the returned `nextDeadlineNs` in the deterministic event queue;
6. consume `transmit-frame` and observed `event` messages;
7. send `stop` and `dispose`.

Binary fields are `Uint8Array` and timestamps are `bigint`; both are supported
by the structured clone algorithm. Use `workerTransferables()` when posting a
message. The runtime must treat buffers handed to host callbacks as moved.

`BirdCompatibilityRuntime` is deliberately excluded by the registry unless
the caller sends `allowCompatibility: true`. It is only a file/terminal shell
for UI development and never pretends to validate BIRD behavior.
