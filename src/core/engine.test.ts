import { describe, expect, it } from 'vitest';
import { createExampleProject } from '../app/example-project';
import { LabEngine } from './engine';
import { createEmptyProject, type LabNode } from './types';

function ospfProject() {
  const project = createEmptyProject({ id: 'ospf-lab', name: 'OSPF lab', seed: 9 });
  const routers: LabNode[] = [
    {
      id: 'r1', name: 'Router one', kind: 'router', state: 'up', routerId: '192.0.2.1',
      appliance: { kind: 'bird', runtime: 'compatibility', entrypoint: '/etc/bird/bird.conf' },
      interfaces: [{ id: 'r1-eth0', name: 'eth0', addresses: ['10.0.0.0/31'], state: 'up' }],
      files: [{ path: '/etc/bird/bird.conf', entrypoint: true, content: 'router id 192.0.2.1; protocol ospf v2 core { ipv4 { import all; export all; }; area 0 { interface "*"; }; }' }],
    },
    {
      id: 'r2', name: 'Router two', kind: 'router', state: 'up', routerId: '192.0.2.2',
      appliance: { kind: 'bird', runtime: 'compatibility', entrypoint: '/etc/bird/bird.conf' },
      interfaces: [
        { id: 'r2-eth0', name: 'eth0', addresses: ['10.0.0.1/31'], state: 'up' },
        { id: 'r2-lo', name: 'lo', addresses: ['203.0.113.1/32'], state: 'up' },
      ],
      files: [{ path: '/etc/bird/bird.conf', entrypoint: true, content: 'router id 192.0.2.2; protocol ospf v2 core { ipv4 { import all; export all; }; area 0 { interface "*"; }; }' }],
    },
  ];
  project.nodes = routers;
  project.links = [{ id: 'r1-r2', state: 'up', latencyMs: 3, endpoints: [{ nodeId: 'r1', interfaceId: 'r1-eth0' }, { nodeId: 'r2', interfaceId: 'r2-eth0' }] }];
  return project;
}

function routeServerProject() {
  const project = createEmptyProject({ id: 'rs-lab', name: 'Route server lab', seed: 12 });
  const router = (id: string, name: string, asn: number, routerId: string, interfaces: LabNode['interfaces'], config: string, kind: LabNode['kind'] = 'router'): LabNode => ({
    id, name, kind, asn, routerId, state: 'up', interfaces,
    appliance: { kind: 'bird', runtime: 'compatibility', entrypoint: '/etc/bird/bird.conf' },
    files: [{ path: '/etc/bird/bird.conf', content: config, entrypoint: true }],
  });
  project.nodes = [
    router('peer-a', 'Peer A', 65001, '192.0.2.1', [{ id: 'a-eth0', name: 'eth0', addresses: ['10.0.0.0/31'], state: 'up' }], `router id 192.0.2.1; protocol static origin { ipv4; route 203.0.113.0/24 blackhole; } protocol bgp rs { local 10.0.0.0 as 65001; neighbor 10.0.0.1 as 65534; ipv4 { import all; export all; }; }`),
    router('rs', 'IX route server', 65534, '192.0.2.254', [
      { id: 'rs-a', name: 'eth0', addresses: ['10.0.0.1/31'], state: 'up' },
      { id: 'rs-b', name: 'eth1', addresses: ['10.0.0.2/31'], state: 'up' },
    ], `router id 192.0.2.254; protocol bgp peer_a { local 10.0.0.1 as 65534; neighbor 10.0.0.0 as 65001; rs client; ipv4 { import all; export all; }; } protocol bgp peer_b { local 10.0.0.2 as 65534; neighbor 10.0.0.3 as 65002; rs client; ipv4 { import all; export all; }; }`, 'route-server'),
    router('peer-b', 'Peer B', 65002, '192.0.2.2', [{ id: 'b-eth0', name: 'eth0', addresses: ['10.0.0.3/31'], state: 'up' }], `router id 192.0.2.2; protocol bgp rs { local 10.0.0.3 as 65002; neighbor 10.0.0.2 as 65534; ipv4 { import all; export all; }; }`),
  ];
  project.links = [
    { id: 'a-rs', state: 'up', latencyMs: 1, endpoints: [{ nodeId: 'peer-a', interfaceId: 'a-eth0' }, { nodeId: 'rs', interfaceId: 'rs-a' }] },
    { id: 'b-rs', state: 'up', latencyMs: 1, endpoints: [{ nodeId: 'peer-b', interfaceId: 'b-eth0' }, { nodeId: 'rs', interfaceId: 'rs-b' }] },
  ];
  return project;
}

function ipv6BgpProject() {
  const project = createEmptyProject({ id: 'ipv6-lab', name: 'IPv6 BGP lab', seed: 6 });
  project.nodes = [
    {
      id: 'origin', name: 'IPv6 origin', kind: 'router', state: 'up', asn: 65010, routerId: '192.0.2.10',
      appliance: { kind: 'bird', runtime: 'compatibility', entrypoint: '/etc/bird/bird.conf' },
      interfaces: [{ id: 'origin-eth0', name: 'eth0', addresses: ['2001:db8:0::/127'], state: 'up' }],
      service: { addresses: ['2001:db8:100::/48'], protocols: ['icmp'] },
      files: [{ path: '/etc/bird/bird.conf', entrypoint: true, content: 'router id 192.0.2.10; protocol bgp peer { local 2001:db8:0:: as 65010; neighbor 2001:db8:0::1 as 65020; ipv6 { import all; export all; }; }' }],
    },
    {
      id: 'peer', name: 'IPv6 peer', kind: 'router', state: 'up', asn: 65020, routerId: '192.0.2.20',
      appliance: { kind: 'bird', runtime: 'compatibility', entrypoint: '/etc/bird/bird.conf' },
      interfaces: [{ id: 'peer-eth0', name: 'eth0', addresses: ['2001:db8:0::1/127'], state: 'up' }],
      files: [{ path: '/etc/bird/bird.conf', entrypoint: true, content: 'router id 192.0.2.20; protocol bgp origin { local 2001:db8:0::1 as 65020; neighbor 2001:db8:0:: as 65010; ipv6 { import all; export all; }; }' }],
    },
  ];
  project.links = [{ id: 'v6-link', state: 'up', latencyMs: 8, endpoints: [{ nodeId: 'origin', interfaceId: 'origin-eth0' }, { nodeId: 'peer', interfaceId: 'peer-eth0' }] }];
  return project;
}

describe('lab engine integration', () => {
  it('converges real-syntax BIRD and FRR configs and installs the nearest anycast path', async () => {
    const engine = await LabEngine.create(createExampleProject());
    const snapshot = await engine.converge();
    expect(snapshot.converged).toBe(true);
    expect(snapshot.sessions.filter((session) => session.protocol === 'bgp' && session.state === 'established')).toHaveLength(4);
    const transit = snapshot.nodes.find((node) => node.nodeId === 'transit')!;
    const selected = transit.routes.find((route) => route.prefix === '203.0.113.53/32' && route.installed);
    expect(selected).toMatchObject({ source: 'bgp', learnedFromNodeId: 'pop-seoul', bgp: { asPath: [65001] } });
    await engine.dispose();
  });

  it('traces a client packet through the selected PoP', async () => {
    const engine = await LabEngine.create(createExampleProject());
    await engine.converge();
    const trace = engine.trace({ sourceNodeId: 'client-seoul', destination: '203.0.113.53' });
    expect(trace.outcome).toBe('delivered');
    expect(trace.hops.map((hop) => hop.nodeId)).toEqual(['client-seoul', 'transit', 'pop-seoul', 'service-seoul']);
    expect(trace.totalLatencyMs).toBeGreaterThan(6);
    expect(trace.totalLatencyMs).toBeLessThan(9);
    expect(trace.hops[1]?.matchedRoute?.source).toBe('bgp');
    await engine.dispose();
  });

  it('withdraws the failed PoP path and reconverges through Frankfurt', async () => {
    const engine = await LabEngine.create(createExampleProject());
    await engine.converge();
    expect(engine.setLinkState('link-transit-seoul', 'down')).toBe(true);
    const snapshot = await engine.converge();
    const selected = snapshot.nodes.find((node) => node.nodeId === 'transit')?.routes.find((route) => route.prefix === '203.0.113.53/32' && route.installed);
    expect(selected?.learnedFromNodeId).toBe('pop-frankfurt');
    const trace = engine.trace({ sourceNodeId: 'client-seoul', destination: '203.0.113.53' });
    expect(trace.outcome).toBe('delivered');
    expect(trace.hops.map((hop) => hop.nodeId)).toContain('pop-frankfurt');
    expect(snapshot.events.some((event) => event.type === 'link.state')).toBe(true);
    await engine.dispose();
  });

  it('provides familiar BIRD, FRR, and client terminal commands', async () => {
    const engine = await LabEngine.create(createExampleProject());
    await engine.converge();
    const bird = await engine.terminal('pop-seoul', 'show protocols');
    expect(bird.exitCode).toBe(0);
    expect(bird.output).toContain('transit');
    const frr = await engine.terminal('pop-frankfurt', 'show bgp summary');
    expect(frr.output).toContain('local AS number 65001');
    const ping = await engine.terminal('client-seoul', 'ping 203.0.113.53');
    expect(ping.exitCode).toBe(0);
    expect(ping.output).toContain('1 received');
    const bad = await engine.terminal('pop-seoul', 'definitely-not-a-command');
    expect(bad.exitCode).not.toBe(0);
    await engine.dispose();
  });

  it('reloads exact config files and exposes diagnostics', async () => {
    const project = createExampleProject();
    const engine = await LabEngine.create(project);
    const file = structuredClone(project.nodes.find((node) => node.id === 'pop-seoul')!.files[0]!);
    file.content = 'protocol bgp broken {';
    const snapshot = await engine.updateNodeFiles('pop-seoul', [file]);
    expect(snapshot.nodes.find((node) => node.nodeId === 'pop-seoul')?.diagnostics.some((item) => item.severity === 'error')).toBe(true);
    expect(snapshot.events.at(-1)?.type).toBe('config.error');
    await engine.dispose();
  });

  it('rejects a falsely labeled native VM appliance when no native runtime exists', async () => {
    const project = createExampleProject();
    project.nodes.find((node) => node.id === 'pop-seoul')!.appliance.runtime = 'wasm';
    await expect(LabEngine.create(project)).rejects.toThrow(/no native runtime factory/i);
  });

  it('forms OSPF adjacency, floods connected routes, and withdraws on failure', async () => {
    const engine = await LabEngine.create(ospfProject());
    let snapshot = await engine.converge();
    expect(snapshot.sessions.filter((session) => session.protocol === 'ospf' && session.state === 'established')).toHaveLength(2);
    expect(snapshot.nodes.find((node) => node.nodeId === 'r1')?.routes.find((route) => route.prefix === '203.0.113.1/32' && route.installed)).toMatchObject({ source: 'ospf', learnedFromNodeId: 'r2' });
    expect(engine.trace({ sourceNodeId: 'r1', destination: '203.0.113.1' }).outcome).toBe('delivered');
    engine.setLinkState('r1-r2', 'down');
    snapshot = await engine.converge();
    expect(snapshot.nodes.find((node) => node.nodeId === 'r1')?.routes.some((route) => route.prefix === '203.0.113.1/32')).toBe(false);
    await engine.dispose();
  });

  it('models route-server clients without inserting the route-server ASN', async () => {
    const engine = await LabEngine.create(routeServerProject());
    const snapshot = await engine.converge();
    expect(snapshot.sessions.map((session) => [session.localNodeId, session.remoteNodeId, session.state])).toEqual([
      ['peer-a', 'rs', 'established'],
      ['rs', 'peer-a', 'established'],
      ['rs', 'peer-b', 'established'],
      ['peer-b', 'rs', 'established'],
    ]);
    const learned = snapshot.nodes.find((node) => node.nodeId === 'peer-b')?.routes.find((route) => route.prefix === '203.0.113.0/24' && route.installed);
    expect(learned).toMatchObject({ source: 'bgp', bgp: { asPath: [65001] } });
    expect(learned?.bgp?.asPath).not.toContain(65534);
    await engine.dispose();
  });

  it('converges IPv6 BGP and traces an IPv6 anycast destination', async () => {
    const engine = await LabEngine.create(ipv6BgpProject());
    const snapshot = await engine.converge();
    expect(snapshot.nodes.find((node) => node.nodeId === 'peer')?.routes.find((route) => route.prefix === '2001:db8:100::/48' && route.installed)).toMatchObject({ family: 'ipv6', source: 'bgp' });
    const trace = engine.trace({ sourceNodeId: 'peer', destination: '2001:db8:100::53' });
    expect(trace.outcome).toBe('delivered');
    expect(trace.hops.map((hop) => hop.nodeId)).toEqual(['peer', 'origin']);
    await engine.dispose();
  });
});
