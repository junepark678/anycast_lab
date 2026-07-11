import { lookupRoute, policyAllows } from './fib';
import { normalizePrefix, parseIp } from './ip';
import { parseNativeConfig } from './config';
import type {
  ApplianceKind,
  LabFile,
  LabNode,
  PacketTrace,
  ParsedApplianceConfig,
  ProtocolSession,
  Route,
  TerminalResult,
} from './types';

export interface ApplianceBootContext {
  node: LabNode;
  nowMs: number;
}

export interface RuntimeCommandContext {
  node: LabNode;
  nowMs: number;
  config: ParsedApplianceConfig;
  routes: Route[];
  sessions: ProtocolSession[];
  trace(destination: string): PacketTrace;
}

/**
 * Boundary implemented by today's educational compatibility runtime and, in a
 * later build, by the real BIRD/FRR Linux appliance hosted by v86/WebAssembly.
 */
export interface ApplianceRuntime {
  readonly runtimeKind: 'compatibility' | 'wasm';
  readonly applianceKind: ApplianceKind;
  boot(context: ApplianceBootContext): Promise<ParsedApplianceConfig>;
  reload(files: LabFile[], nowMs: number): Promise<ParsedApplianceConfig>;
  execute(command: string, context: RuntimeCommandContext): Promise<TerminalResult>;
  shutdown(): Promise<void>;
}

export type ApplianceRuntimeFactory = (
  node: LabNode,
) => ApplianceRuntime | Promise<ApplianceRuntime>;

function routeCode(route: Route): string {
  if (route.source === 'connected') return 'C';
  if (route.source === 'static') return 'S';
  if (route.source === 'ospf') return 'O';
  if (route.source === 'bgp') return 'B';
  return 'K';
}

function formatNextHop(route: Route): string {
  if (route.disposition !== 'forward') return route.disposition;
  if (route.nextHop) return `via ${route.nextHop}`;
  if (route.interfaceId) return `dev ${route.interfaceId}`;
  return 'direct';
}

function renderBirdRoutes(routes: Route[]): string {
  const selected = routes.filter((route) => route.installed);
  if (selected.length === 0) return 'Network not found';
  return selected
    .map((route) => {
      const source = route.source === 'bgp' ? 'BGP' : route.source === 'ospf' ? 'OSPF' : route.source;
      const path = route.bgp?.asPath.length ? ` [AS path: ${route.bgp.asPath.join(' ')}]` : '';
      return `${route.prefix.padEnd(24)} ${formatNextHop(route).padEnd(24)} [${source} ${route.metric}] *${path}`;
    })
    .join('\n');
}

function renderFrrRoutes(routes: Route[], family: 'ipv4' | 'ipv6'): string {
  const selected = routes.filter((route) => route.installed && route.family === family);
  const header = 'Codes: C - connected, S - static, O - OSPF, B - BGP\n';
  if (selected.length === 0) return `${header}\nNo routes`;
  return `${header}\n${selected
    .map(
      (route) =>
        `${routeCode(route)}>* ${route.prefix} [${route.administrativeDistance}/${route.metric}] ${formatNextHop(route)}`,
    )
    .join('\n')}`;
}

function renderTraceroute(trace: PacketTrace): string {
  const lines = [`traceroute to ${trace.request.destination}, ${trace.request.ttl ?? 32} hops max`];
  for (const hop of trace.hops) {
    lines.push(`${String(hop.index + 1).padStart(2)}  ${hop.nodeName}  ${hop.cumulativeLatencyMs.toFixed(1)} ms  ${hop.explanation}`);
  }
  if (trace.outcome !== 'delivered') lines.push(`trace ended: ${trace.outcome} (${trace.explanation})`);
  return lines.join('\n');
}

function commandBody(command: string): string {
  const trimmed = command.trim();
  const birdc = trimmed.match(/^birdc(?:\s+-s\s+\S+)?\s+(.+)$/i);
  if (birdc?.[1]) return birdc[1].trim();
  const vty = trimmed.match(/^vtysh\s+-c\s+["'](.+)["']$/i);
  if (vty?.[1]) return vty[1].trim();
  return trimmed;
}

export class CompatibilityApplianceRuntime implements ApplianceRuntime {
  readonly runtimeKind = 'compatibility' as const;
  readonly applianceKind: ApplianceKind;
  private node: LabNode;
  private config?: ParsedApplianceConfig;

  constructor(node: LabNode) {
    this.node = node;
    this.applianceKind = node.appliance.kind;
  }

  async boot(context: ApplianceBootContext): Promise<ParsedApplianceConfig> {
    this.node = context.node;
    this.config = parseNativeConfig(this.node);
    return this.config;
  }

  async reload(files: LabFile[], _nowMs: number): Promise<ParsedApplianceConfig> {
    this.node.files = files.map((file) => ({ ...file }));
    this.config = parseNativeConfig(this.node);
    return this.config;
  }

  async execute(command: string, context: RuntimeCommandContext): Promise<TerminalResult> {
    const body = commandBody(command);
    let output = '';
    let exitCode = 0;
    if (this.applianceKind === 'bird') {
      ({ output, exitCode } = this.executeBird(body, context));
    } else if (this.applianceKind === 'frr') {
      ({ output, exitCode } = this.executeFrr(body, context));
    } else {
      ({ output, exitCode } = this.executeEndpoint(body, context));
    }
    return { nodeId: context.node.id, command, output, exitCode, atMs: context.nowMs };
  }

  async shutdown(): Promise<void> {
    this.config = undefined;
  }

  private executeBird(
    command: string,
    context: RuntimeCommandContext,
  ): Pick<TerminalResult, 'output' | 'exitCode'> {
    const lower = command.toLowerCase();
    if (lower === 'configure check' || lower === 'configure' || lower === 'reload') {
      const errors = context.config.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
      return errors.length === 0
        ? {
            output: lower === 'configure check'
              ? 'Compatibility parser: supported configuration syntax is OK\nNative birdc validation requires the Linux VM runtime.'
              : 'Reading configuration from appliance\nCompatibility runtime reconfigured',
            exitCode: 0,
          }
        : {
            output: errors
              .map((diagnostic) => `${diagnostic.file ?? '<config>'}:${diagnostic.line ?? 0}: ${diagnostic.message}`)
              .join('\n'),
            exitCode: 1,
          };
    }
    if (lower === 'show protocols' || lower === 'show protocols all') {
      const lines = ['Name             Proto    Table    State  Since       Info'];
      for (const session of context.sessions.filter((candidate) => candidate.localNodeId === context.node.id)) {
        lines.push(
          `${(session.localInstance ?? session.protocol).padEnd(16)} ${session.protocol.toUpperCase().padEnd(8)} master   ${session.state === 'established' ? 'up' : 'down'}     ${session.sinceMs.toFixed(0).padStart(6)}ms   ${session.reason ?? session.state}`,
        );
      }
      if (lines.length === 1) lines.push('No configured protocol sessions');
      return { output: lines.join('\n'), exitCode: 0 };
    }
    if (lower.startsWith('show route export ')) {
      const name = command.split(/\s+/)[3];
      const instance = context.config.bgp.find((candidate) => candidate.instanceName === name);
      const neighbor = instance?.neighbors[0];
      if (!instance || !neighbor) return { output: `Unknown protocol ${name ?? ''}`, exitCode: 1 };
      return {
        output: renderBirdRoutes(
          context.routes.filter((route) =>
            policyAllows(route.prefix, neighbor.exportPolicy, neighbor.exportPrefixes),
          ),
        ),
        exitCode: 0,
      };
    }
    if (lower.startsWith('show route for ')) {
      const destination = command.split(/\s+/)[3];
      if (!destination || !parseIp(destination)) return { output: 'Invalid address', exitCode: 1 };
      const route = lookupRoute(context.routes, destination);
      return { output: route ? renderBirdRoutes([route]) : 'Network not found', exitCode: route ? 0 : 1 };
    }
    if (lower === 'show route' || lower === 'show route all') {
      return { output: renderBirdRoutes(context.routes), exitCode: 0 };
    }
    if (lower === 'show status') {
      return {
        output: `BIRD ${context.node.appliance.version ?? 'compatibility'}\nRouter ID is ${context.config.routerId ?? context.node.routerId ?? '0.0.0.0'}\nDaemon is up and running`,
        exitCode: 0,
      };
    }
    if (lower === 'help' || lower === '?') {
      return {
        output: 'show status\nshow protocols [all]\nshow route [all|for ADDRESS|export PROTOCOL]\nconfigure check\nconfigure',
        exitCode: 0,
      };
    }
    return { output: `syntax error, unexpected ${command || '<empty>'}`, exitCode: 1 };
  }

  private executeFrr(
    command: string,
    context: RuntimeCommandContext,
  ): Pick<TerminalResult, 'output' | 'exitCode'> {
    const lower = command.toLowerCase();
    if (lower === 'show running-config' || lower === 'show run') {
      const entrypoint = context.node.appliance.entrypoint;
      const file = context.node.files.find((candidate) => candidate.path === entrypoint || candidate.entrypoint) ?? context.node.files[0];
      return { output: file?.content ?? '', exitCode: file ? 0 : 1 };
    }
    if (lower === 'show ip route') return { output: renderFrrRoutes(context.routes, 'ipv4'), exitCode: 0 };
    if (lower === 'show ipv6 route') return { output: renderFrrRoutes(context.routes, 'ipv6'), exitCode: 0 };
    if (lower === 'show ip bgp' || lower === 'show bgp ipv4 unicast') {
      const routes = context.routes.filter((route) => route.source === 'bgp' && route.family === 'ipv4');
      return { output: renderBirdRoutes(routes), exitCode: 0 };
    }
    if (lower === 'show bgp ipv6 unicast') {
      const routes = context.routes.filter((route) => route.source === 'bgp' && route.family === 'ipv6');
      return { output: renderBirdRoutes(routes), exitCode: 0 };
    }
    if (lower === 'show bgp summary' || lower === 'show ip bgp summary') {
      const sessions = context.sessions.filter(
        (session) => session.localNodeId === context.node.id && session.protocol === 'bgp',
      );
      const lines = [
        `BGP router identifier ${context.config.routerId ?? context.node.routerId ?? '0.0.0.0'}, local AS number ${context.config.bgp[0]?.localAs ?? context.node.asn ?? 0}`,
        'Neighbor          AS       State/PfxRcd',
      ];
      for (const session of sessions) {
        lines.push(
          `${(session.remoteAddress ?? session.remoteNodeId).padEnd(17)} ${String(session.remoteAs ?? 0).padEnd(8)} ${session.state === 'established' ? session.prefixesReceived : session.state}`,
        );
      }
      return { output: lines.join('\n'), exitCode: 0 };
    }
    if (lower === 'show ip ospf neighbor' || lower === 'show ipv6 ospf6 neighbor') {
      const family = lower.includes('ospf6') ? 'ipv6' : 'ipv4';
      const sessions = context.sessions.filter(
        (session) => session.localNodeId === context.node.id && session.protocol === 'ospf' && session.family === family,
      );
      const lines = ['Neighbor ID       State           Address'];
      for (const session of sessions) {
        lines.push(`${session.remoteNodeId.padEnd(17)} ${session.state === 'established' ? 'Full' : 'Down'}            ${session.remoteAddress ?? '-'}`);
      }
      return { output: lines.join('\n'), exitCode: 0 };
    }
    if (lower === 'help' || lower === '?') {
      return {
        output: 'show bgp summary\nshow ip bgp\nshow bgp ipv6 unicast\nshow ip route\nshow ipv6 route\nshow ip ospf neighbor\nshow running-config',
        exitCode: 0,
      };
    }
    return { output: `% Unknown command: ${command}`, exitCode: 1 };
  }

  private executeEndpoint(
    command: string,
    context: RuntimeCommandContext,
  ): Pick<TerminalResult, 'output' | 'exitCode'> {
    const lower = command.toLowerCase();
    if (lower === 'ip addr' || lower === 'ip address') {
      return {
        output: context.node.interfaces
          .map(
            (iface, index) =>
              `${index + 1}: ${iface.name}: <${iface.state.toUpperCase()}> mtu ${iface.mtu ?? 1500}\n${iface.addresses
                .map((address) => `    inet${address.includes(':') ? '6' : ''} ${address}`)
                .join('\n')}`,
          )
          .join('\n'),
        exitCode: 0,
      };
    }
    if (lower === 'ip route' || lower === 'ip -6 route') {
      const family = lower.includes('-6') ? 'ipv6' : 'ipv4';
      const routes = context.routes.filter((route) => route.family === family && route.installed);
      return { output: routes.map((route) => `${route.prefix} ${formatNextHop(route)}`).join('\n'), exitCode: 0 };
    }
    const ping = command.match(/^ping(?:6)?\s+([^\s]+)$/i);
    if (ping?.[1]) {
      const trace = context.trace(ping[1]);
      return trace.outcome === 'delivered'
        ? {
            output: `PING ${ping[1]}\n64 bytes from ${ping[1]}: icmp_seq=1 ttl=${Math.max(1, 64 - trace.hops.length)} time=${(trace.totalLatencyMs * 2).toFixed(1)} ms\n\n1 packets transmitted, 1 received, 0% packet loss`,
            exitCode: 0,
          }
        : {
            output: `PING ${ping[1]}\nFrom ${context.node.name}: Destination ${trace.outcome}\n\n1 packets transmitted, 0 received, 100% packet loss`,
            exitCode: 1,
          };
    }
    const traceroute = command.match(/^(?:traceroute|tracepath|trace)\s+([^\s]+)$/i);
    if (traceroute?.[1]) {
      const trace = context.trace(traceroute[1]);
      return { output: renderTraceroute(trace), exitCode: trace.outcome === 'delivered' ? 0 : 1 };
    }
    if (lower === 'help' || lower === '?') {
      return { output: 'ip addr\nip route\nip -6 route\nping ADDRESS\ntraceroute ADDRESS', exitCode: 0 };
    }
    return { output: `${command}: command not found`, exitCode: 127 };
  }
}

export const compatibilityRuntimeFactory: ApplianceRuntimeFactory = (node) =>
  new CompatibilityApplianceRuntime(node);

export function canonicalDestination(value: string): string | undefined {
  try {
    return parseIp(value).canonical;
  } catch {
    return undefined;
  }
}

export function routeDisplayPrefix(route: Route): string {
  return normalizePrefix(route.prefix);
}
