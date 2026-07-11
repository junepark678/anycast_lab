import { addressInPrefix, normalizePrefix, parseIp, prefixLength, prefixesOverlap } from './ip';
import type { IpFamily, Route, RoutePolicyMode } from './types';

export const ADMINISTRATIVE_DISTANCE = {
  connected: 0,
  static: 1,
  ebgp: 20,
  ospf: 110,
  ibgp: 200,
  client: 1,
} as const;

function originRank(origin: NonNullable<Route['bgp']>['origin']): number {
  return origin === 'igp' ? 0 : origin === 'egp' ? 1 : 2;
}

/** Negative means `first` is preferred. */
export function compareRoutePreference(first: Route, second: Route): number {
  if (first.administrativeDistance !== second.administrativeDistance) {
    return first.administrativeDistance - second.administrativeDistance;
  }
  if (first.bgp && second.bgp) {
    if (first.bgp.localPreference !== second.bgp.localPreference) {
      return second.bgp.localPreference - first.bgp.localPreference;
    }
    if (first.bgp.asPath.length !== second.bgp.asPath.length) {
      return first.bgp.asPath.length - second.bgp.asPath.length;
    }
    const origin = originRank(first.bgp.origin) - originRank(second.bgp.origin);
    if (origin !== 0) return origin;
    if (first.bgp.med !== second.bgp.med) return first.bgp.med - second.bgp.med;
  }
  if (first.metric !== second.metric) return first.metric - second.metric;
  return first.id.localeCompare(second.id);
}

export function installBestRoutes(routes: Route[]): Route[] {
  const groups = new Map<string, Route[]>();
  for (const route of routes) {
    const key = `${route.family}:${normalizePrefix(route.prefix)}`;
    const candidates = groups.get(key) ?? [];
    candidates.push({ ...route, prefix: normalizePrefix(route.prefix), selected: false, installed: false });
    groups.set(key, candidates);
  }
  const output: Route[] = [];
  for (const candidates of groups.values()) {
    candidates.sort(compareRoutePreference);
    const winner = candidates[0];
    if (winner) {
      winner.selected = true;
      winner.installed = true;
    }
    output.push(...candidates);
  }
  return output.sort(
    (a, b) =>
      a.family.localeCompare(b.family) ||
      normalizePrefix(a.prefix).localeCompare(normalizePrefix(b.prefix)) ||
      compareRoutePreference(a, b),
  );
}

export function lookupRoute(routes: Route[], destination: string): Route | undefined {
  const address = parseIp(destination);
  return routes
    .filter(
      (route) =>
        route.installed && route.family === address.family && addressInPrefix(address.canonical, route.prefix),
    )
    .sort((a, b) => prefixLength(b.prefix) - prefixLength(a.prefix) || compareRoutePreference(a, b))[0];
}

export function policyAllows(
  prefix: string,
  mode: RoutePolicyMode,
  configuredPrefixes: string[] | undefined,
): boolean {
  if (mode === 'all') return true;
  if (mode === 'none') return false;
  return (configuredPrefixes ?? []).some((configured) => prefixesOverlap(prefix, configured));
}

export function routeFamily(prefix: string): IpFamily {
  return parseIp(prefix.split('/')[0] ?? prefix).family;
}

export function equivalentRoute(first: Route, second: Route): boolean {
  return (
    first.nodeId === second.nodeId &&
    normalizePrefix(first.prefix) === normalizePrefix(second.prefix) &&
    first.source === second.source &&
    first.nextHop === second.nextHop &&
    first.learnedFromNodeId === second.learnedFromNodeId &&
    JSON.stringify(first.bgp?.asPath ?? []) === JSON.stringify(second.bgp?.asPath ?? [])
  );
}
