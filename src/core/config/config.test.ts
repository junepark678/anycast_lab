import { describe, expect, it } from 'vitest';
import { createExampleProject } from '../../app/example-project';
import { parseBirdConfig } from './bird';
import { parseFrrConfig } from './frr';

describe('native daemon configuration adapters', () => {
  it('parses BIRD includes, defines, BGP policies and static routes without changing source', () => {
    const node = structuredClone(createExampleProject().nodes.find((candidate) => candidate.id === 'pop-seoul')!);
    const original = node.files[0]!.content;
    node.files.push({ path: '/etc/bird/extra.conf', content: 'protocol static extra { ipv4; route 198.51.100.0/24 blackhole; }\n' });
    node.files[0]!.content += '\ninclude "/etc/bird/extra.conf";\n';
    const parsed = parseBirdConfig(node);
    expect(parsed.diagnostics.filter((item) => item.severity === 'error')).toEqual([]);
    expect(parsed.routerId).toBe('192.0.2.20');
    expect(parsed.staticRoutes.map((route) => route.prefix)).toEqual(expect.arrayContaining(['203.0.113.53/32', '198.51.100.0/24']));
    expect(parsed.bgp[0]?.localAs).toBe(65001);
    expect(parsed.bgp[0]?.neighbors[0]).toMatchObject({ address: '192.0.2.0', remoteAs: 64500, exportPolicy: 'configured', exportPrefixes: ['203.0.113.53/32'] });
    expect(node.files[0]!.content.startsWith(original)).toBe(true);
  });

  it('reports malformed BIRD blocks with source locations', () => {
    const node = structuredClone(createExampleProject().nodes.find((candidate) => candidate.id === 'pop-seoul')!);
    node.files[0]!.content = 'router id 192.0.2.1;\nprotocol bgp broken { neighbor 192.0.2.2 as 64500;';
    const parsed = parseBirdConfig(node);
    expect(parsed.diagnostics.some((item) => item.severity === 'error' && item.code?.includes('unclosed'))).toBe(true);
  });

  it('parses integrated FRR BGP, networks and static routes', () => {
    const node = createExampleProject().nodes.find((candidate) => candidate.id === 'pop-frankfurt')!;
    const parsed = parseFrrConfig(node);
    expect(parsed.diagnostics.filter((item) => item.severity === 'error')).toEqual([]);
    expect(parsed.routerId).toBe('198.51.100.20');
    expect(parsed.staticRoutes[0]).toMatchObject({ prefix: '203.0.113.53/32', nextHop: '172.16.2.2' });
    expect(parsed.bgp[0]).toMatchObject({ localAs: 65001, networks: ['203.0.113.53/32'] });
    expect(parsed.bgp[0]?.neighbors[0]).toMatchObject({ address: '198.51.100.0', remoteAs: 64500, addressFamilies: ['ipv4'] });
  });

  it('parses FRR prefix-list/route-map policy references', () => {
    const node = structuredClone(createExampleProject().nodes.find((candidate) => candidate.id === 'pop-frankfurt')!);
    node.files[0]!.content += `
ip prefix-list OURS permit 203.0.113.0/24
route-map EXPORT permit 10
 match ip address prefix-list OURS
router bgp 65001
 neighbor 198.51.100.0 remote-as 64500
 address-family ipv4 unicast
  neighbor 198.51.100.0 route-map EXPORT out
 exit-address-family
`;
    const parsed = parseFrrConfig(node);
    expect(parsed.bgp.at(-1)?.neighbors[0]?.exportPrefixes).toEqual(['203.0.113.0/24']);
  });
});
