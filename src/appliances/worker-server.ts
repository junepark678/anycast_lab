import {
  APPLIANCE_HOST_ABI_VERSION,
  type ApplianceHostV1,
  type ApplianceRuntime,
} from './abi';
import { type ApplianceRuntimeRegistry } from './registry';
import {
  APPLIANCE_WORKER_PROTOCOL_VERSION,
  assertApplianceWorkerRequest,
  type ApplianceWorkerMessage,
  type ApplianceWorkerRequest,
  type ApplianceWorkerResult,
  workerEvent,
  workerFailure,
  workerSuccess,
  workerTransferables,
  workerTransmitFrame,
} from './worker-protocol';

export interface ApplianceWorkerTransport {
  postMessage(message: ApplianceWorkerMessage, transfer?: Transferable[]): void;
}

export interface ApplianceWorkerClock {
  nowNs(): bigint;
}

/** Runtime dispatcher shared by a real Worker entrypoint and unit tests. */
export class ApplianceWorkerServer {
  readonly #registry: ApplianceRuntimeRegistry;
  readonly #transport: ApplianceWorkerTransport;
  readonly #clock: ApplianceWorkerClock;
  readonly #fillRandom: (target: Uint8Array) => void;
  #runtime: ApplianceRuntime | null = null;

  constructor(options: {
    registry: ApplianceRuntimeRegistry;
    transport: ApplianceWorkerTransport;
    clock: ApplianceWorkerClock;
    fillRandom: (target: Uint8Array) => void;
  }) {
    this.#registry = options.registry;
    this.#transport = options.transport;
    this.#clock = options.clock;
    this.#fillRandom = options.fillRandom;
  }

  async receive(value: unknown): Promise<void> {
    let request: ApplianceWorkerRequest;
    try {
      assertApplianceWorkerRequest(value);
      request = value;
    } catch (error) {
      const requestId =
        typeof value === 'object' && value !== null && 'requestId' in value && typeof value.requestId === 'string'
          ? value.requestId
          : 'invalid-request';
      this.#post(workerFailure(requestId, error));
      return;
    }

    try {
      const result = await this.#dispatch(request);
      this.#post(workerSuccess(request.requestId, result));
    } catch (error) {
      this.#post(workerFailure(request.requestId, error));
    }
  }

  async #dispatch(request: ApplianceWorkerRequest): Promise<ApplianceWorkerResult> {
    switch (request.type) {
      case 'hello':
        return {
          type: 'hello',
          hello: {
            workerProtocolVersion: APPLIANCE_WORKER_PROTOCOL_VERSION,
            hostAbiVersion: APPLIANCE_HOST_ABI_VERSION,
            runtimes: this.#registry.list(),
          },
        };
      case 'initialize': {
        if (this.#runtime !== null) throw new Error('Worker already has an initialized runtime');
        const descriptor = this.#registry
          .list()
          .find((candidate) => candidate.runtimeId === request.runtimeId);
        if (descriptor === undefined) throw new Error(`Unknown appliance runtime: ${request.runtimeId}`);

        const runtime = this.#registry.create({
          kind: descriptor.kind,
          runtimeId: request.runtimeId,
          allowCompatibility: request.allowCompatibility,
        });
        const host: ApplianceHostV1 = {
          abiVersion: APPLIANCE_HOST_ABI_VERSION,
          nowNs: () => this.#clock.nowNs(),
          fillRandom: this.#fillRandom,
          transmitFrame: (frame) => this.#post(workerTransmitFrame(frame)),
          emitEvent: (event) => this.#post(workerEvent(event)),
        };
        const boot = await runtime.initialize(request.boot, host);
        this.#runtime = runtime;
        return { type: 'initialized', descriptor: runtime.descriptor, warnings: boot.warnings };
      }
      case 'start':
        await this.#requireRuntime().start();
        return { type: 'ack' };
      case 'step':
        return {
          type: 'step',
          result: await this.#requireRuntime().step({
            nowNs: request.nowNs,
            maxWorkItems: request.maxWorkItems,
          }),
        };
      case 'deliver-frame':
        await this.#requireRuntime().deliverFrame(request.frame);
        return { type: 'ack' };
      case 'set-interface-state':
        await this.#requireRuntime().setInterfaceState(request.interfaceId, request.up);
        return { type: 'ack' };
      case 'write-file':
        await this.#requireRuntime().writeFile(request.file);
        return { type: 'ack' };
      case 'read-file':
        return { type: 'file', file: await this.#requireRuntime().readFile(request.path) };
      case 'open-terminal':
        return {
          type: 'terminal-opened',
          sessionId: await this.#requireRuntime().openTerminal(request.terminal),
        };
      case 'write-terminal':
        await this.#requireRuntime().writeTerminal(request.sessionId, request.data);
        return { type: 'ack' };
      case 'resize-terminal':
        await this.#requireRuntime().resizeTerminal(request.sessionId, request.columns, request.rows);
        return { type: 'ack' };
      case 'close-terminal':
        await this.#requireRuntime().closeTerminal(request.sessionId);
        return { type: 'ack' };
      case 'inspect':
        return { type: 'inspection', snapshot: await this.#requireRuntime().inspect() };
      case 'stop':
        await this.#requireRuntime().stop(request.reason);
        return { type: 'ack' };
      case 'dispose':
        await this.#requireRuntime().dispose();
        this.#runtime = null;
        return { type: 'ack' };
    }
  }

  #requireRuntime(): ApplianceRuntime {
    if (this.#runtime === null) throw new Error('Worker runtime is not initialized');
    return this.#runtime;
  }

  #post(message: ApplianceWorkerMessage): void {
    this.#transport.postMessage(message, workerTransferables(message));
  }
}
