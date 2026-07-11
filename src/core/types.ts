/**
 * Serializable domain model for Anycast Lab.
 *
 * Native daemon files are deliberately stored as text and never regenerated
 * from the parsed compatibility model. This makes a project safe to export and
 * later boot with a real BIRD/FRR Linux appliance hosted by the WebAssembly emulator.
 */

export const CURRENT_SCHEMA_VERSION = 1 as const;

export type IpFamily = 'ipv4' | 'ipv6';
export type NodeKind = 'router' | 'route-server' | 'client' | 'service' | 'switch';
export type ApplianceKind = 'bird' | 'frr' | 'client' | 'service' | 'switch';
export type RuntimeKind = 'compatibility' | 'wasm';
export type OperationalState = 'up' | 'down';

export interface Point {
  x: number;
  y: number;
}

export interface LabFile {
  /** Absolute path inside the appliance, for example /etc/bird/bird.conf. */
  path: string;
  /** Exact file contents. The compatibility engine never rewrites this. */
  content: string;
  encoding?: 'utf-8';
  /** Marks the daemon entrypoint when an appliance has multiple files. */
  entrypoint?: boolean;
}

export interface ApplianceDefinition {
  kind: ApplianceKind;
  runtime: RuntimeKind;
  version?: string;
  entrypoint?: string;
}

export interface LabInterface {
  id: string;
  name: string;
  mac?: string;
  /** CIDR strings, e.g. 192.0.2.1/31 or 2001:db8::1/64. */
  addresses: string[];
  state: OperationalState;
  mtu?: number;
  /** Useful for client appliances. Routers normally learn routes dynamically. */
  gateway?: string;
}

export interface ClientOptions {
  defaultGateway?: string;
  dnsServers?: string[];
}

export interface ServiceOptions {
  /** Addresses or advertised prefixes accepted by this endpoint. */
  addresses: string[];
  protocols?: Array<'icmp' | 'tcp' | 'udp' | 'http' | 'dns'>;
}

export interface LabNode {
  id: string;
  name: string;
  kind: NodeKind;
  appliance: ApplianceDefinition;
  interfaces: LabInterface[];
  files: LabFile[];
  state: OperationalState;
  position?: Point;
  asn?: number;
  routerId?: string;
  client?: ClientOptions;
  service?: ServiceOptions;
  tags?: string[];
}

export interface LinkEndpoint {
  nodeId: string;
  interfaceId: string;
}

export interface LabLink {
  id: string;
  name?: string;
  endpoints: [LinkEndpoint, LinkEndpoint];
  state: OperationalState;
  latencyMs: number;
  jitterMs?: number;
  loss?: number;
  bandwidthMbps?: number;
  mtu?: number;
}

export type ScenarioEventAction =
  | { type: 'link-state'; linkId: string; state: OperationalState }
  | { type: 'node-state'; nodeId: string; state: OperationalState };

export interface ScenarioEvent {
  id: string;
  atMs: number;
  action: ScenarioEventAction;
  label?: string;
}

export interface LabSettings {
  defaultTtl: number;
  maxConvergenceIterations: number;
  captureLimit: number;
}

export interface LabProject {
  schemaVersion: typeof CURRENT_SCHEMA_VERSION;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** Seed used for deterministic loss/jitter decisions. */
  seed: number;
  nodes: LabNode[];
  links: LabLink[];
  scenarioEvents: ScenarioEvent[];
  settings: LabSettings;
}

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface ConfigDiagnostic {
  severity: DiagnosticSeverity;
  message: string;
  file?: string;
  line?: number;
  column?: number;
  code?: string;
}

export type RoutePolicyMode = 'all' | 'none' | 'configured';

export interface ParsedStaticRoute {
  prefix: string;
  nextHop?: string;
  interfaceName?: string;
  disposition?: 'forward' | 'blackhole' | 'unreachable' | 'prohibit';
  metric?: number;
}

export interface ParsedBgpNeighbor {
  address: string;
  remoteAs: number;
  localAs?: number;
  description?: string;
  addressFamilies: IpFamily[];
  importPolicy: RoutePolicyMode;
  exportPolicy: RoutePolicyMode;
  importPrefixes?: string[];
  exportPrefixes?: string[];
  multihop?: number;
  routeServerClient?: boolean;
}

export interface ParsedBgpConfig {
  instanceName: string;
  localAs: number;
  routerId?: string;
  networks: string[];
  neighbors: ParsedBgpNeighbor[];
}

export interface ParsedOspfArea {
  area: string;
  networks: string[];
  interfacePatterns: string[];
}

export interface ParsedOspfConfig {
  instanceName: string;
  family: IpFamily;
  areas: ParsedOspfArea[];
  redistribute: Array<'connected' | 'static' | 'bgp'>;
}

export interface ParsedApplianceConfig {
  daemon: ApplianceKind;
  routerId?: string;
  interfaces: Array<{ name: string; addresses: string[] }>;
  staticRoutes: ParsedStaticRoute[];
  bgp: ParsedBgpConfig[];
  ospf: ParsedOspfConfig[];
  diagnostics: ConfigDiagnostic[];
  /** Source files are preserved so `show running-config` remains exact. */
  sourceFiles: LabFile[];
}

export type ProtocolKind = 'bgp' | 'ospf';
export type SessionState = 'idle' | 'connecting' | 'established' | 'down' | 'mismatch';

export interface ProtocolSession {
  id: string;
  protocol: ProtocolKind;
  localNodeId: string;
  remoteNodeId: string;
  localInstance?: string;
  remoteInstance?: string;
  localAddress?: string;
  remoteAddress?: string;
  localAs?: number;
  remoteAs?: number;
  area?: string;
  family: IpFamily;
  state: SessionState;
  sinceMs: number;
  reason?: string;
  prefixesReceived: number;
  prefixesAdvertised: number;
}

export type RouteSource = 'connected' | 'static' | 'bgp' | 'ospf' | 'client';
export type RouteDisposition = 'forward' | 'blackhole' | 'unreachable' | 'prohibit';

export interface BgpAttributes {
  asPath: number[];
  localPreference: number;
  med: number;
  origin: 'igp' | 'egp' | 'incomplete';
  communities: string[];
}

export interface Route {
  id: string;
  nodeId: string;
  family: IpFamily;
  prefix: string;
  source: RouteSource;
  protocolInstance?: string;
  nextHop?: string;
  nextHopNodeId?: string;
  interfaceId?: string;
  metric: number;
  administrativeDistance: number;
  disposition: RouteDisposition;
  selected: boolean;
  installed: boolean;
  learnedFromNodeId?: string;
  originatedByNodeId?: string;
  bgp?: BgpAttributes;
}

export interface NodeRuntimeState {
  nodeId: string;
  running: boolean;
  config: ParsedApplianceConfig;
  routes: Route[];
  diagnostics: ConfigDiagnostic[];
}

export type LabEventType =
  | 'engine.started'
  | 'engine.converged'
  | 'config.loaded'
  | 'config.error'
  | 'link.state'
  | 'node.state'
  | 'session.state'
  | 'route.installed'
  | 'route.withdrawn'
  | 'packet.forwarded'
  | 'packet.delivered'
  | 'packet.dropped';

export interface LabEvent {
  id: number;
  atMs: number;
  type: LabEventType;
  nodeId?: string;
  linkId?: string;
  sessionId?: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface PacketTraceRequest {
  sourceNodeId: string;
  destination: string;
  sourceAddress?: string;
  protocol?: 'icmp' | 'tcp' | 'udp';
  destinationPort?: number;
  ttl?: number;
}

export type PacketTraceOutcome =
  | 'delivered'
  | 'no-route'
  | 'blackhole'
  | 'unreachable'
  | 'prohibited'
  | 'link-down'
  | 'ttl-exceeded'
  | 'loop'
  | 'invalid-destination';

export interface PacketTraceHop {
  index: number;
  nodeId: string;
  nodeName: string;
  ingressInterfaceId?: string;
  egressInterfaceId?: string;
  matchedRoute?: Route;
  nextHop?: string;
  linkIds: string[];
  latencyMs: number;
  cumulativeLatencyMs: number;
  action: 'originated' | 'forwarded' | 'delivered' | 'dropped';
  explanation: string;
}

export interface PacketTrace {
  id: string;
  startedAtMs: number;
  request: PacketTraceRequest;
  family?: IpFamily;
  sourceAddress?: string;
  outcome: PacketTraceOutcome;
  hops: PacketTraceHop[];
  totalLatencyMs: number;
  explanation: string;
}

export interface TerminalResult {
  nodeId: string;
  command: string;
  output: string;
  exitCode: number;
  atMs: number;
}

export interface EngineSnapshot {
  projectId: string;
  nowMs: number;
  converged: boolean;
  nodes: NodeRuntimeState[];
  sessions: ProtocolSession[];
  events: LabEvent[];
}

export interface ValidationIssue {
  path: string;
  message: string;
  code: string;
  severity: 'error' | 'warning';
}

export interface ValidationResult<T> {
  success: boolean;
  value?: T;
  issues: ValidationIssue[];
}

export function createEmptyProject(
  input: Partial<Pick<LabProject, 'id' | 'name' | 'seed'>> = {},
): LabProject {
  const now = new Date().toISOString();
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: input.id ?? 'untitled-lab',
    name: input.name ?? 'Untitled lab',
    createdAt: now,
    updatedAt: now,
    seed: input.seed ?? 1,
    nodes: [],
    links: [],
    scenarioEvents: [],
    settings: {
      defaultTtl: 32,
      maxConvergenceIterations: 64,
      captureLimit: 10_000,
    },
  };
}
