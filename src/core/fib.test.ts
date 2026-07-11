import { describe, expect, it } from 'vitest';
import { installBestRoutes, lookupRoute, policyAllows } from './fib';
import type { Route } from './types';

function route(patch: Partial<Route> & Pick<Route, 'id' | 'prefix'>): Route {
  return {
    nodeId: 'r1', family: patch.prefix.includes(':') ? 'ipv6' : 'ipv4', source: 'bgp',
    metric: 0, administrativeDistance: 20, disposition: 'forward', selected: false, installed: false,
    bgp: { asPath: [64500], localPreference: 100, med: 0, origin: 'igp', communities: [] },
    ...patch,
  };
}

describe('forwarding information base', () => {
  it('selects local preference, AS path, MED, and metric in order', () => {
    const routes = installBestRoutes([
      route({ id: 'long', prefix: '203.0.113.0/24', bgp: { asPath: [64500, 64496], localPreference: 100, med: 0, origin: 'igp', communities: [] } }),
      route({ id: 'preferred', prefix: '203.0.113.0/24', metric: 50, bgp: { asPath: [64501], localPreference: 200, med: 100, origin: 'incomplete', communities: [] } }),
      route({ id: 'low-metric', prefix: '203.0.113.0/24', metric: 1, bgp: { asPath: [64502], localPreference: 100, med: 0, origin: 'igp', communities: [] } }),
    ]);
    expect(routes.find((candidate) => candidate.installed)?.id).toBe('preferred');
  });

  it('uses longest-prefix match after route installation', () => {
    const routes = installBestRoutes([
      route({ id: 'default', prefix: '0.0.0.0/0' }),
      route({ id: 'specific', prefix: '203.0.113.0/24' }),
      route({ id: 'host', prefix: '203.0.113.53/32' }),
    ]);
    expect(lookupRoute(routes, '203.0.113.53')?.id).toBe('host');
    expect(lookupRoute(routes, '203.0.113.54')?.id).toBe('specific');
    expect(lookupRoute(routes, '192.0.2.1')?.id).toBe('default');
  });

  it('applies all, none and configured prefix policies', () => {
    expect(policyAllows('203.0.113.0/24', 'all', undefined)).toBe(true);
    expect(policyAllows('203.0.113.0/24', 'none', undefined)).toBe(false);
    expect(policyAllows('203.0.113.0/24', 'configured', ['203.0.113.0/24'])).toBe(true);
    expect(policyAllows('198.51.100.0/24', 'configured', ['203.0.113.0/24'])).toBe(false);
  });
});
