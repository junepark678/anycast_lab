import {
  APPLIANCE_HOST_ABI_VERSION,
  type ApplianceBootRequest,
  type ApplianceFile,
  type ApplianceFrame,
  type ApplianceInspectionSnapshot,
  type ApplianceObservedEvent,
  type ApplianceRuntimeDescriptor,
  type ApplianceStepResult,
  type ApplianceTerminalOpenRequest,
} from './abi';

export const APPLIANCE_WORKER_PROTOCOL_VERSION = 1 as const;
export type ApplianceWorkerProtocolVersion = typeof APPLIANCE_WORKER_PROTOCOL_VERSION;

interface WorkerEnvelope {
  readonly protocolVersion: ApplianceWorkerProtocolVersion;
}

interface WorkerRequestEnvelope extends WorkerEnvelope {
  readonly requestId: string;
}

export type ApplianceWorkerRequest =
  | (WorkerRequestEnvelope & { readonly type: 'hello' })
  | (WorkerRequestEnvelope & {
      readonly type: 'initialize';
      readonly runtimeId: string;
      readonly boot: ApplianceBootRequest;
      readonly allowCompatibility: boolean;
    })
  | (WorkerRequestEnvelope & { readonly type: 'start' })
  | (WorkerRequestEnvelope & {
      readonly type: 'step';
      readonly nowNs: bigint;
      readonly maxWorkItems: number;
    })
  | (WorkerRequestEnvelope & { readonly type: 'deliver-frame'; readonly frame: ApplianceFrame })
  | (WorkerRequestEnvelope & {
      readonly type: 'set-interface-state';
      readonly interfaceId: string;
      readonly up: boolean;
    })
  | (WorkerRequestEnvelope & { readonly type: 'write-file'; readonly file: ApplianceFile })
  | (WorkerRequestEnvelope & { readonly type: 'read-file'; readonly path: string })
  | (WorkerRequestEnvelope & {
      readonly type: 'open-terminal';
      readonly terminal: ApplianceTerminalOpenRequest;
    })
  | (WorkerRequestEnvelope & {
      readonly type: 'write-terminal';
      readonly sessionId: string;
      readonly data: Uint8Array;
    })
  | (WorkerRequestEnvelope & {
      readonly type: 'resize-terminal';
      readonly sessionId: string;
      readonly columns: number;
      readonly rows: number;
    })
  | (WorkerRequestEnvelope & { readonly type: 'close-terminal'; readonly sessionId: string })
  | (WorkerRequestEnvelope & { readonly type: 'inspect' })
  | (WorkerRequestEnvelope & { readonly type: 'stop'; readonly reason?: string })
  | (WorkerRequestEnvelope & { readonly type: 'dispose' });

export interface ApplianceWorkerHello {
  readonly workerProtocolVersion: ApplianceWorkerProtocolVersion;
  readonly hostAbiVersion: typeof APPLIANCE_HOST_ABI_VERSION;
  readonly runtimes: readonly ApplianceRuntimeDescriptor[];
}

export type ApplianceWorkerResult =
  | { readonly type: 'hello'; readonly hello: ApplianceWorkerHello }
  | { readonly type: 'initialized'; readonly descriptor: ApplianceRuntimeDescriptor; readonly warnings: readonly string[] }
  | { readonly type: 'ack' }
  | { readonly type: 'step'; readonly result: ApplianceStepResult }
  | { readonly type: 'file'; readonly file: ApplianceFile | null }
  | { readonly type: 'terminal-opened'; readonly sessionId: string }
  | { readonly type: 'inspection'; readonly snapshot: ApplianceInspectionSnapshot };

export type ApplianceWorkerResponse =
  | (WorkerEnvelope & {
      readonly type: 'response';
      readonly requestId: string;
      readonly ok: true;
      readonly result: ApplianceWorkerResult;
    })
  | (WorkerEnvelope & {
      readonly type: 'response';
      readonly requestId: string;
      readonly ok: false;
      readonly error: {
        readonly name: string;
        readonly message: string;
        readonly stack?: string;
      };
    });

export type ApplianceWorkerEvent =
  | (WorkerEnvelope & { readonly type: 'event'; readonly event: ApplianceObservedEvent })
  | (WorkerEnvelope & { readonly type: 'transmit-frame'; readonly frame: ApplianceFrame });

export type ApplianceWorkerMessage = ApplianceWorkerRequest | ApplianceWorkerResponse | ApplianceWorkerEvent;

const REQUEST_TYPES = new Set<ApplianceWorkerRequest['type']>([
  'hello',
  'initialize',
  'start',
  'step',
  'deliver-frame',
  'set-interface-state',
  'write-file',
  'read-file',
  'open-terminal',
  'write-terminal',
  'resize-terminal',
  'close-terminal',
  'inspect',
  'stop',
  'dispose',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isByteArray(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Uint8Array]';
}

function isTransferableArrayBuffer(value: unknown): value is ArrayBuffer {
  return Object.prototype.toString.call(value) === '[object ArrayBuffer]';
}

function isFile(value: unknown): value is ApplianceFile {
  return (
    isRecord(value) &&
    isNonEmptyString(value.path) &&
    isByteArray(value.contents) &&
    (value.mode === undefined || (typeof value.mode === 'number' && Number.isSafeInteger(value.mode)))
  );
}

function isFrame(value: unknown): value is ApplianceFrame {
  return isRecord(value) && isNonEmptyString(value.interfaceId) && isByteArray(value.bytes);
}

function isTerminalRequest(value: unknown): value is ApplianceTerminalOpenRequest {
  return (
    isRecord(value) &&
    isNonEmptyString(value.terminal) &&
    isPositiveInteger(value.columns) &&
    isPositiveInteger(value.rows)
  );
}

function isBootRequest(value: unknown): value is ApplianceBootRequest {
  if (!isRecord(value)) return false;
  if (
    !isNonEmptyString(value.nodeId) ||
    !isNonEmptyString(value.hostname) ||
    !isNonEmptyString(value.entrypoint) ||
    !Array.isArray(value.argv) ||
    !value.argv.every((item) => typeof item === 'string') ||
    !isRecord(value.environment) ||
    !Object.values(value.environment).every((item) => typeof item === 'string') ||
    !Array.isArray(value.files) ||
    !value.files.every(isFile) ||
    !Array.isArray(value.interfaces) ||
    !isNonEmptyString(value.randomSeed)
  ) {
    return false;
  }

  return value.interfaces.every(
    (item) =>
      isRecord(item) &&
      isNonEmptyString(item.id) &&
      isNonEmptyString(item.name) &&
      isNonEmptyString(item.mac) &&
      isPositiveInteger(item.mtu) &&
      typeof item.up === 'boolean' &&
      Array.isArray(item.addresses),
  );
}

/** Validates an entire request before a value crosses into runtime code. */
export function isApplianceWorkerRequest(value: unknown): value is ApplianceWorkerRequest {
  if (!isRecord(value)) return false;
  if (
    value.protocolVersion !== APPLIANCE_WORKER_PROTOCOL_VERSION ||
    !isNonEmptyString(value.requestId) ||
    typeof value.type !== 'string' ||
    !REQUEST_TYPES.has(value.type as ApplianceWorkerRequest['type'])
  ) {
    return false;
  }

  switch (value.type as ApplianceWorkerRequest['type']) {
    case 'hello':
    case 'start':
    case 'inspect':
    case 'dispose':
      return true;
    case 'initialize':
      return (
        isNonEmptyString(value.runtimeId) &&
        typeof value.allowCompatibility === 'boolean' &&
        isBootRequest(value.boot)
      );
    case 'step':
      return typeof value.nowNs === 'bigint' && value.nowNs >= 0n && isPositiveInteger(value.maxWorkItems);
    case 'deliver-frame':
      return isFrame(value.frame);
    case 'set-interface-state':
      return isNonEmptyString(value.interfaceId) && typeof value.up === 'boolean';
    case 'write-file':
      return isFile(value.file);
    case 'read-file':
      return isNonEmptyString(value.path);
    case 'open-terminal':
      return isTerminalRequest(value.terminal);
    case 'write-terminal':
      return isNonEmptyString(value.sessionId) && isByteArray(value.data);
    case 'resize-terminal':
      return (
        isNonEmptyString(value.sessionId) &&
        isPositiveInteger(value.columns) &&
        isPositiveInteger(value.rows)
      );
    case 'close-terminal':
      return isNonEmptyString(value.sessionId);
    case 'stop':
      return value.reason === undefined || typeof value.reason === 'string';
  }
}

export function assertApplianceWorkerRequest(value: unknown): asserts value is ApplianceWorkerRequest {
  if (!isApplianceWorkerRequest(value)) {
    throw new Error(`Invalid appliance worker request for protocol v${APPLIANCE_WORKER_PROTOCOL_VERSION}`);
  }
}

export function workerSuccess(
  requestId: string,
  result: ApplianceWorkerResult,
): ApplianceWorkerResponse {
  return {
    protocolVersion: APPLIANCE_WORKER_PROTOCOL_VERSION,
    type: 'response',
    requestId,
    ok: true,
    result,
  };
}

export function workerFailure(requestId: string, error: unknown): ApplianceWorkerResponse {
  const normalized = error instanceof Error ? error : new Error(String(error));
  return {
    protocolVersion: APPLIANCE_WORKER_PROTOCOL_VERSION,
    type: 'response',
    requestId,
    ok: false,
    error: {
      name: normalized.name,
      message: normalized.message,
      ...(normalized.stack === undefined ? {} : { stack: normalized.stack }),
    },
  };
}

export function workerEvent(event: ApplianceObservedEvent): ApplianceWorkerEvent {
  return { protocolVersion: APPLIANCE_WORKER_PROTOCOL_VERSION, type: 'event', event };
}

export function workerTransmitFrame(frame: ApplianceFrame): ApplianceWorkerEvent {
  return { protocolVersion: APPLIANCE_WORKER_PROTOCOL_VERSION, type: 'transmit-frame', frame };
}

/**
 * Finds buffers that can be transferred rather than cloned by postMessage.
 * SharedArrayBuffers are deliberately excluded because they are not transferable.
 */
export function workerTransferables(message: ApplianceWorkerMessage): Transferable[] {
  const buffers = new Set<ArrayBuffer>();
  const visit = (value: unknown): void => {
    if (isByteArray(value) && isTransferableArrayBuffer(value.buffer)) {
      buffers.add(value.buffer);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (isRecord(value)) {
      for (const item of Object.values(value)) visit(item);
    }
  };

  visit(message);
  return [...buffers];
}
