import { describe, expect, it } from 'vitest';
import type { ApplianceBootRequest } from '../abi';
import {
  SHARED_GUEST_LIMITS,
  inspectSharedGuestBootRequest,
} from './shared-guest-contract';
import {
  SHARED_BOOTSTRAP_ROOT,
  SHARED_LAB_MAX_NODES,
  SharedV86BootstrapBuilder,
  encodeBootstrapText,
  serializeNode,
} from './shared-bootstrap';
import { decodeSharedText } from './shared-protocol';
import { readUstarArchive } from './tar';

describe('SharedV86BootstrapBuilder', () => {
  it('assigns collision-free VLANs across nodes with identical interface IDs', () => {
    const builder = new SharedV86BootstrapBuilder();
    const bird = builder.register('bird', request('bird-1'));
    const frr = builder.register('frr', request('frr-1'));
    expect(bird.interfaces[0]?.vlanId).toBe(100);
    expect(frr.interfaces[0]?.vlanId).toBe(101);
    expect(new Set(builder.nodes().flatMap((node) => node.interfaces.map((value) => value.vlanId))).size).toBe(2);
  });

  it('seals node metadata and byte-exact native files into isolated nested archives', () => {
    const builder = new SharedV86BootstrapBuilder();
    builder.register('bird', request('bird-1'));
    builder.register('frr', request('frr-1'));
    const outer = readUstarArchive(builder.seal());
    expect(outer.map((file) => file.path)).toEqual([
      `${SHARED_BOOTSTRAP_ROOT}/node-count`,
      `${SHARED_BOOTSTRAP_ROOT}/nodes/1/node.conf`,
      `${SHARED_BOOTSTRAP_ROOT}/nodes/1/root.tar`,
      `${SHARED_BOOTSTRAP_ROOT}/nodes/2/node.conf`,
      `${SHARED_BOOTSTRAP_ROOT}/nodes/2/root.tar`,
    ]);
    const rootArchive = outer.find((file) => file.path.endsWith('/nodes/1/root.tar'))!;
    const nested = readUstarArchive(rootArchive.contents);
    expect(nested).toHaveLength(1);
    expect(nested[0]).toMatchObject({ path: '/etc/bird.conf', mode: 0o640 });
    expect([...nested[0]!.contents]).toEqual([...new TextEncoder().encode('router id 192.0.2.1;\n')]);
    expect(() => builder.register('client', request('late'))).toThrow(/sealed/);
    expect(() => builder.seal()).toThrow(/sealed/);
  });

  it('encodes hostile display values rather than admitting metadata directives', () => {
    const builder = new SharedV86BootstrapBuilder();
    const node = builder.register('client', {
      ...request('client-1'),
      nodeId: 'client-1\nentrypoint /bin/false',
    });
    const line = serializeNode(node).split('\n').find((value) => value.startsWith('node '))!;
    expect(line.split(' ')).toHaveLength(5);
    expect(decodeSharedText(line.split(' ')[3]!)).toBe('client-1\nentrypoint /bin/false');
  });

  it('uses an unambiguous non-base64 sentinel for empty arguments and environment values', () => {
    const builder = new SharedV86BootstrapBuilder();
    const node = builder.register('client', {
      ...request('client-1'),
      argv: ['', '--label='],
      environment: { EMPTY: '', PRESENT: 'value' },
    });
    const lines = serializeNode(node).trimEnd().split('\n');
    expect(encodeBootstrapText('')).toBe('-');
    expect(lines).toContain('arg -');
    expect(lines).toContain(`arg ${encodeBootstrapText('--label=')}`);
    expect(lines).toContain('env EMPTY -');
    expect(lines).toContain(`env PRESENT ${encodeBootstrapText('value')}`);
    expect(lines.every((line) => !line.endsWith(' '))).toBe(true);
  });

  it('rejects a host-side node count that the guest supervisor cannot represent', () => {
    const builder = new SharedV86BootstrapBuilder();
    const withoutInterfaces = { ...request('client'), interfaces: [] };
    for (let index = 0; index < SHARED_LAB_MAX_NODES; index += 1) {
      builder.register('client', { ...withoutInterfaces, nodeId: `client-${index}` });
    }
    expect(() => builder.register('client', withoutInterfaces)).toThrow(/at most 64 nodes/);
  });

  it('keeps exact serialized config sizing in lockstep with the browser contract', () => {
    const builder = new SharedV86BootstrapBuilder();
    const node = builder.register('bird', request('bird-1'));
    const inspection = inspectSharedGuestBootRequest(node.request, {
      slot: node.slot,
      kind: node.kind,
      vlanIds: node.interfaces.map((networkInterface) => networkInterface.vlanId),
    });

    expect(inspection.metrics.nodeConfigBytes).toBe(new TextEncoder().encode(serializeNode(node)).byteLength);
  });

  it('rejects an oversized aggregate before constructing the outer bootstrap', () => {
    const builder = new SharedV86BootstrapBuilder();
    const large = new Uint8Array(8 * 1024 * 1024);
    builder.register('client', {
      ...request('client-1'),
      files: [{ path: '/etc/one', contents: large }],
    });
    builder.register('client', {
      ...request('client-2'),
      files: [{ path: '/etc/two', contents: large }],
    });

    expect(SHARED_GUEST_LIMITS.bootstrapArchiveBytes).toBe(16 * 1024 * 1024);
    expect(() => builder.seal()).toThrow(/Shared bootstrap (payload|requires)/);
  });
});

function request(nodeId: string): ApplianceBootRequest {
  return {
    nodeId,
    hostname: nodeId,
    entrypoint: '/usr/sbin/bird',
    argv: ['-f', '-c', '/etc/bird.conf'],
    environment: { LC_ALL: 'C' },
    randomSeed: '00'.repeat(32),
    files: [{
      path: '/etc/bird.conf',
      contents: new TextEncoder().encode('router id 192.0.2.1;\n'),
      mode: 0o640,
    }],
    interfaces: [{
      id: 'eth0',
      name: 'eth0',
      mac: '02:00:00:00:00:01',
      mtu: 1500,
      up: true,
      addresses: [{ family: 'ipv4', address: '192.0.2.1', prefixLength: 24 }],
    }],
  };
}
