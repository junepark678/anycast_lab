import type {
  ApplianceKind,
  ApplianceInspectionSnapshot,
  ApplianceObservedEvent,
  ApplianceRuntimeDescriptor,
} from '../appliances/abi';
import type { DiagnosticSeverity, OperationalState } from '../core/types';

export type NativeLabEngineState =
  | 'new'
  | 'starting'
  | 'running'
  | 'pausing'
  | 'paused'
  | 'stopping'
  | 'stopped'
  | 'failed'
  | 'disposed';

export interface NativeProjectDiagnostic {
  readonly severity: DiagnosticSeverity;
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly nodeId?: string;
  readonly linkId?: string;
}

export interface NativeProjectEligibility {
  readonly eligible: boolean;
  readonly diagnostics: readonly NativeProjectDiagnostic[];
  readonly runtimes: Readonly<Record<string, ApplianceRuntimeDescriptor>>;
}

export type NativeLabEventType =
  | 'engine.state'
  | 'runtime.initialized'
  | 'runtime.event'
  | 'runtime.error'
  | 'link.state'
  | 'interface.state'
  | 'node.state'
  | 'frame.transmitted'
  | 'frame.delivered'
  | 'frame.dropped'
  | 'capture.cleared';

export interface NativeLabEvent {
  readonly sequence: number;
  readonly atNs: bigint;
  readonly type: NativeLabEventType;
  readonly message: string;
  readonly nodeId?: string;
  readonly interfaceId?: string;
  readonly linkId?: string;
  readonly runtimeEvent?: ApplianceObservedEvent;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export type NativeFrameDirection = 'egress' | 'ingress' | 'dropped';

export type NativeFrameDropReason =
  | 'engine-not-running'
  | 'unknown-node'
  | 'unknown-interface'
  | 'node-down'
  | 'interface-down'
  | 'no-link'
  | 'link-down'
  | 'loss'
  | 'mtu-exceeded'
  | 'malformed-frame'
  | 'switch-loop'
  | 'runtime-unavailable'
  | 'runtime-error';

/** A byte-exact Ethernet observation made by the native fabric. */
export interface NativeCapturedFrame {
  readonly sequence: number;
  /** Stable identifier shared by every observation of one emitted frame. */
  readonly frameId: number;
  readonly atNs: bigint;
  readonly direction: NativeFrameDirection;
  readonly nodeId: string;
  readonly interfaceId: string;
  readonly linkId?: string;
  readonly bytes: Uint8Array;
  readonly dropReason?: NativeFrameDropReason;
}

export interface NativePacketCapture {
  readonly format: 'anycast-lab-ethernet-capture-v1';
  readonly projectId: string;
  readonly generatedAtNs: bigint;
  readonly captureLimit: number;
  readonly frames: readonly NativeCapturedFrame[];
  readonly events: readonly NativeLabEvent[];
}

export interface NativeTerminalOutput {
  readonly sessionId: string;
  readonly nodeId: string;
  readonly terminal: string;
  readonly atNs: bigint;
  readonly data: Uint8Array;
}

export interface NativeTerminalOpenOptions {
  readonly terminal?: string;
  readonly columns?: number;
  readonly rows?: number;
  readonly onOutput?: (output: NativeTerminalOutput) => void;
}

export interface NativeTerminalSession {
  readonly id: string;
  readonly nodeId: string;
  readonly terminal: string;
  readonly columns: number;
  readonly rows: number;
}

export interface NativeApplianceInspection {
  readonly nodeId: string;
  readonly descriptor: ApplianceRuntimeDescriptor;
  readonly snapshot: ApplianceInspectionSnapshot;
}

export interface NativePgoProfileFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

/** Destructive profile export from one instrumented native router appliance. */
export interface NativePgoProfileCollection {
  readonly nodeId: string;
  readonly kind: Extract<ApplianceKind, 'bird' | 'frr'>;
  readonly archive: Uint8Array;
  readonly files: readonly NativePgoProfileFile[];
}

export interface NativeLabEngineOptions {
  /** When false, callers advance deterministic time explicitly with `advanceBy`. */
  readonly autoRun?: boolean;
  readonly maxWorkItemsPerStep?: number;
  readonly maxImmediateSteps?: number;
  readonly maxEventsPerAdvance?: number;
  readonly onEvent?: (event: NativeLabEvent) => void;
  readonly onFrame?: (frame: NativeCapturedFrame) => void;
  readonly onTerminalOutput?: (output: NativeTerminalOutput) => void;
  /** Injectable monotonic wall clock used only by automatic playback. */
  readonly wallNowMs?: () => number;
  readonly setTimer?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

export interface NativeLinkStateChange {
  readonly linkId: string;
  readonly state: OperationalState;
}

export interface NativeInterfaceStateChange {
  readonly nodeId: string;
  readonly interfaceId: string;
  readonly state: OperationalState;
}
