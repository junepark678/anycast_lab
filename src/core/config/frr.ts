import { normalizePrefix, tryParseIp, tryParsePrefix } from '../ip';
import type {
  ConfigDiagnostic,
  IpFamily,
  LabNode,
  ParsedApplianceConfig,
  ParsedBgpConfig,
  ParsedBgpNeighbor,
  ParsedOspfConfig,
  ParsedStaticRoute,
} from '../types';
import { cloneSourceFiles, selectEntrypoint } from './common';

interface NeighborBuilder {
  address: string;
  remoteAs?: number;
  localAs?: number;
  description?: string;
  families: Set<IpFamily>;
  deactivated: Set<IpFamily>;
  importPolicy?: string;
  exportPolicy?: string;
  multihop?: number;
  routeServerClient?: boolean;
}

interface BgpBuilder {
  config: ParsedBgpConfig;
  neighbors: Map<string, NeighborBuilder>;
  currentFamily: IpFamily;
}

function parseAsn(value: string | undefined): number | undefined {
  if (!value) return undefined;
  if (/^\d+\.\d+$/.test(value)) {
    const [highText, lowText] = value.split('.');
    const high = Number(highText);
    const low = Number(lowText);
    if (high >= 0 && high <= 65_535 && low >= 0 && low <= 65_535) return high * 65_536 + low;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 4_294_967_295 ? parsed : undefined;
}

function stripInlineComment(line: string): string {
  const hash = line.indexOf('#');
  return (hash >= 0 ? line.slice(0, hash) : line).trim();
}

function routeFromTokens(tokens: string[], family: IpFamily): ParsedStaticRoute | undefined {
  const prefix = tokens[2];
  if (!prefix || !tryParsePrefix(prefix) || tryParsePrefix(prefix)?.family !== family) return undefined;
  const target = tokens[3];
  const lowerTarget = target?.toLowerCase();
  const disposition =
    lowerTarget === 'null0' || lowerTarget === 'blackhole'
      ? 'blackhole'
      : lowerTarget === 'reject'
        ? 'unreachable'
        : 'forward';
  const nextHop = target && tryParseIp(target) ? target : undefined;
  const interfaceName = target && !nextHop && disposition === 'forward' ? target : undefined;
  const distance = tokens.slice(4).map(Number).find((value) => Number.isInteger(value));
  return {
    prefix: normalizePrefix(prefix),
    nextHop,
    interfaceName,
    disposition,
    metric: distance,
  };
}

function ensureNeighbor(builder: BgpBuilder, address: string): NeighborBuilder {
  let neighbor = builder.neighbors.get(address);
  if (!neighbor) {
    neighbor = {
      address,
      families: new Set<IpFamily>(),
      deactivated: new Set<IpFamily>(),
    };
    builder.neighbors.set(address, neighbor);
  }
  return neighbor;
}

export function parseFrrConfig(node: LabNode): ParsedApplianceConfig {
  const diagnostics: ConfigDiagnostic[] = [];
  const result: ParsedApplianceConfig = {
    daemon: 'frr',
    interfaces: [],
    staticRoutes: [],
    bgp: [],
    ospf: [],
    diagnostics,
    sourceFiles: cloneSourceFiles(node.files),
  };
  const entrypoint = selectEntrypoint(node, ['/etc/frr/frr.conf', '/etc/frr.conf']);
  if (!entrypoint) {
    diagnostics.push({
      severity: 'error',
      code: 'frr.config-missing',
      message: 'No FRR configuration file was supplied.',
    });
    return result;
  }

  const prefixLists = new Map<string, string[]>();
  const routeMapPrefixLists = new Map<string, string[]>();
  const neighborPolicies = new Map<string, { in?: string; out?: string }>();
  const bgpBuilders: BgpBuilder[] = [];
  const ospfBuilders: ParsedOspfConfig[] = [];
  let currentSection: 'global' | 'interface' | 'bgp' | 'ospf' = 'global';
  let currentInterface: { name: string; addresses: string[] } | undefined;
  let currentBgp: BgpBuilder | undefined;
  let currentOspf: ParsedOspfConfig | undefined;
  let currentRouteMap: { name: string; permit: boolean } | undefined;

  const lines = entrypoint.content.split(/\r?\n/);
  lines.forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const line = stripInlineComment(rawLine);
    if (line === '' || line === '!') return;
    const tokens = line.split(/\s+/);
    const lower = tokens.map((token) => token.toLowerCase());

    if (lower[0] === 'interface' && tokens[1]) {
      currentSection = 'interface';
      currentBgp = undefined;
      currentOspf = undefined;
      currentRouteMap = undefined;
      currentInterface = { name: tokens[1], addresses: [] };
      result.interfaces.push(currentInterface);
      return;
    }
    if (lower[0] === 'router' && lower[1] === 'bgp') {
      const localAs = parseAsn(tokens[2]) ?? node.asn;
      if (!localAs) {
        diagnostics.push({
          severity: 'error',
          code: 'frr.bgp-asn',
          file: entrypoint.path,
          line: lineNumber,
          message: 'router bgp requires a valid ASN.',
        });
        return;
      }
      currentSection = 'bgp';
      currentInterface = undefined;
      currentOspf = undefined;
      currentRouteMap = undefined;
      currentBgp = {
        config: {
          instanceName: `bgp-${localAs}`,
          localAs,
          routerId: node.routerId,
          networks: [],
          neighbors: [],
        },
        neighbors: new Map(),
        currentFamily: 'ipv4',
      };
      bgpBuilders.push(currentBgp);
      return;
    }
    if (lower[0] === 'router' && (lower[1] === 'ospf' || lower[1] === 'ospf6')) {
      const family: IpFamily = lower[1] === 'ospf6' ? 'ipv6' : 'ipv4';
      currentSection = 'ospf';
      currentInterface = undefined;
      currentBgp = undefined;
      currentRouteMap = undefined;
      currentOspf = {
        instanceName: lower[1] ?? 'ospf',
        family,
        areas: [],
        redistribute: [],
      };
      ospfBuilders.push(currentOspf);
      return;
    }
    if (lower[0] === 'route-map' && tokens[1]) {
      currentSection = 'global';
      currentBgp = undefined;
      currentOspf = undefined;
      currentInterface = undefined;
      currentRouteMap = { name: tokens[1], permit: lower[2] !== 'deny' };
      if (!routeMapPrefixLists.has(tokens[1])) routeMapPrefixLists.set(tokens[1], []);
      return;
    }
    if (lower[0] === 'exit') {
      currentSection = 'global';
      currentBgp = undefined;
      currentOspf = undefined;
      currentInterface = undefined;
      currentRouteMap = undefined;
      return;
    }

    if ((lower[0] === 'ip' || lower[0] === 'ipv6') && lower[1] === 'prefix-list') {
      const name = tokens[2];
      const actionIndex = lower.findIndex((token) => token === 'permit' || token === 'deny');
      const prefix = tokens[actionIndex + 1];
      if (name && lower[actionIndex] === 'permit' && prefix && tryParsePrefix(prefix)) {
        const prefixes = prefixLists.get(name) ?? [];
        prefixes.push(normalizePrefix(prefix));
        prefixLists.set(name, prefixes);
      }
      return;
    }
    if (lower[0] === 'match' && lower[1] === 'ip' && lower[2] === 'address' && lower[3] === 'prefix-list' && currentRouteMap?.permit) {
      const target = routeMapPrefixLists.get(currentRouteMap.name) ?? [];
      for (const name of tokens.slice(4)) target.push(name);
      routeMapPrefixLists.set(currentRouteMap.name, target);
      return;
    }

    if (lower[0] === 'ip' && lower[1] === 'route') {
      const route = routeFromTokens(tokens, 'ipv4');
      if (route) result.staticRoutes.push(route);
      else {
        diagnostics.push({
          severity: 'warning',
          code: 'frr.static-route',
          file: entrypoint.path,
          line: lineNumber,
          message: `Could not interpret static route: ${line}`,
        });
      }
      return;
    }
    if (lower[0] === 'ipv6' && lower[1] === 'route') {
      const route = routeFromTokens(tokens, 'ipv6');
      if (route) result.staticRoutes.push(route);
      else {
        diagnostics.push({
          severity: 'warning',
          code: 'frr.static-route',
          file: entrypoint.path,
          line: lineNumber,
          message: `Could not interpret static route: ${line}`,
        });
      }
      return;
    }

    if (currentSection === 'interface' && currentInterface) {
      if ((lower[0] === 'ip' || lower[0] === 'ipv6') && lower[1] === 'address' && tokens[2]) {
        if (tryParsePrefix(tokens[2])) currentInterface.addresses.push(tokens[2]);
        else {
          diagnostics.push({
            severity: 'error',
            code: 'frr.interface-address',
            file: entrypoint.path,
            line: lineNumber,
            message: `Invalid interface address: ${tokens[2]}.`,
          });
        }
      }
      if (lower[0] === 'ip' && lower[1] === 'ospf' && lower[2] === 'area' && tokens[3]) {
        let ospf = ospfBuilders.find((candidate) => candidate.family === 'ipv4');
        if (!ospf) {
          ospf = { instanceName: 'ospf', family: 'ipv4', areas: [], redistribute: [] };
          ospfBuilders.push(ospf);
        }
        let area = ospf.areas.find((candidate) => candidate.area === tokens[3]);
        if (!area) {
          area = { area: tokens[3], networks: [], interfacePatterns: [] };
          ospf.areas.push(area);
        }
        area.interfacePatterns.push(currentInterface.name);
      }
      if (lower[0] === 'ipv6' && lower[1] === 'ospf6' && lower[2] === 'area' && tokens[3]) {
        let ospf = ospfBuilders.find((candidate) => candidate.family === 'ipv6');
        if (!ospf) {
          ospf = { instanceName: 'ospf6', family: 'ipv6', areas: [], redistribute: [] };
          ospfBuilders.push(ospf);
        }
        let area = ospf.areas.find((candidate) => candidate.area === tokens[3]);
        if (!area) {
          area = { area: tokens[3], networks: [], interfacePatterns: [] };
          ospf.areas.push(area);
        }
        area.interfacePatterns.push(currentInterface.name);
      }
      return;
    }

    if (currentSection === 'bgp' && currentBgp) {
      if (lower[0] === 'bgp' && lower[1] === 'router-id' && tokens[2] && tryParseIp(tokens[2])?.family === 'ipv4') {
        currentBgp.config.routerId = tokens[2];
        result.routerId = tokens[2];
        return;
      }
      if (lower[0] === 'address-family') {
        currentBgp.currentFamily = lower[1] === 'ipv6' ? 'ipv6' : 'ipv4';
        return;
      }
      if (lower[0] === 'exit-address-family') {
        currentBgp.currentFamily = 'ipv4';
        return;
      }
      if (lower[0] === 'network' && tokens[1] && tryParsePrefix(tokens[1])) {
        currentBgp.config.networks.push(normalizePrefix(tokens[1]));
        return;
      }
      if (lower[0] === 'neighbor' && tokens[1]) {
        const address = tokens[1];
        if (!tryParseIp(address)) return;
        const neighbor = ensureNeighbor(currentBgp, address);
        const command = lower[2];
        if (command === 'remote-as') neighbor.remoteAs = parseAsn(tokens[3]);
        if (command === 'local-as') neighbor.localAs = parseAsn(tokens[3]);
        if (command === 'description') neighbor.description = tokens.slice(3).join(' ');
        if (command === 'activate') neighbor.families.add(currentBgp.currentFamily);
        if (command === 'route-server-client') neighbor.routeServerClient = true;
        if (command === 'ebgp-multihop') neighbor.multihop = Number(tokens[3] ?? 255);
        if ((command === 'prefix-list' || command === 'route-map') && tokens[3] && lower[4]) {
          const policies = neighborPolicies.get(address) ?? {};
          if (lower[4] === 'in') policies.in = `${command}:${tokens[3]}`;
          if (lower[4] === 'out') policies.out = `${command}:${tokens[3]}`;
          neighborPolicies.set(address, policies);
        }
        return;
      }
      if (lower[0] === 'no' && lower[1] === 'neighbor' && tokens[2] && lower[3] === 'activate') {
        ensureNeighbor(currentBgp, tokens[2]).deactivated.add(currentBgp.currentFamily);
        return;
      }
      return;
    }

    if (currentSection === 'ospf' && currentOspf) {
      if (lower[0] === 'network' && tokens[1] && lower[2] === 'area' && tokens[3] && tryParsePrefix(tokens[1])) {
        let area = currentOspf.areas.find((candidate) => candidate.area === tokens[3]);
        if (!area) {
          area = { area: tokens[3], networks: [], interfacePatterns: [] };
          currentOspf.areas.push(area);
        }
        area.networks.push(normalizePrefix(tokens[1]));
      }
      if (lower[0] === 'redistribute' && ['connected', 'static', 'bgp'].includes(lower[1] ?? '')) {
        currentOspf.redistribute.push(lower[1] as 'connected' | 'static' | 'bgp');
      }
    }
  });

  const resolvePolicy = (reference: string | undefined): string[] | undefined => {
    if (!reference) return undefined;
    const [kind, name] = reference.split(':');
    if (!name) return [];
    if (kind === 'prefix-list') return prefixLists.get(name) ?? [];
    const lists = routeMapPrefixLists.get(name) ?? [];
    return lists.flatMap((list) => prefixLists.get(list) ?? []);
  };

  for (const builder of bgpBuilders) {
    for (const neighbor of builder.neighbors.values()) {
      if (!neighbor.remoteAs) {
        diagnostics.push({
          severity: 'error',
          code: 'frr.neighbor-remote-as',
          file: entrypoint.path,
          message: `Neighbor ${neighbor.address} does not have a numeric remote-as.`,
        });
        continue;
      }
      const defaultFamily: IpFamily = tryParseIp(neighbor.address)?.family ?? 'ipv4';
      if (neighbor.families.size === 0) neighbor.families.add(defaultFamily);
      for (const family of neighbor.deactivated) neighbor.families.delete(family);
      const policies = neighborPolicies.get(neighbor.address);
      const importPrefixes = resolvePolicy(policies?.in);
      const exportPrefixes = resolvePolicy(policies?.out);
      const parsed: ParsedBgpNeighbor = {
        address: neighbor.address,
        remoteAs: neighbor.remoteAs,
        localAs: neighbor.localAs ?? builder.config.localAs,
        description: neighbor.description,
        addressFamilies: [...neighbor.families],
        importPolicy: policies?.in ? 'configured' : 'all',
        exportPolicy: policies?.out ? 'configured' : 'all',
        importPrefixes,
        exportPrefixes,
        multihop: neighbor.multihop,
        routeServerClient: neighbor.routeServerClient,
      };
      builder.config.neighbors.push(parsed);
    }
    result.bgp.push(builder.config);
  }

  for (const ospf of ospfBuilders) {
    if (ospf.areas.length === 0) ospf.areas.push({ area: '0', networks: [], interfacePatterns: ['*'] });
    ospf.redistribute = [...new Set(ospf.redistribute)];
    result.ospf.push(ospf);
  }
  return result;
}
