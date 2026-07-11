/**
 * Versioned contract between an appliance runtime and the lab engine.
 *
 * The engine owns simulated time and the Ethernet fabric. An appliance owns
 * its userspace networking stack, daemon processes, filesystem, and FIB. The
 * ABI intentionally exposes frames instead of protocol-specific operations so
 * a real daemon can remain authoritative for routing decisions.
 */

export const APPLIANCE_HOST_ABI_VERSION = 1 as const;
export type ApplianceHostAbiVersion = typeof APPLIANCE_HOST_ABI_VERSION;

export const APPLIANCE_RUNTIME_API_VERSION = 1 as const;
export type ApplianceRuntimeApiVersion = typeof APPLIANCE_RUNTIME_API_VERSION;

export type ApplianceKind = 'bird' | 'frr' | 'client';
export type ApplianceFidelity = 'native' | 'compatibility';
export type ApplianceLifecycleState =
  | 'new'
  | 'initialized'
  | 'running'
  | 'stopped'
  | 'failed'
  | 'disposed';

export interface ApplianceCapabilitySet {
  readonly ethernet: boolean;
  readonly ipv4: boolean;
  readonly ipv6: boolean;
  readonly nativeConfig: boolean;
  readonly packetCapture: boolean;
  readonly terminals: readonly string[];
  readonly protocols: readonly string[];
}

export interface ApplianceRuntimeDescriptor {
  /** Stable ID for selecting this exact implementation, e.g. bird-2.17.1-wasm. */
  readonly runtimeId: string;
  readonly displayName: string;
  readonly kind: ApplianceKind;
  readonly fidelity: ApplianceFidelity;
  /** Upstream daemon version, or null for a compatibility implementation. */
  readonly upstreamVersion: string | null;
  /** Reproducible artifact/build identifier. */
  readonly buildId: string;
  readonly runtimeApiVersion: ApplianceRuntimeApiVersion;
  readonly hostAbiVersion: ApplianceHostAbiVersion;
  readonly capabilities: ApplianceCapabilitySet;
  /** Compatibility runtimes must enumerate what they do not faithfully model. */
  readonly limitations: readonly string[];
}

export interface ApplianceFile {
  /** Absolute POSIX path inside the appliance. */
  readonly path: string;
  readonly contents: Uint8Array;
  /** POSIX permission bits. Defaults to 0644 when omitted. */
  readonly mode?: number;
}

export interface ApplianceInterfaceAddress {
  readonly family: 'ipv4' | 'ipv6';
  readonly address: string;
  readonly prefixLength: number;
}

export interface ApplianceInterfaceSpec {
  /** Stable topology-facing identifier. */
  readonly id: string;
  /** Guest-visible name, e.g. eth0. */
  readonly name: string;
  readonly mac: string;
  readonly mtu: number;
  readonly up: boolean;
  readonly addresses: readonly ApplianceInterfaceAddress[];
}

export interface ApplianceBootRequest {
  readonly nodeId: string;
  readonly hostname: string;
  readonly entrypoint: string;
  readonly argv: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly files: readonly ApplianceFile[];
  readonly interfaces: readonly ApplianceInterfaceSpec[];
  /** Seed supplied by the project for deterministic appliance entropy. */
  readonly randomSeed: string;
}

export interface ApplianceBootResult {
  readonly state: 'initialized';
  readonly warnings: readonly string[];
}

export interface ApplianceFrame {
  readonly interfaceId: string;
  readonly bytes: Uint8Array;
}

export type ApplianceLogLevel = 'debug' | 'info' | 'warning' | 'error';

export type ApplianceObservedEvent =
  | {
      readonly type: 'lifecycle';
      readonly state: ApplianceLifecycleState;
      readonly detail?: string;
    }
  | {
      readonly type: 'log';
      readonly level: ApplianceLogLevel;
      readonly source: string;
      readonly message: string;
    }
  | {
      readonly type: 'file-changed';
      readonly path: string;
      readonly contents: Uint8Array;
      readonly mode: number;
    }
  | {
      readonly type: 'terminal-output';
      readonly sessionId: string;
      readonly data: Uint8Array;
    }
  | {
      readonly type: 'inspection-changed';
      readonly revision: number;
    };

/**
 * Synchronous callbacks made by a runtime while it is being stepped.
 * Implementations must not retain or mutate byte arrays after the callback.
 */
export interface ApplianceHostV1 {
  readonly abiVersion: ApplianceHostAbiVersion;
  nowNs(): bigint;
  fillRandom(target: Uint8Array): void;
  transmitFrame(frame: ApplianceFrame): void;
  emitEvent(event: ApplianceObservedEvent): void;
}

export interface ApplianceStepRequest {
  readonly nowNs: bigint;
  /** Cooperative work budget, interpreted as callbacks/events rather than CPU time. */
  readonly maxWorkItems: number;
}

export interface ApplianceStepResult {
  readonly state: ApplianceLifecycleState;
  readonly workItems: number;
  /** Earliest simulated time at which the runtime needs another step. */
  readonly nextDeadlineNs: bigint | null;
  readonly hasImmediateWork: boolean;
}

export interface ApplianceRouteSnapshot {
  readonly family: 'ipv4' | 'ipv6';
  readonly prefix: string;
  readonly source: string;
  readonly metric: number | null;
  readonly nextHops: readonly {
    readonly via: string | null;
    readonly interfaceId: string;
    readonly weight: number;
  }[];
}

export interface ApplianceProtocolSnapshot {
  readonly name: string;
  readonly protocol: string;
  readonly state: string;
  readonly sinceNs: bigint | null;
  readonly detail?: string;
}

export interface ApplianceInspectionSnapshot {
  readonly revision: number;
  readonly lifecycle: ApplianceLifecycleState;
  readonly interfaces: readonly ApplianceInterfaceSpec[];
  readonly routes: readonly ApplianceRouteSnapshot[];
  readonly protocols: readonly ApplianceProtocolSnapshot[];
}

export interface ApplianceTerminalOpenRequest {
  readonly terminal: string;
  readonly columns: number;
  readonly rows: number;
}

export interface ApplianceRuntime {
  readonly apiVersion: ApplianceRuntimeApiVersion;
  readonly descriptor: ApplianceRuntimeDescriptor;
  readonly state: ApplianceLifecycleState;

  initialize(request: ApplianceBootRequest, host: ApplianceHostV1): Promise<ApplianceBootResult>;
  start(): Promise<void>;
  step(request: ApplianceStepRequest): Promise<ApplianceStepResult>;
  deliverFrame(frame: ApplianceFrame): Promise<void>;
  setInterfaceState(interfaceId: string, up: boolean): Promise<void>;
  writeFile(file: ApplianceFile): Promise<void>;
  readFile(path: string): Promise<ApplianceFile | null>;
  openTerminal(request: ApplianceTerminalOpenRequest): Promise<string>;
  writeTerminal(sessionId: string, data: Uint8Array): Promise<void>;
  resizeTerminal(sessionId: string, columns: number, rows: number): Promise<void>;
  closeTerminal(sessionId: string): Promise<void>;
  inspect(): Promise<ApplianceInspectionSnapshot>;
  stop(reason?: string): Promise<void>;
  dispose(): Promise<void>;
}

export function assertCompatibleDescriptor(
  descriptor: ApplianceRuntimeDescriptor,
): void {
  if (descriptor.runtimeApiVersion !== APPLIANCE_RUNTIME_API_VERSION) {
    throw new Error(
      `Runtime ${descriptor.runtimeId} uses runtime API ${descriptor.runtimeApiVersion}; ` +
        `this build requires ${APPLIANCE_RUNTIME_API_VERSION}`,
    );
  }

  if (descriptor.hostAbiVersion !== APPLIANCE_HOST_ABI_VERSION) {
    throw new Error(
      `Runtime ${descriptor.runtimeId} uses host ABI ${descriptor.hostAbiVersion}; ` +
        `this build requires ${APPLIANCE_HOST_ABI_VERSION}`,
    );
  }

  if (descriptor.fidelity === 'compatibility' && descriptor.limitations.length === 0) {
    throw new Error(`Compatibility runtime ${descriptor.runtimeId} must declare its limitations`);
  }
}
