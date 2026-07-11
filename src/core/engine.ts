import { ADMINISTRATIVE_DISTANCE, equivalentRoute, installBestRoutes, lookupRoute, policyAllows } from './fib';
import { familyOf, hostAddress, normalizePrefix, parseIp } from './ip';
import { compatibilityRuntimeFactory, type ApplianceRuntime, type ApplianceRuntimeFactory } from './runtime';
import { DeterministicScheduler, SeededRandom } from './scheduler';
import { TopologyIndex, type TopologyPath } from './topology';
import { assertValidProject } from './validation';
import type {
  EngineSnapshot,
  IpFamily,
  LabEvent,
  LabFile,
  LabNode,
  LabProject,
  NodeRuntimeState,
  PacketTrace,
  PacketTraceHop,
  PacketTraceRequest,
  ParsedBgpConfig,
  ParsedBgpNeighbor,
  ProtocolSession,
  Route,
  TerminalResult,
} from './types';

export interface LabEngineOptions {
  runtimeFactory?: ApplianceRuntimeFactory;
}

interface BgpEndpoint {
  node: LabNode;
  config: ParsedBgpConfig;
  neighbor: ParsedBgpNeighbor;
  localAddress?: string;
  localInterfaceId?: string;
  remoteNode?: LabNode;
  path?: TopologyPath;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function routeId(...parts: Array<string | number | undefined>): string {
  return parts.filter((part) => part !== undefined).join(':');
}

function defaultPrefix(family: IpFamily): string {
  return family === 'ipv4' ? '0.0.0.0/0' : '::/0';
}

function selectedRoutes(routes: Route[]): Route[] {
  return routes.filter((route) => route.installed);
}

function sameIp(first: string | undefined, second: string | undefined): boolean {
  if (!first || !second) return false;
  try {
    return parseIp(first).canonical === parseIp(second).canonical;
  } catch {
    return false;
  }
}

function changedRoutes(before: Route[], after: Route[]): boolean {
  if (before.length !== after.length) return true;
  const right = new Map(after.map((route) => [route.id, route]));
  return before.some((route) => {
    const candidate = right.get(route.id);
    return !candidate || !equivalentRoute(route, candidate) || route.installed !== candidate.installed;
  });
}

export class LabEngine {
  readonly project: LabProject;
  private readonly scheduler = new DeterministicScheduler();
  private readonly random: SeededRandom;
  private readonly topology: TopologyIndex;
  private readonly runtimeFactory: ApplianceRuntimeFactory;
  private readonly runtimes = new Map<string, ApplianceRuntime>();
  private readonly nodeStates = new Map<string, NodeRuntimeState>();
  private sessions: ProtocolSession[] = [];
  private events: LabEvent[] = [];
  private eventId = 1;
  private converged = false;
  private disposed = false;

  private constructor(project: LabProject, options: LabEngineOptions) {
    this.project = clone(project);
    this.random = new SeededRandom(this.project.seed);
    this.topology = new TopologyIndex(this.project);
    this.runtimeFactory = options.runtimeFactory ?? compatibilityRuntimeFactory;
  }

  static async create(project: LabProject, options: LabEngineOptions = {}): Promise<LabEngine> {
    assertValidProject(project);
    const engine = new LabEngine(project, options);
    await engine.boot();
    return engine;
  }

  get nowMs(): number {
    return this.scheduler.nowMs;
  }

  snapshot(): EngineSnapshot {
    this.assertActive();
    return clone({
      projectId: this.project.id,
      nowMs: this.scheduler.nowMs,
      converged: this.converged,
      nodes: [...this.nodeStates.values()],
      sessions: this.sessions,
      events: this.events,
    });
  }

  async converge(): Promise<EngineSnapshot> {
    this.assertActive();
    this.converged = false;
    const previousSessions = this.sessions;
    this.sessions = this.discoverBgpSessions();
    this.sessions.push(...this.discoverOspfSessions());

    for (const session of this.sessions) {
      const previous = previousSessions.find((candidate) => candidate.id === session.id);
      if (!previous || previous.state !== session.state) {
        this.emit('session.state', `${session.protocol.toUpperCase()} ${session.localNodeId} → ${session.remoteNodeId}: ${session.state}`, {
          nodeId: session.localNodeId,
          sessionId: session.id,
          data: { state: session.state, reason: session.reason ?? '' },
        });
      }
    }

    this.rebuildBaseRoutes();
    const limit = this.project.settings.maxConvergenceIterations;
    let iteration = 0;
    let changed = true;
    while (changed && iteration < limit) {
      changed = this.propagateOspf() || this.propagateBgp();
      iteration += 1;
    }
    if (changed) throw new Error(`Control plane did not converge after ${limit} iterations.`);

    const convergenceDelay = Math.max(
      1,
      ...this.sessions.filter((session) => session.state === 'established').map((session) => session.sinceMs),
    );
    this.scheduler.runUntil(this.scheduler.nowMs + convergenceDelay);
    this.converged = true;
    this.emit('engine.converged', `Control plane converged after ${iteration} iteration${iteration === 1 ? '' : 's'}.`, {
      data: { iterations: iteration, sessions: this.sessions.length },
    });
    return this.snapshot();
  }

  trace(request: PacketTraceRequest): PacketTrace {
    this.assertActive();
    const startedAtMs = this.scheduler.nowMs;
    let destination: string;
    try {
      destination = parseIp(request.destination).canonical;
    } catch {
      return this.emptyTrace(request, startedAtMs, 'invalid-destination', 'Destination is not a valid IPv4 or IPv6 address.');
    }
    const family = familyOf(destination);
    const sourceNode = this.topology.node(request.sourceNodeId);
    if (!sourceNode || sourceNode.state !== 'up') {
      return this.emptyTrace(request, startedAtMs, 'unreachable', 'The source node is missing or down.', family);
    }

    const ttl = request.ttl ?? this.project.settings.defaultTtl;
    const hops: PacketTraceHop[] = [];
    const visited = new Set<string>();
    let node = sourceNode;
    let ingressInterfaceId: string | undefined;
    let cumulative = 0;
    let outcome: PacketTrace['outcome'] = 'no-route';
    let explanation = 'No matching route was installed.';

    for (let index = 0; index < ttl; index += 1) {
      if (visited.has(node.id)) {
        outcome = 'loop'; explanation = `The path returned to ${node.name}.`;
        hops.push(this.dropHop(index, node, ingressInterfaceId, cumulative, explanation));
        break;
      }
      visited.add(node.id);

      const destinationOwner = this.topology.destinationOwners(destination).some((owner) => owner.node.id === node.id);
      if (destinationOwner) {
        outcome = 'delivered'; explanation = `${destination} is served by ${node.name}.`;
        hops.push({ index, nodeId: node.id, nodeName: node.name, ingressInterfaceId, linkIds: [], latencyMs: 0, cumulativeLatencyMs: cumulative, action: 'delivered', explanation });
        this.emit('packet.delivered', explanation, { nodeId: node.id, data: { destination, traceIndex: index } });
        break;
      }

      const state = this.nodeStates.get(node.id);
      const route = state ? lookupRoute(state.routes, destination) : undefined;
      if (!route) {
        outcome = 'no-route'; explanation = `${node.name} has no route for ${destination}.`;
        hops.push(this.dropHop(index, node, ingressInterfaceId, cumulative, explanation));
        break;
      }
      if (route.disposition !== 'forward') {
        outcome = route.disposition === 'blackhole' ? 'blackhole' : route.disposition === 'prohibit' ? 'prohibited' : 'unreachable';
        explanation = `${node.name} selected a ${route.disposition} route for ${route.prefix}.`;
        hops.push({ ...this.dropHop(index, node, ingressInterfaceId, cumulative, explanation), matchedRoute: route });
        break;
      }

      const next = this.resolveForwardingPath(node, route, destination);
      if (!next) {
        outcome = 'unreachable'; explanation = `${node.name} cannot resolve the next hop for ${route.prefix}.`;
        hops.push({ ...this.dropHop(index, node, ingressInterfaceId, cumulative, explanation), matchedRoute: route });
        break;
      }

      const loss = next.path.linkIds.some((linkId) => {
        const link = this.topology.links.get(linkId);
        return link ? this.random.next() < (link.loss ?? 0) : false;
      });
      const jitter = next.path.linkIds.reduce((sum, linkId) => {
        const link = this.topology.links.get(linkId);
        const amount = link?.jitterMs ?? 0;
        return sum + (amount > 0 ? this.random.between(-amount, amount) : 0);
      }, 0);
      const latency = Math.max(0, next.path.latencyMs + jitter);
      cumulative += latency;
      const hopExplanation = `${route.source.toUpperCase()} route ${route.prefix} selected${route.nextHop ? ` via ${route.nextHop}` : ''}.`;
      hops.push({
        index, nodeId: node.id, nodeName: node.name, ingressInterfaceId,
        egressInterfaceId: next.path.from.interfaceId, matchedRoute: clone(route), nextHop: route.nextHop,
        linkIds: next.path.linkIds, latencyMs: latency, cumulativeLatencyMs: cumulative,
        action: loss ? 'dropped' : index === 0 ? 'originated' : 'forwarded',
        explanation: loss ? `Packet was lost on ${next.path.linkIds.join(', ')}.` : hopExplanation,
      });
      if (loss) { outcome = 'unreachable'; explanation = 'A link impairment dropped the packet.'; break; }
      this.emit('packet.forwarded', `${node.name} forwarded a packet for ${destination}.`, { nodeId: node.id, data: { route: route.prefix, nextNode: next.node.id } });
      ingressInterfaceId = next.path.to.interfaceId;
      node = next.node;
    }

    if (hops.length >= ttl && outcome !== 'delivered') {
      outcome = 'ttl-exceeded'; explanation = `TTL expired after ${ttl} hops.`;
    }
    const trace: PacketTrace = {
      id: `trace-${startedAtMs}-${this.eventId}`,
      startedAtMs, request: clone(request), family,
      sourceAddress: request.sourceAddress ?? sourceNode.interfaces.flatMap((networkInterface) => networkInterface.addresses).find((address) => familyOf(address) === family)?.split('/')[0],
      outcome, hops, totalLatencyMs: cumulative, explanation,
    };
    if (outcome !== 'delivered') this.emit('packet.dropped', explanation, { nodeId: node.id, data: { outcome, destination } });
    return trace;
  }

  async terminal(nodeId: string, command: string): Promise<TerminalResult> {
    this.assertActive();
    const node = this.topology.node(nodeId);
    const state = this.nodeStates.get(nodeId);
    const runtime = this.runtimes.get(nodeId);
    if (!node || !state || !runtime) throw new Error(`Unknown appliance ${nodeId}.`);
    return runtime.execute(command, {
      node, nowMs: this.scheduler.nowMs, config: state.config, routes: state.routes,
      sessions: this.sessions,
      trace: (destination) => this.trace({ sourceNodeId: nodeId, destination }),
    });
  }

  setLinkState(linkId: string, state: 'up' | 'down'): boolean {
    this.assertActive();
    const changed = this.topology.setLinkState(linkId, state);
    if (changed) {
      const projectLink = this.project.links.find((link) => link.id === linkId);
      if (projectLink) projectLink.state = state;
      this.converged = false;
      this.emit('link.state', `Link ${linkId} is ${state}.`, { linkId, data: { state } });
    }
    return changed;
  }

  setNodeState(nodeId: string, state: 'up' | 'down'): boolean {
    this.assertActive();
    const changed = this.topology.setNodeState(nodeId, state);
    if (changed) {
      const projectNode = this.project.nodes.find((node) => node.id === nodeId);
      if (projectNode) projectNode.state = state;
      this.converged = false;
      this.emit('node.state', `${projectNode?.name ?? nodeId} is ${state}.`, { nodeId, data: { state } });
    }
    return changed;
  }

  runUntil(ms: number): EngineSnapshot {
    this.assertActive();
    this.scheduler.runUntil(ms);
    return this.snapshot();
  }

  runUntilIdle(): EngineSnapshot {
    this.assertActive();
    this.scheduler.runUntilIdle();
    return this.snapshot();
  }

  async updateNodeFiles(nodeId: string, files: LabFile[]): Promise<EngineSnapshot> {
    this.assertActive();
    const node = this.topology.node(nodeId);
    const runtime = this.runtimes.get(nodeId);
    if (!node || !runtime) throw new Error(`Unknown appliance ${nodeId}.`);
    node.files = clone(files);
    const config = await runtime.reload(node.files, this.scheduler.nowMs);
    const state = this.nodeStates.get(nodeId);
    if (state) { state.config = config; state.diagnostics = clone(config.diagnostics); }
    this.converged = false;
    this.emit(config.diagnostics.some((item) => item.severity === 'error') ? 'config.error' : 'config.loaded', `Reloaded configuration on ${node.name}.`, { nodeId });
    return this.snapshot();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    await Promise.all([...this.runtimes.values()].map((runtime) => runtime.shutdown()));
    this.runtimes.clear(); this.scheduler.clear(); this.disposed = true;
  }

  private async boot(): Promise<void> {
    for (const node of this.project.nodes) {
      if (node.appliance.runtime === 'wasm' && this.runtimeFactory === compatibilityRuntimeFactory) {
        throw new Error(`${node.name} requests a native VM appliance, but no native runtime factory was supplied.`);
      }
      const runtime = await this.runtimeFactory(node);
      const config = await runtime.boot({ node, nowMs: this.scheduler.nowMs });
      this.runtimes.set(node.id, runtime);
      this.nodeStates.set(node.id, { nodeId: node.id, running: node.state === 'up', config, routes: [], diagnostics: clone(config.diagnostics) });
      this.emit(config.diagnostics.some((item) => item.severity === 'error') ? 'config.error' : 'config.loaded', `Loaded ${node.appliance.kind} files on ${node.name}.`, { nodeId: node.id });
    }
    for (const scenarioEvent of this.project.scenarioEvents) {
      this.scheduler.scheduleAt(scenarioEvent.atMs, () => {
        if (scenarioEvent.action.type === 'link-state') this.setLinkState(scenarioEvent.action.linkId, scenarioEvent.action.state);
        else this.setNodeState(scenarioEvent.action.nodeId, scenarioEvent.action.state);
      }, scenarioEvent.label ?? scenarioEvent.id);
    }
    this.emit('engine.started', `Started ${this.project.name}.`);
  }

  private rebuildBaseRoutes(): void {
    for (const node of this.project.nodes) {
      const state = this.nodeStates.get(node.id);
      if (!state) continue;
      const routes: Route[] = [];
      if (node.state === 'up') {
        for (const networkInterface of node.interfaces.filter((candidate) => candidate.state === 'up')) {
          for (const address of networkInterface.addresses) {
            routes.push({
              id: routeId(node.id, 'connected', normalizePrefix(address), networkInterface.id), nodeId: node.id,
              family: familyOf(address), prefix: normalizePrefix(address), source: 'connected',
              interfaceId: networkInterface.id, metric: 0, administrativeDistance: ADMINISTRATIVE_DISTANCE.connected,
              disposition: 'forward', selected: false, installed: false, originatedByNodeId: node.id,
            });
          }
        }
        for (const servicePrefix of node.service?.addresses ?? []) {
          routes.push({
            id: routeId(node.id, 'connected', normalizePrefix(servicePrefix), 'service'), nodeId: node.id,
            family: familyOf(servicePrefix), prefix: normalizePrefix(servicePrefix), source: 'connected', metric: 0,
            administrativeDistance: ADMINISTRATIVE_DISTANCE.connected, disposition: 'forward', selected: false,
            installed: false, originatedByNodeId: node.id,
          });
        }
        for (const configured of state.config.staticRoutes) {
          const resolved = configured.nextHop ? this.resolveDirectPeer(node, configured.nextHop) : undefined;
          const interfaceId = configured.interfaceName
            ? node.interfaces.find((candidate) => candidate.name === configured.interfaceName)?.id
            : resolved?.path.from.interfaceId;
          routes.push({
            id: routeId(node.id, 'static', normalizePrefix(configured.prefix), configured.nextHop, configured.interfaceName),
            nodeId: node.id, family: familyOf(configured.prefix), prefix: normalizePrefix(configured.prefix), source: 'static',
            nextHop: configured.nextHop, nextHopNodeId: resolved?.node.id, interfaceId,
            metric: configured.metric ?? 0, administrativeDistance: ADMINISTRATIVE_DISTANCE.static,
            disposition: configured.disposition ?? 'forward', selected: false, installed: false, originatedByNodeId: node.id,
          });
        }
        const gateways = new Set([node.client?.defaultGateway, ...node.interfaces.map((candidate) => candidate.gateway)].filter((gateway): gateway is string => Boolean(gateway)));
        for (const gateway of gateways) {
          const resolved = this.resolveDirectPeer(node, gateway);
          routes.push({
            id: routeId(node.id, 'client', gateway), nodeId: node.id, family: familyOf(gateway), prefix: defaultPrefix(familyOf(gateway)),
            source: 'client', nextHop: gateway, nextHopNodeId: resolved?.node.id, interfaceId: resolved?.path.from.interfaceId,
            metric: 0, administrativeDistance: ADMINISTRATIVE_DISTANCE.client, disposition: 'forward', selected: false, installed: false,
          });
        }
      }
      state.routes = installBestRoutes(routes);
    }
  }

  private discoverBgpSessions(): ProtocolSession[] {
    const endpoints: BgpEndpoint[] = [];
    for (const node of this.project.nodes) {
      const state = this.nodeStates.get(node.id);
      if (!state || node.state !== 'up') continue;
      for (const config of state.config.bgp) {
        for (const neighbor of config.neighbors) {
          const resolved = this.resolveDirectPeer(node, neighbor.address);
          const localConfiguredAddress = resolved
            ? node.interfaces
                .find((candidate) => candidate.id === resolved.path.from.interfaceId)
                ?.addresses.find((address) => familyOf(address) === familyOf(neighbor.address))
            : undefined;
          endpoints.push({
            node,
            config,
            neighbor,
            localAddress: localConfiguredAddress ? hostAddress(localConfiguredAddress) : undefined,
            localInterfaceId: resolved?.path.from.interfaceId,
            remoteNode: resolved?.node,
            path: resolved?.path,
          });
        }
      }
    }
    const sessions: ProtocolSession[] = [];
    for (const endpoint of endpoints) {
      for (const family of endpoint.neighbor.addressFamilies) {
        const remote = endpoint.remoteNode;
        const reverse = remote ? endpoints.find((candidate) => candidate.node.id === remote.id && candidate.remoteNode?.id === endpoint.node.id && sameIp(candidate.neighbor.address, endpoint.localAddress) && candidate.neighbor.addressFamilies.includes(family)) : undefined;
        let state: ProtocolSession['state'] = 'established';
        let reason = 'Established';
        if (!remote || !endpoint.path) { state = 'down'; reason = 'Neighbor is not directly reachable'; }
        else if (!reverse) { state = 'idle'; reason = 'Remote neighbor is not configured'; }
        else if (endpoint.neighbor.remoteAs !== reverse.config.localAs || reverse.neighbor.remoteAs !== endpoint.config.localAs) { state = 'mismatch'; reason = 'AS number mismatch'; }
        const sinceMs = Math.max(1, 100 + (endpoint.path?.latencyMs ?? 0) * 2);
        sessions.push({
          id: routeId('bgp', endpoint.node.id, endpoint.config.instanceName, remote?.id ?? endpoint.neighbor.address, family),
          protocol: 'bgp', localNodeId: endpoint.node.id, remoteNodeId: remote?.id ?? endpoint.neighbor.address,
          localInstance: endpoint.config.instanceName, remoteInstance: reverse?.config.instanceName,
          localAddress: endpoint.localAddress, remoteAddress: endpoint.neighbor.address,
          localAs: endpoint.config.localAs, remoteAs: endpoint.neighbor.remoteAs,
          family, state, sinceMs, reason, prefixesReceived: 0, prefixesAdvertised: 0,
        });
      }
    }
    return sessions;
  }

  private discoverOspfSessions(): ProtocolSession[] {
    const sessions: ProtocolSession[] = [];
    for (const node of this.project.nodes) {
      const local = this.nodeStates.get(node.id);
      if (!local || node.state !== 'up') continue;
      for (const config of local.config.ospf) {
        for (const networkInterface of node.interfaces) {
          for (const peer of this.topology.l2Peers({ nodeId: node.id, interfaceId: networkInterface.id })) {
            const remoteNode = this.topology.node(peer.to.nodeId);
            const remote = remoteNode ? this.nodeStates.get(remoteNode.id) : undefined;
            const remoteConfig = remote?.config.ospf.find((candidate) => candidate.family === config.family);
            if (!remoteNode || !remoteConfig) continue;
            const area = config.areas.find((candidate) => candidate.interfacePatterns.includes('*') || candidate.interfacePatterns.includes(networkInterface.name))?.area ?? config.areas[0]?.area;
            const remoteInterface = remoteNode.interfaces.find((candidate) => candidate.id === peer.to.interfaceId);
            const remoteArea = remoteConfig.areas.find((candidate) => candidate.interfacePatterns.includes('*') || (remoteInterface && candidate.interfacePatterns.includes(remoteInterface.name)))?.area ?? remoteConfig.areas[0]?.area;
            const established = area !== undefined && area === remoteArea;
            sessions.push({ id: routeId('ospf', node.id, remoteNode.id, config.family, networkInterface.id), protocol: 'ospf', localNodeId: node.id, remoteNodeId: remoteNode.id, localInstance: config.instanceName, remoteInstance: remoteConfig.instanceName, area, family: config.family, state: established ? 'established' : 'mismatch', sinceMs: 40 + peer.latencyMs * 2, reason: established ? 'Full' : 'Area mismatch', prefixesReceived: 0, prefixesAdvertised: 0 });
          }
        }
      }
    }
    return sessions;
  }

  private propagateBgp(): boolean {
    let anyChanged = false;
    for (const session of this.sessions.filter((candidate) => candidate.protocol === 'bgp' && candidate.state === 'established')) {
      const local = this.nodeStates.get(session.localNodeId);
      const remote = this.nodeStates.get(session.remoteNodeId);
      const localNode = this.topology.node(session.localNodeId);
      const remoteNode = this.topology.node(session.remoteNodeId);
      if (!local || !remote || !localNode || !remoteNode) continue;
      const localConfig = local.config.bgp.find((candidate) => candidate.instanceName === session.localInstance);
      const localNeighbor = localConfig?.neighbors.find((candidate) => sameIp(candidate.address, session.remoteAddress));
      const remoteConfig = remote.config.bgp.find((candidate) => candidate.instanceName === session.remoteInstance);
      const remoteNeighbor = remoteConfig?.neighbors.find((candidate) => sameIp(candidate.address, session.localAddress));
      if (!localConfig || !localNeighbor || !remoteConfig || !remoteNeighbor) continue;

      const learned: Route[] = [];
      let advertised = 0;
      for (const route of selectedRoutes(remote.routes)) {
        // A local blackhole/reject route is commonly used to originate an
        // aggregate. Its local forwarding disposition is not transmitted in
        // BGP; the receiver installs a normal route toward this speaker.
        if (route.family !== session.family) continue;
        if (route.source === 'bgp' && route.learnedFromNodeId === localNode.id) continue;
        if (remote.config.daemon === 'frr' && route.source !== 'bgp' && !remoteConfig.networks.some((prefix) => normalizePrefix(prefix) === normalizePrefix(route.prefix))) continue;
        if (!policyAllows(route.prefix, remoteNeighbor.exportPolicy, remoteNeighbor.exportPrefixes)) continue;
        if (!policyAllows(route.prefix, localNeighbor.importPolicy, localNeighbor.importPrefixes)) continue;
        const external = localConfig.localAs !== remoteConfig.localAs;
        const oldPath = route.bgp?.asPath ?? [];
        const shouldPrepend = external && !remoteNeighbor.routeServerClient;
        const asPath = shouldPrepend && oldPath[0] !== remoteConfig.localAs ? [remoteConfig.localAs, ...oldPath] : [...oldPath];
        if (asPath.includes(localConfig.localAs)) continue;
        advertised += 1;
        learned.push({
          id: routeId(localNode.id, 'bgp', route.prefix, remoteNode.id, session.localInstance, asPath.join('-')),
          nodeId: localNode.id, family: route.family, prefix: route.prefix, source: 'bgp', protocolInstance: session.localInstance,
          nextHop: session.remoteAddress, nextHopNodeId: remoteNode.id,
          interfaceId: this.resolveDirectPath(localNode, remoteNode)?.from.interfaceId,
          metric: this.resolveDirectPath(localNode, remoteNode)?.latencyMs ?? 0,
          administrativeDistance: external ? ADMINISTRATIVE_DISTANCE.ebgp : ADMINISTRATIVE_DISTANCE.ibgp,
          disposition: 'forward', selected: false, installed: false,
          learnedFromNodeId: remoteNode.id, originatedByNodeId: route.originatedByNodeId ?? remoteNode.id,
          bgp: { asPath, localPreference: 100, med: 0, origin: route.bgp?.origin ?? (route.source === 'connected' ? 'igp' : 'incomplete'), communities: route.bgp?.communities ?? [] },
        });
      }
      session.prefixesAdvertised = advertised;
      session.prefixesReceived = learned.length;
      const withoutPeer = local.routes.filter((route) => !(route.source === 'bgp' && route.learnedFromNodeId === remoteNode.id && route.protocolInstance === session.localInstance));
      const next = installBestRoutes([...withoutPeer, ...learned]);
      if (changedRoutes(local.routes, next)) { local.routes = next; anyChanged = true; }
    }
    return anyChanged;
  }

  private propagateOspf(): boolean {
    let anyChanged = false;
    for (const session of this.sessions.filter((candidate) => candidate.protocol === 'ospf' && candidate.state === 'established')) {
      const local = this.nodeStates.get(session.localNodeId);
      const remote = this.nodeStates.get(session.remoteNodeId);
      const localNode = this.topology.node(session.localNodeId);
      const remoteNode = this.topology.node(session.remoteNodeId);
      if (!local || !remote || !localNode || !remoteNode) continue;
      const learned = selectedRoutes(remote.routes).filter((route) => route.family === session.family && (route.source === 'connected' || route.source === 'ospf' || route.source === 'static')).map((route) => ({
        ...clone(route), id: routeId(localNode.id, 'ospf', route.prefix, remoteNode.id), nodeId: localNode.id,
        source: 'ospf' as const, protocolInstance: session.localInstance, nextHopNodeId: remoteNode.id,
        nextHop: remoteNode.interfaces.flatMap((networkInterface) => networkInterface.addresses).find((address) => familyOf(address) === session.family)?.split('/')[0],
        interfaceId: this.resolveDirectPath(localNode, remoteNode)?.from.interfaceId,
        metric: route.metric + Math.max(1, Math.round(this.resolveDirectPath(localNode, remoteNode)?.latencyMs ?? 1)),
        administrativeDistance: ADMINISTRATIVE_DISTANCE.ospf, selected: false, installed: false,
        learnedFromNodeId: remoteNode.id, originatedByNodeId: route.originatedByNodeId ?? remoteNode.id,
      }));
      const withoutPeer = local.routes.filter((route) => !(route.source === 'ospf' && route.learnedFromNodeId === remoteNode.id));
      const next = installBestRoutes([...withoutPeer, ...learned]);
      if (changedRoutes(local.routes, next)) { local.routes = next; anyChanged = true; }
    }
    return anyChanged;
  }

  private resolveDirectPeer(node: LabNode, address: string): { node: LabNode; path: TopologyPath } | undefined {
    for (const networkInterface of node.interfaces) {
      const peer = this.topology.findPeerByAddress({ nodeId: node.id, interfaceId: networkInterface.id }, address);
      if (peer) return { node: peer.owner.node, path: peer.path };
    }
    return undefined;
  }

  private resolveDirectPath(from: LabNode, to: LabNode): TopologyPath | undefined {
    for (const networkInterface of from.interfaces) {
      const path = this.topology.l2Peers({ nodeId: from.id, interfaceId: networkInterface.id }).find((candidate) => candidate.to.nodeId === to.id);
      if (path) return path;
    }
    return undefined;
  }

  private resolveForwardingPath(node: LabNode, route: Route, destination: string): { node: LabNode; path: TopologyPath } | undefined {
    const preferred = route.nextHopNodeId ? this.topology.node(route.nextHopNodeId) : undefined;
    if (preferred) {
      const path = this.resolveDirectPath(node, preferred);
      if (path) return { node: preferred, path };
    }
    if (route.nextHop) {
      const peer = this.resolveDirectPeer(node, route.nextHop);
      if (peer) return peer;
    }
    const owners = this.topology.destinationOwners(destination);
    for (const owner of owners) {
      const path = this.resolveDirectPath(node, owner.node);
      if (path) return { node: owner.node, path };
    }
    return undefined;
  }

  private dropHop(index: number, node: LabNode, ingressInterfaceId: string | undefined, cumulativeLatencyMs: number, explanation: string): PacketTraceHop {
    return { index, nodeId: node.id, nodeName: node.name, ingressInterfaceId, linkIds: [], latencyMs: 0, cumulativeLatencyMs, action: 'dropped', explanation };
  }

  private emptyTrace(request: PacketTraceRequest, startedAtMs: number, outcome: PacketTrace['outcome'], explanation: string, family?: IpFamily): PacketTrace {
    return { id: `trace-${startedAtMs}-${this.eventId}`, startedAtMs, request: clone(request), family, outcome, hops: [], totalLatencyMs: 0, explanation };
  }

  private emit(type: LabEvent['type'], message: string, fields: Partial<Omit<LabEvent, 'id' | 'atMs' | 'type' | 'message'>> = {}): void {
    this.events.push({ id: this.eventId++, atMs: this.scheduler.nowMs, type, message, ...fields });
    if (this.events.length > this.project.settings.captureLimit) this.events.splice(0, this.events.length - this.project.settings.captureLimit);
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('Lab engine has been disposed.');
  }
}
