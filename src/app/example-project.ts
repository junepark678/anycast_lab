import { CURRENT_SCHEMA_VERSION, type LabFile, type LabNode, type LabProject } from '../core/types';

const now = new Date().toISOString();

function iface(id: string, name: string, addresses: string[], gateway?: string) {
  return { id, name, addresses, gateway, state: 'up' as const, mtu: 1500 };
}

function file(path: string, content: string, entrypoint = false): LabFile {
  return { path, content: content.trimStart(), encoding: 'utf-8', entrypoint };
}

const transitConfig = `
router id 192.0.2.10;
define TRANSIT_AS = 64500;

protocol device {}
protocol direct { ipv4; }

protocol bgp pop_seoul {
  local 192.0.2.0 as TRANSIT_AS;
  neighbor 192.0.2.1 as 65001;
  ipv4 { import all; export all; };
}

protocol bgp pop_frankfurt {
  local 198.51.100.0 as TRANSIT_AS;
  neighbor 198.51.100.1 as 65001;
  ipv4 { import all; export all; };
}
`;

const seoulConfig = `
router id 192.0.2.20;
define MY_AS = 65001;
define ANYCAST_PREFIX = 203.0.113.53/32;

protocol device {}
protocol direct { ipv4; }
protocol static anycast_service {
  ipv4;
  route ANYCAST_PREFIX via 172.16.1.2;
}

protocol bgp transit {
  local 192.0.2.1 as MY_AS;
  neighbor 192.0.2.0 as 64500;
  ipv4 {
    import all;
    export where net = ANYCAST_PREFIX;
  };
}
`;

const frankfurtConfig = `
frr version 10.4
frr defaults traditional
hostname pop-frankfurt
service integrated-vtysh-config
!
ip route 203.0.113.53/32 172.16.2.2
!
router bgp 65001
 bgp router-id 198.51.100.20
 neighbor 198.51.100.0 remote-as 64500
 !
 address-family ipv4 unicast
  network 203.0.113.53/32
  neighbor 198.51.100.0 activate
 exit-address-family
!
line vty
`;

const nodes: LabNode[] = [
  {
    id: 'client-seoul', name: 'Client · Seoul', kind: 'client',
    appliance: { kind: 'client', runtime: 'compatibility', version: '1' },
    interfaces: [iface('client-seoul-eth0', 'eth0', ['10.10.0.2/24'], '10.10.0.1')],
    files: [], state: 'up', position: { x: 40, y: 215 },
    client: { defaultGateway: '10.10.0.1', dnsServers: ['203.0.113.53'] }, tags: ['Seoul'],
  },
  {
    id: 'transit', name: 'Example Transit', kind: 'router', asn: 64500, routerId: '192.0.2.10',
    appliance: { kind: 'bird', runtime: 'compatibility', version: '2.17.1', entrypoint: '/etc/bird/bird.conf' },
    interfaces: [
      iface('transit-client', 'eth0', ['10.10.0.1/24']),
      iface('transit-seoul', 'eth1', ['192.0.2.0/31']),
      iface('transit-frankfurt', 'eth2', ['198.51.100.0/31']),
    ],
    files: [file('/etc/bird/bird.conf', transitConfig, true)], state: 'up', position: { x: 300, y: 215 }, tags: ['Provider'],
  },
  {
    id: 'pop-seoul', name: 'PoP · Seoul', kind: 'router', asn: 65001, routerId: '192.0.2.20',
    appliance: { kind: 'bird', runtime: 'compatibility', version: '2.17.1', entrypoint: '/etc/bird/bird.conf' },
    interfaces: [iface('seoul-transit', 'eth0', ['192.0.2.1/31']), iface('seoul-service', 'eth1', ['172.16.1.1/30'])],
    files: [file('/etc/bird/bird.conf', seoulConfig, true)], state: 'up', position: { x: 575, y: 95 }, tags: ['Seoul'],
  },
  {
    id: 'pop-frankfurt', name: 'PoP · Frankfurt', kind: 'router', asn: 65001, routerId: '198.51.100.20',
    appliance: { kind: 'frr', runtime: 'compatibility', version: '10.4', entrypoint: '/etc/frr/frr.conf' },
    interfaces: [iface('frankfurt-transit', 'eth0', ['198.51.100.1/31']), iface('frankfurt-service', 'eth1', ['172.16.2.1/30'])],
    files: [file('/etc/frr/frr.conf', frankfurtConfig, true)], state: 'up', position: { x: 575, y: 335 }, tags: ['Frankfurt'],
  },
  {
    id: 'service-seoul', name: 'Service · Seoul', kind: 'service',
    appliance: { kind: 'service', runtime: 'compatibility', version: '1' },
    interfaces: [iface('service-seoul-eth0', 'eth0', ['172.16.1.2/30'], '172.16.1.1')], files: [], state: 'up', position: { x: 850, y: 95 },
    service: { addresses: ['203.0.113.53/32'], protocols: ['icmp'] }, tags: ['Seoul'],
  },
  {
    id: 'service-frankfurt', name: 'Service · Frankfurt', kind: 'service',
    appliance: { kind: 'service', runtime: 'compatibility', version: '1' },
    interfaces: [iface('service-frankfurt-eth0', 'eth0', ['172.16.2.2/30'], '172.16.2.1')], files: [], state: 'up', position: { x: 850, y: 335 },
    service: { addresses: ['203.0.113.53/32'], protocols: ['icmp'] }, tags: ['Frankfurt'],
  },
];

export function createExampleProject(): LabProject {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: `anycast-demo-${crypto.randomUUID?.() ?? Date.now()}`,
    name: 'Two-PoP anycast lab', createdAt: now, updatedAt: now, seed: 678,
    nodes: structuredClone(nodes),
    links: [
      { id: 'link-client-transit', endpoints: [{ nodeId: 'client-seoul', interfaceId: 'client-seoul-eth0' }, { nodeId: 'transit', interfaceId: 'transit-client' }], state: 'up', latencyMs: 2, jitterMs: 0.2, loss: 0, bandwidthMbps: 1000 },
      { id: 'link-transit-seoul', endpoints: [{ nodeId: 'transit', interfaceId: 'transit-seoul' }, { nodeId: 'pop-seoul', interfaceId: 'seoul-transit' }], state: 'up', latencyMs: 5, jitterMs: 0.5, loss: 0, bandwidthMbps: 1000 },
      { id: 'link-transit-frankfurt', endpoints: [{ nodeId: 'transit', interfaceId: 'transit-frankfurt' }, { nodeId: 'pop-frankfurt', interfaceId: 'frankfurt-transit' }], state: 'up', latencyMs: 110, jitterMs: 4, loss: 0, bandwidthMbps: 1000 },
      { id: 'link-seoul-service', endpoints: [{ nodeId: 'pop-seoul', interfaceId: 'seoul-service' }, { nodeId: 'service-seoul', interfaceId: 'service-seoul-eth0' }], state: 'up', latencyMs: 0.3, jitterMs: 0, loss: 0, bandwidthMbps: 10000 },
      { id: 'link-frankfurt-service', endpoints: [{ nodeId: 'pop-frankfurt', interfaceId: 'frankfurt-service' }, { nodeId: 'service-frankfurt', interfaceId: 'service-frankfurt-eth0' }], state: 'up', latencyMs: 0.3, jitterMs: 0, loss: 0, bandwidthMbps: 10000 },
    ],
    scenarioEvents: [],
    settings: { defaultTtl: 32, maxConvergenceIterations: 64, captureLimit: 10000 },
  };
}
