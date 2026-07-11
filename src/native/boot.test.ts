import { describe, expect, it } from 'vitest';
import {
  APPLIANCE_HOST_ABI_VERSION,
  APPLIANCE_RUNTIME_API_VERSION,
  type ApplianceKind,
  type ApplianceRuntime,
  type ApplianceRuntimeDescriptor,
} from '../appliances/abi';
import { ApplianceRuntimeRegistry } from '../appliances/registry';
import { createEmptyProject, type LabNode, type LabProject } from '../core/types';
import {
  BIRD_NATIVE_EXECUTABLE,
  DEFAULT_FRR_DAEMONS,
  FRR_DAEMONS_FILE,
  FRR_CONFIG_FILE,
  FRR_NATIVE_WRAPPER,
  FRR_WRAPPER_SOURCE,
  analyzeNativeProject,
  buildNativeBootRequest,
} from './boot';

const decoder = new TextDecoder();

describe('native appliance boot mapping', () => {
  it('maps a native BIRD node to its real executable, exact files, addresses, and deterministic MACs', () => {
    const node = birdNode('bird-a', 'Router Å');
    node.interfaces.push({
      id: 'service',
      name: 'eth1',
      addresses: ['2001:db8::1/64'],
      state: 'down',
      mtu: 9000,
    });
    const project = projectWith(node);

    const first = buildNativeBootRequest(project, node);
    const second = buildNativeBootRequest(project, node);

    expect(first.entrypoint).toBe(BIRD_NATIVE_EXECUTABLE);
    expect(first.argv).toEqual(['-f', '-c', '/etc/bird/bird.conf']);
    expect(first.hostname).toBe('router-a');
    expect(first.randomSeed).toBe('42:bird-a');
    expect(first.files).toHaveLength(1);
    expect(decoder.decode(first.files[0]!.contents)).toBe('router id 192.0.2.1;\n');
    expect(first.interfaces).toEqual([
      {
        id: 'uplink',
        name: 'eth0',
        mac: first.interfaces[0]!.mac,
        mtu: 1500,
        up: true,
        addresses: [{ family: 'ipv4', address: '192.0.2.1', prefixLength: 31 }],
      },
      {
        id: 'service',
        name: 'eth1',
        mac: first.interfaces[1]!.mac,
        mtu: 9000,
        up: false,
        addresses: [{ family: 'ipv6', address: '2001:db8::1', prefixLength: 64 }],
      },
    ]);
    expect(first.interfaces[0]!.mac).toMatch(/^02(:[0-9a-f]{2}){5}$/);
    expect(first.interfaces[0]!.mac).not.toBe(first.interfaces[1]!.mac);
    expect(second.interfaces.map((value) => value.mac)).toEqual(first.interfaces.map((value) => value.mac));
  });

  it('honors an explicit BIRD config entrypoint rather than regenerating configuration', () => {
    const node = birdNode('bird-a');
    node.files.push({ path: '/etc/bird/alternate.conf', content: '# exact alternate\n' });
    node.appliance.entrypoint = '/etc/bird/alternate.conf';

    const boot = buildNativeBootRequest(projectWith(node), node);

    expect(boot.argv).toEqual(['-f', '-c', '/etc/bird/alternate.conf']);
    expect(decoder.decode(boot.files[1]!.contents)).toBe('# exact alternate\n');
  });

  it('boots FRR through the image helper and only injects daemon controls when absent', () => {
    const node = frrNode('frr-a');
    const boot = buildNativeBootRequest(projectWith(node), node);

    expect(boot.entrypoint).toBe(FRR_NATIVE_WRAPPER);
    expect(boot.argv).toEqual([]);
    expect(fileText(boot.files, '/etc/frr/frr.conf')).toBe('hostname exact-router\n!\n');
    expect(fileText(boot.files, FRR_DAEMONS_FILE)).toBe(DEFAULT_FRR_DAEMONS);
    expect(DEFAULT_FRR_DAEMONS).toContain('bgpd=yes');
    expect(DEFAULT_FRR_DAEMONS).toContain('ospfd=no');
    expect(fileText(boot.files, FRR_NATIVE_WRAPPER)).toBe(FRR_WRAPPER_SOURCE);
    expect(FRR_WRAPPER_SOURCE).toContain('/usr/libexec/anycastlab-frr start');
    expect(FRR_WRAPPER_SOURCE).toContain('/usr/libexec/anycastlab-frr stop');
    expect(FRR_WRAPPER_SOURCE).toContain('/usr/sbin/frrinit.sh status');
    expect(FRR_WRAPPER_SOURCE).toContain('touch /run/anycastlab/frr.ready');
    expect(FRR_WRAPPER_SOURCE).toContain('[ "$failures" -lt 3 ] || exit 1');
    expect(FRR_WRAPPER_SOURCE).toContain('while sleep 2');
    expect(boot.files.find((file) => file.path === FRR_NATIVE_WRAPPER)?.mode).toBe(0o755);
  });

  it('does not replace a user-provided FRR daemons file', () => {
    const node = frrNode('frr-a');
    node.files.push({ path: FRR_DAEMONS_FILE, content: 'zebra=yes\nbgpd=yes\n' });

    const boot = buildNativeBootRequest(projectWith(node), node);

    expect(boot.files.filter((file) => file.path === FRR_DAEMONS_FILE)).toHaveLength(1);
    expect(fileText(boot.files, FRR_DAEMONS_FILE)).toBe('zebra=yes\nbgpd=yes\n');
  });

  it('rejects an FRR entrypoint the upstream integrated-config service would ignore', () => {
    const node = frrNode('frr-custom');
    node.files.push({ path: '/etc/frr/custom.conf', content: 'hostname custom\n' });
    node.appliance.entrypoint = '/etc/frr/custom.conf';
    const project = projectWith(node);

    expect(analyzeNativeProject(project).diagnostics).toContainEqual(expect.objectContaining({
      severity: 'error',
      code: 'native.frr-entrypoint-path',
    }));
    expect(() => buildNativeBootRequest(project, node)).toThrow(`requires its selected entrypoint at ${FRR_CONFIG_FILE}`);
  });

  it('maps clients to a persistent shell and installs IPv4 and IPv6 default routes', () => {
    const node = clientNode('client-a');
    node.client = { defaultGateway: '192.0.2.1' };
    node.interfaces.push({
      id: 'v6',
      name: 'eth1',
      addresses: ['2001:db8::2/64'],
      gateway: '2001:db8::1',
      state: 'up',
    });

    const boot = buildNativeBootRequest(projectWith(node), node);

    expect(boot.entrypoint).toBe('/bin/sh');
    expect(boot.argv[0]).toBe('-c');
    expect(boot.argv[1]).toContain("ip route replace default via '192.0.2.1' dev 'eth0'");
    expect(boot.argv[1]).toContain("ip -6 route replace default via '2001:db8::1' dev 'eth1'");
    expect(boot.argv[1]).toContain('while :; do sleep 3600; done');
  });

  it('maps service nodes to client appliances and assigns service addresses to the first interface', () => {
    const node = serviceNode('dns-a');
    node.interfaces[0]!.gateway = '172.16.0.1';

    const boot = buildNativeBootRequest(projectWith(node), node);

    expect(boot.entrypoint).toBe('/bin/sh');
    expect(boot.interfaces[0]!.addresses).toEqual([
      { family: 'ipv4', address: '172.16.0.2', prefixLength: 30 },
      { family: 'ipv4', address: '203.0.113.53', prefixLength: 32 },
      { family: 'ipv6', address: '2001:db8:53::53', prefixLength: 128 },
    ]);
    expect(boot.argv[1]).toContain("ip route replace default via '172.16.0.1' dev 'eth0'");
  });
});

describe('native project eligibility', () => {
  it('resolves BIRD, FRR, clients, and services to native runtimes without applying client versions', () => {
    const nodes = [birdNode('bird-a'), frrNode('frr-a'), clientNode('client-a'), serviceNode('service-a')];
    const project = projectWith(...nodes);
    const registry = descriptorRegistry([
      descriptor('bird', 'bird-native', '2.17.1'),
      descriptor('frr', 'frr-native', '10.5.1'),
      descriptor('client', 'linux-client', null),
    ]);

    const result = analyzeNativeProject(project, registry);

    expect(result.eligible).toBe(true);
    expect(Object.fromEntries(Object.entries(result.runtimes).map(([id, value]) => [id, value.runtimeId]))).toEqual({
      'bird-a': 'bird-native',
      'frr-a': 'frr-native',
      'client-a': 'linux-client',
      'service-a': 'linux-client',
    });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'native.frr-daemons-generated' }));
  });

  it('reports a precise error when no native client exists and never opts into compatibility', () => {
    const node = clientNode('client-a');
    const project = projectWith(node);
    const registry = descriptorRegistry([descriptor('bird', 'unrelated-bird', '2.17.1')]);

    const result = analyzeNativeProject(project, registry);

    expect(result.eligible).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'native.client-runtime-unavailable', nodeId: 'client-a' }),
    );
  });

  it('rejects nodes still marked for compatibility and reserved FRR wrapper collisions', () => {
    const bird = birdNode('bird-a');
    bird.appliance.runtime = 'compatibility';
    const frr = frrNode('frr-a');
    frr.files.push({ path: FRR_NATIVE_WRAPPER, content: 'user file' });

    const result = analyzeNativeProject(projectWith(bird, frr));

    expect(result.eligible).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining(['native.runtime-not-selected', 'native.frr-wrapper-reserved']),
    );
  });

  it('diagnoses invalid and duplicate explicit guest MAC addresses before boot', () => {
    const first = birdNode('bird-a');
    const second = birdNode('bird-b');
    first.interfaces[0]!.mac = '02:00:00:00:00:aa';
    second.interfaces[0]!.mac = '02:00:00:00:00:aa';
    second.interfaces.push({ id: 'broken', name: 'eth1', mac: 'not-a-mac', addresses: [], state: 'up' });

    const result = analyzeNativeProject(projectWith(first, second));

    expect(result.eligible).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining(['native.mac-duplicate', 'native.mac-invalid']),
    );
  });
});

function projectWith(...nodes: LabNode[]): LabProject {
  return {
    ...createEmptyProject({ id: 'native-test', name: 'Native test', seed: 42 }),
    nodes,
    settings: { defaultTtl: 32, maxConvergenceIterations: 64, captureLimit: 100 },
  };
}

function birdNode(id: string, name = id): LabNode {
  return {
    id,
    name,
    kind: 'router',
    appliance: { kind: 'bird', runtime: 'wasm', version: '2.17.1', entrypoint: '/etc/bird/bird.conf' },
    interfaces: [{ id: 'uplink', name: 'eth0', addresses: ['192.0.2.1/31'], state: 'up' }],
    files: [{ path: '/etc/bird/bird.conf', content: 'router id 192.0.2.1;\n', entrypoint: true }],
    state: 'up',
  };
}

function frrNode(id: string): LabNode {
  return {
    id,
    name: id,
    kind: 'router',
    appliance: { kind: 'frr', runtime: 'wasm', version: '10.5.1', entrypoint: '/etc/frr/frr.conf' },
    interfaces: [{ id: 'uplink', name: 'eth0', addresses: ['198.51.100.1/31'], state: 'up' }],
    files: [{ path: '/etc/frr/frr.conf', content: 'hostname exact-router\n!\n', entrypoint: true }],
    state: 'up',
  };
}

function clientNode(id: string): LabNode {
  return {
    id,
    name: id,
    kind: 'client',
    appliance: { kind: 'client', runtime: 'wasm', version: '1' },
    interfaces: [{ id: 'uplink', name: 'eth0', addresses: ['192.0.2.2/24'], state: 'up' }],
    files: [],
    state: 'up',
    client: {},
  };
}

function serviceNode(id: string): LabNode {
  return {
    id,
    name: id,
    kind: 'service',
    appliance: { kind: 'service', runtime: 'wasm', version: '1' },
    interfaces: [{ id: 'uplink', name: 'eth0', addresses: ['172.16.0.2/30'], state: 'up' }],
    files: [],
    state: 'up',
    service: { addresses: ['203.0.113.53/32', '2001:db8:53::53/128'], protocols: ['icmp', 'dns'] },
  };
}

function descriptor(kind: ApplianceKind, runtimeId: string, upstreamVersion: string | null): ApplianceRuntimeDescriptor {
  return {
    runtimeId,
    displayName: runtimeId,
    kind,
    fidelity: 'native',
    upstreamVersion,
    buildId: 'test-build',
    runtimeApiVersion: APPLIANCE_RUNTIME_API_VERSION,
    hostAbiVersion: APPLIANCE_HOST_ABI_VERSION,
    capabilities: {
      ethernet: true,
      ipv4: true,
      ipv6: true,
      nativeConfig: true,
      packetCapture: true,
      terminals: ['serial'],
      protocols: [],
    },
    limitations: [],
  };
}

function descriptorRegistry(descriptors: readonly ApplianceRuntimeDescriptor[]): ApplianceRuntimeRegistry {
  const registry = new ApplianceRuntimeRegistry();
  for (const value of descriptors) {
    registry.register({ descriptor: value, create: () => ({ descriptor: value } as ApplianceRuntime) });
  }
  return registry;
}

function fileText(files: readonly { path: string; contents: Uint8Array }[], path: string): string | undefined {
  const value = files.find((file) => file.path === path);
  return value === undefined ? undefined : decoder.decode(value.contents);
}
