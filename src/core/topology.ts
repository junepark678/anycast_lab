import { hostAddress, parseIp, parsePrefix } from './ip';
import type { LabInterface, LabLink, LabNode, LabProject, LinkEndpoint } from './types';

export interface TopologyPath {
  from: LinkEndpoint;
  to: LinkEndpoint;
  nodeIds: string[];
  linkIds: string[];
  latencyMs: number;
}

export interface AddressOwner {
  node: LabNode;
  interface?: LabInterface;
  address: string;
}

interface GraphEdge {
  to: string;
  weight: number;
  linkId?: string;
}

function endpointKey(endpoint: LinkEndpoint): string {
  return `${endpoint.nodeId}\u0000${endpoint.interfaceId}`;
}

function keyEndpoint(key: string): LinkEndpoint {
  const [nodeId = '', interfaceId = ''] = key.split('\u0000');
  return { nodeId, interfaceId };
}

export class TopologyIndex {
  readonly nodes = new Map<string, LabNode>();
  readonly links = new Map<string, LabLink>();
  private graph = new Map<string, GraphEdge[]>();

  constructor(readonly project: LabProject) {
    for (const node of project.nodes) this.nodes.set(node.id, node);
    for (const link of project.links) this.links.set(link.id, link);
    this.rebuild();
  }

  rebuild(): void {
    this.graph.clear();
    const addEdge = (from: string, edge: GraphEdge): void => {
      const edges = this.graph.get(from) ?? [];
      edges.push(edge);
      edges.sort((a, b) => a.weight - b.weight || a.to.localeCompare(b.to));
      this.graph.set(from, edges);
    };

    for (const link of this.links.values()) {
      if (link.state !== 'up') continue;
      const [first, second] = link.endpoints;
      if (!this.endpointIsUp(first) || !this.endpointIsUp(second)) continue;
      const firstKey = endpointKey(first);
      const secondKey = endpointKey(second);
      addEdge(firstKey, { to: secondKey, weight: link.latencyMs, linkId: link.id });
      addEdge(secondKey, { to: firstKey, weight: link.latencyMs, linkId: link.id });
    }

    for (const node of this.nodes.values()) {
      if (node.kind !== 'switch' || node.state !== 'up') continue;
      const active = node.interfaces.filter((iface) => iface.state === 'up');
      for (const first of active) {
        for (const second of active) {
          if (first.id === second.id) continue;
          addEdge(endpointKey({ nodeId: node.id, interfaceId: first.id }), {
            to: endpointKey({ nodeId: node.id, interfaceId: second.id }),
            weight: 0,
          });
        }
      }
    }
  }

  node(nodeId: string): LabNode | undefined {
    return this.nodes.get(nodeId);
  }

  interface(endpoint: LinkEndpoint): LabInterface | undefined {
    return this.nodes.get(endpoint.nodeId)?.interfaces.find((iface) => iface.id === endpoint.interfaceId);
  }

  endpointIsUp(endpoint: LinkEndpoint): boolean {
    const node = this.nodes.get(endpoint.nodeId);
    const iface = node?.interfaces.find((candidate) => candidate.id === endpoint.interfaceId);
    return node?.state === 'up' && iface?.state === 'up';
  }

  linksForEndpoint(endpoint: LinkEndpoint): LabLink[] {
    return [...this.links.values()].filter((link) =>
      link.endpoints.some(
        (candidate) => candidate.nodeId === endpoint.nodeId && candidate.interfaceId === endpoint.interfaceId,
      ),
    );
  }

  ownersOfAddress(address: string): AddressOwner[] {
    const canonical = parseIp(address).canonical;
    const owners: AddressOwner[] = [];
    for (const node of this.nodes.values()) {
      for (const iface of node.interfaces) {
        for (const configured of iface.addresses) {
          if (hostAddress(configured) === canonical) owners.push({ node, interface: iface, address: configured });
        }
      }
      for (const configured of node.service?.addresses ?? []) {
        const parsed = parsePrefix(configured);
        if (parsed.canonical === canonical || parsed.network === configured && parsed.networkValue === parseIp(address).value) {
          owners.push({ node, address: configured });
        }
      }
    }
    return owners;
  }

  destinationOwners(address: string): AddressOwner[] {
    const parsedAddress = parseIp(address);
    const exact = this.ownersOfAddress(address);
    const owners = [...exact];
    for (const node of this.nodes.values()) {
      for (const configured of node.service?.addresses ?? []) {
        const prefix = parsePrefix(configured);
        if (prefix.family !== parsedAddress.family) continue;
        const mask = prefix.prefixLength === 0
          ? 0n
          : (((1n << BigInt(prefix.bits)) - 1n) << BigInt(prefix.bits - prefix.prefixLength)) &
            ((1n << BigInt(prefix.bits)) - 1n);
        if ((parsedAddress.value & mask) === prefix.networkValue && !owners.some((owner) => owner.node.id === node.id)) {
          owners.push({ node, address: configured });
        }
      }
    }
    return owners;
  }

  /** Returns every routed endpoint on the same active L2 domain as `from`. */
  l2Peers(from: LinkEndpoint): TopologyPath[] {
    if (!this.endpointIsUp(from)) return [];
    const start = endpointKey(from);
    const distances = new Map<string, number>([[start, 0]]);
    const previous = new Map<string, { key: string; linkId?: string }>();
    const unvisited = new Set<string>([...this.graph.keys(), start]);

    while (unvisited.size > 0) {
      let current: string | undefined;
      let best = Number.POSITIVE_INFINITY;
      for (const key of unvisited) {
        const distance = distances.get(key) ?? Number.POSITIVE_INFINITY;
        if (distance < best || (distance === best && key < (current ?? '\uffff'))) {
          current = key;
          best = distance;
        }
      }
      if (!current || !Number.isFinite(best)) break;
      unvisited.delete(current);
      const currentEndpoint = keyEndpoint(current);
      const currentNode = this.nodes.get(currentEndpoint.nodeId);
      if (current !== start && currentNode?.kind !== 'switch') continue;
      for (const edge of this.graph.get(current) ?? []) {
        if (!unvisited.has(edge.to)) unvisited.add(edge.to);
        const candidate = best + edge.weight;
        const known = distances.get(edge.to) ?? Number.POSITIVE_INFINITY;
        if (candidate < known) {
          distances.set(edge.to, candidate);
          previous.set(edge.to, { key: current, linkId: edge.linkId });
        }
      }
    }

    const output: TopologyPath[] = [];
    for (const [key, distance] of distances) {
      if (key === start) continue;
      const target = keyEndpoint(key);
      const node = this.nodes.get(target.nodeId);
      if (!node || node.kind === 'switch') continue;
      const linkIds: string[] = [];
      const nodeIds: string[] = [];
      let cursor = key;
      while (cursor !== start) {
        const endpoint = keyEndpoint(cursor);
        if (nodeIds[0] !== endpoint.nodeId) nodeIds.unshift(endpoint.nodeId);
        const step = previous.get(cursor);
        if (!step) break;
        if (step.linkId) linkIds.unshift(step.linkId);
        cursor = step.key;
      }
      nodeIds.unshift(from.nodeId);
      output.push({ from, to: target, nodeIds, linkIds, latencyMs: distance });
    }
    return output.sort((a, b) => a.latencyMs - b.latencyMs || endpointKey(a.to).localeCompare(endpointKey(b.to)));
  }

  l2Path(from: LinkEndpoint, to: LinkEndpoint): TopologyPath | undefined {
    return this.l2Peers(from).find(
      (path) => path.to.nodeId === to.nodeId && path.to.interfaceId === to.interfaceId,
    );
  }

  findPeerByAddress(from: LinkEndpoint, address: string): { owner: AddressOwner; path: TopologyPath } | undefined {
    const owners = this.ownersOfAddress(address);
    for (const path of this.l2Peers(from)) {
      const owner = owners.find(
        (candidate) => candidate.node.id === path.to.nodeId && candidate.interface?.id === path.to.interfaceId,
      );
      if (owner) return { owner, path };
    }
    return undefined;
  }

  setLinkState(linkId: string, state: 'up' | 'down'): boolean {
    const link = this.links.get(linkId);
    if (!link || link.state === state) return false;
    link.state = state;
    this.rebuild();
    return true;
  }

  setNodeState(nodeId: string, state: 'up' | 'down'): boolean {
    const node = this.nodes.get(nodeId);
    if (!node || node.state === state) return false;
    node.state = state;
    this.rebuild();
    return true;
  }
}
