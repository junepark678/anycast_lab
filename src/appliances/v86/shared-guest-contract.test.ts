import { describe, expect, it } from 'vitest';
import type {
  ApplianceBootRequest,
  ApplianceInterfaceAddress,
  ApplianceInterfaceSpec,
} from '../abi';
import {
  SHARED_GUEST_CAPACITY_GUIDANCE,
  SHARED_GUEST_LIMITS,
  SharedGuestContractError,
  inspectSharedBootstrapArchive,
  inspectSharedGuestBootRequest,
  validateV86BootRequest,
} from './shared-guest-contract';

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

describe('shared guest limits contract', () => {
  it('accepts every structural count at the anycast-labd boundary', () => {
    const request = bootRequest({
      argv: Array.from({ length: SHARED_GUEST_LIMITS.argumentsPerNode }, () => ''),
      environment: Object.fromEntries(
        Array.from({ length: SHARED_GUEST_LIMITS.environmentPerNode }, (_, index) => [`V${index}`, '']),
      ),
      interfaces: Array.from(
        { length: SHARED_GUEST_LIMITS.interfacesPerNode },
        (_, index) => networkInterface(index, fourAddresses(index)),
      ),
    });

    const inspection = inspectSharedGuestBootRequest(request);

    expect(inspection.violations).toEqual([]);
    expect(request.interfaces.flatMap((value) => value.addresses)).toHaveLength(
      SHARED_GUEST_LIMITS.addressesPerNode,
    );
    expect(() => validateV86BootRequest(request)).not.toThrow();
  });

  it.each([
    [
      'arguments',
      bootRequest({ argv: Array.from({ length: SHARED_GUEST_LIMITS.argumentsPerNode + 1 }, () => '') }),
      'argument-count',
    ],
    [
      'environment',
      bootRequest({
        environment: Object.fromEntries(
          Array.from({ length: SHARED_GUEST_LIMITS.environmentPerNode + 1 }, (_, index) => [`V${index}`, '']),
        ),
      }),
      'environment-count',
    ],
    [
      'interfaces',
      bootRequest({
        interfaces: Array.from(
          { length: SHARED_GUEST_LIMITS.interfacesPerNode + 1 },
          (_, index) => networkInterface(index),
        ),
      }),
      'interface-count',
    ],
    [
      'addresses',
      bootRequest({
        interfaces: [
          networkInterface(
            0,
            Array.from(
              { length: SHARED_GUEST_LIMITS.addressesPerNode + 1 },
              (_, index): ApplianceInterfaceAddress => ({
                family: 'ipv6',
                address: index === 0 ? '2001:db8::' : `2001:db8::${index.toString(16)}`,
                prefixLength: 64,
              }),
            ),
          ),
        ],
      }),
      'address-count',
    ],
    [
      'MTU',
      bootRequest({
        interfaces: [{ ...networkInterface(0), mtu: SHARED_GUEST_LIMITS.maximumMtu + 1 }],
      }),
      'interface-mtu',
    ],
  ])('rejects a node that exceeds the guest %s structure', (_label, request, code) => {
    const inspection = inspectSharedGuestBootRequest(request as ApplianceBootRequest);

    expect(inspection.violations.map((violation) => violation.code)).toContain(code);
    expect(() => validateV86BootRequest(request as ApplianceBootRequest)).toThrow(SharedGuestContractError);
  });

  it('applies per-field UTF-8 limits and the aggregate decoded-config budget', () => {
    const request = bootRequest({
      nodeId: 'λ'.repeat(129),
      argv: Array.from({ length: 33 }, () => 'x'.repeat(SHARED_GUEST_LIMITS.argumentBytes)),
      environment: {
        ['E'.repeat(SHARED_GUEST_LIMITS.environmentNameBytes + 1)]:
          'x'.repeat(SHARED_GUEST_LIMITS.environmentValueBytes + 1),
      },
      interfaces: [{ ...networkInterface(0), id: 'i'.repeat(SHARED_GUEST_LIMITS.interfaceIdBytes + 1) }],
    });

    const codes = inspectSharedGuestBootRequest(request).violations.map((violation) => violation.code);

    expect(codes).toEqual(expect.arrayContaining([
      'node-id-bytes',
      'environment-name',
      'environment-value-bytes',
      'interface-id-bytes',
      'config-decoded-bytes',
    ]));
  });

  it('accounts for file payload, ustar padding, entry count, paths, and privilege bits', () => {
    const exactFileLimit = bootRequest({
      files: [{ path: '/etc/full', contents: new Uint8Array(SHARED_GUEST_LIMITS.fileBytes), mode: 0o640 }],
    });
    const tooManyEntries = bootRequest({
      files: Array.from({ length: SHARED_GUEST_LIMITS.rootArchiveEntries }, (_, index) => ({
        path: `/etc/f${index}`,
        contents: new Uint8Array(),
      })),
    });
    const unsafe = bootRequest({
      files: [{ path: '/usr/local/immutable', contents: text('x'), mode: 0o4755 }],
    });

    expect(inspectSharedGuestBootRequest(exactFileLimit).violations.map((value) => value.code)).toEqual([
      'archive-bytes',
    ]);
    expect(inspectSharedGuestBootRequest(tooManyEntries).violations.map((value) => value.code)).toContain(
      'archive-entries',
    );
    expect(inspectSharedGuestBootRequest(unsafe).violations.map((value) => value.code)).toEqual(
      expect.arrayContaining(['file-path', 'file-mode']),
    );
  });

  it.each([
    '/run/anycastlab/start.sh',
    '/run/anycastlab/entrypoint.failure',
    '/run/anycastlab/entrypoint.failure/nested',
    '/run/anycastlab/frr-status.out',
    '/run/anycastlab/frr-start.out',
    '/run/anycastlab/frr-start.pipe',
    '/run/anycastlab/frr-start.done',
    '/run/anycastlab/frr-start.done.tmp',
    '/run/anycastlab/frr-start.pid',
    '/run/anycastlab/frr-start.pid.tmp',
  ])('reserves the supervisor-owned guest path %s', (path) => {
    const inspection = inspectSharedGuestBootRequest(bootRequest({
      files: [{ path, contents: text('spoofed') }],
    }));

    expect(inspection.violations).toContainEqual(expect.objectContaining({
      code: 'file-path-reserved',
      path: 'files[0].path',
    }));
  });

  it('rejects a file and aggregate payload above 16 MiB before constructing an archive', () => {
    const request = bootRequest({
      files: [{
        path: '/etc/oversized',
        contents: new Uint8Array(SHARED_GUEST_LIMITS.fileBytes + 1),
      }],
    });

    expect(inspectSharedGuestBootRequest(request).violations.map((value) => value.code)).toEqual(
      expect.arrayContaining(['file-bytes', 'archive-payload-bytes', 'archive-bytes']),
    );
  });

  it('estimates the complete outer bootstrap and exposes the exact guest ceiling', () => {
    const metrics = inspectSharedGuestBootRequest(bootRequest()).metrics;
    const one = inspectSharedBootstrapArchive([metrics]);
    const many = inspectSharedBootstrapArchive(Array.from({ length: 64 }, () => metrics));

    expect(one.bytes).toBeGreaterThan(metrics.rootArchiveBytes + metrics.nodeConfigBytes);
    expect(many.bytes).toBeGreaterThan(one.bytes);
    expect(SHARED_GUEST_LIMITS.bootstrapArchiveBytes).toBe(16 * 1024 * 1024);
    expect(SHARED_GUEST_CAPACITY_GUIDANCE.recommendedNodes).toBe(8);
  });
});

function bootRequest(overrides: Partial<ApplianceBootRequest> = {}): ApplianceBootRequest {
  return {
    nodeId: 'router-1',
    hostname: 'router-1',
    entrypoint: '/usr/sbin/bird',
    argv: ['-f', '-c', '/etc/bird/bird.conf'],
    environment: { LC_ALL: 'C' },
    randomSeed: 'test-seed',
    files: [{ path: '/etc/bird/bird.conf', contents: text('router id 192.0.2.1;\n'), mode: 0o640 }],
    interfaces: [networkInterface(0, [{
      family: 'ipv4', address: '192.0.2.1', prefixLength: 31,
    }])],
    ...overrides,
  };
}

function networkInterface(
  index: number,
  addresses: readonly ApplianceInterfaceAddress[] = [],
): ApplianceInterfaceSpec {
  return {
    id: `interface-${index}`,
    name: `eth${index}`,
    mac: `02:00:00:00:${Math.floor(index / 256).toString(16).padStart(2, '0')}:${(index % 256).toString(16).padStart(2, '0')}`,
    mtu: SHARED_GUEST_LIMITS.maximumMtu,
    up: true,
    addresses,
  };
}

function fourAddresses(index: number): readonly ApplianceInterfaceAddress[] {
  return Array.from({ length: 4 }, (_, offset) => ({
    family: 'ipv4' as const,
    address: `10.${index}.${offset}.1`,
    prefixLength: 24,
  }));
}
