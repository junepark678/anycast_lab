import type {
  ApplianceBootRequest,
  ApplianceFile,
  ApplianceInterfaceAddress,
} from '../abi';
import { parseIp } from '../../core/ip';

const TAR_BLOCK_BYTES = 512;
const encoder = new TextEncoder();
const RESERVED_GUEST_PATHS = [
  '/run/anycastlab/start.sh',
  '/run/anycastlab/entrypoint.failure',
  '/run/anycastlab/frr-status.out',
  '/run/anycastlab/frr-start.out',
  '/run/anycastlab/frr-start.pipe',
  '/run/anycastlab/frr-start.done',
  '/run/anycastlab/frr-start.done.tmp',
  '/run/anycastlab/frr-start.pid',
  '/run/anycastlab/frr-start.pid.tmp',
] as const;

/**
 * Browser-side mirror of the bounded structures in anycast-labd.
 *
 * Keep these values in lockstep with `anycast-labd.h`.  They are intentionally
 * centralized here so project preflight, direct runtime use, and bootstrap
 * construction all reject requests the guest cannot represent.
 */
export const SHARED_GUEST_LIMITS = Object.freeze({
  nodes: 64,
  argumentsPerNode: 64,
  environmentPerNode: 64,
  interfacesPerNode: 32,
  addressesPerNode: 128,
  terminals: 32,
  controlLineBytes: 256 * 1024,
  terminalChunkBytes: 16 * 1024,
  nodeIdBytes: 256,
  hostnameBytes: 63,
  entrypointBytes: 4_095,
  argumentBytes: 4_096,
  environmentNameBytes: 127,
  environmentValueBytes: 8_192,
  interfaceIdBytes: 256,
  interfaceNameBytes: 15,
  minimumMtu: 576,
  maximumMtu: 65_531,
  nodeConfigBytes: 256 * 1024,
  nodeConfigDecodedBytes: 128 * 1024,
  fileBytes: 16 * 1024 * 1024,
  rootArchiveBytes: 16 * 1024 * 1024,
  rootArchivePayloadBytes: 16 * 1024 * 1024,
  rootArchiveEntries: 1_024,
  bootstrapArchiveBytes: 16 * 1024 * 1024,
  bootstrapArchivePayloadBytes: 16 * 1024 * 1024,
  bootstrapArchiveEntries: 1_024,
});

/** Advisory thresholds for the fixed 128 MiB shared guest, never eligibility errors. */
export const SHARED_GUEST_CAPACITY_GUIDANCE = Object.freeze({
  memoryBytes: 128 * 1024 * 1024,
  recommendedNodes: 8,
});

export interface SharedGuestContractViolation {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export interface SharedGuestBootMetrics {
  readonly decodedConfigBytes: number;
  /** Conservative serialized size using the largest valid slot and VLAN tokens. */
  readonly nodeConfigBytes: number;
  readonly rootArchiveBytes: number;
  readonly rootArchivePayloadBytes: number;
  readonly rootArchiveEntries: number;
}

export interface SharedGuestBootInspection {
  readonly violations: readonly SharedGuestContractViolation[];
  readonly metrics: SharedGuestBootMetrics;
}

export interface SharedGuestNodeConfigContext {
  readonly slot: number;
  readonly kind: 'bird' | 'frr' | 'client';
  readonly vlanIds: readonly number[];
}

export interface UstarEnvelopeMetrics {
  readonly bytes: number;
  readonly payloadBytes: number;
  readonly entries: number;
}

export class SharedGuestContractError extends Error {
  constructor(readonly violations: readonly SharedGuestContractViolation[]) {
    const first = violations[0];
    super(
      first === undefined
        ? 'Shared guest boot request is invalid'
        : `${first.message}${violations.length === 1 ? '' : ` (${violations.length - 1} more violation${violations.length === 2 ? '' : 's'})`}`,
    );
    this.name = 'SharedGuestContractError';
  }
}

/** Inspect one node without allocating its potentially multi-megabyte ustar archive. */
export function inspectSharedGuestBootRequest(
  request: ApplianceBootRequest,
  context?: SharedGuestNodeConfigContext,
): SharedGuestBootInspection {
  const violations: SharedGuestContractViolation[] = [];
  let decodedConfigBytes = 0;

  const decodedField = (
    value: string,
    maximum: number,
    label: string,
    code: string,
    path: string,
    options: { readonly empty?: boolean } = {},
  ): number => {
    const bytes = utf8Bytes(value);
    decodedConfigBytes += bytes + 1;
    if ((!options.empty && bytes === 0) || value.includes('\0')) {
      violations.push({ code, message: `${label} must be non-empty NUL-free UTF-8`, path });
    }
    if (bytes > maximum) {
      violations.push({ code, message: `${label} exceeds the guest limit of ${maximum} decoded bytes`, path });
    }
    return bytes;
  };

  decodedField(
    request.nodeId,
    SHARED_GUEST_LIMITS.nodeIdBytes,
    'Node id',
    'node-id-bytes',
    'nodeId',
  );
  decodedField(
    request.hostname,
    SHARED_GUEST_LIMITS.hostnameBytes,
    'Hostname',
    'hostname-bytes',
    'hostname',
  );
  if (!isLinuxHostname(request.hostname)) {
    violations.push({
      code: 'hostname',
      message: 'Hostname is not accepted by the shared Linux guest',
      path: 'hostname',
    });
  }
  decodedField(
    request.entrypoint,
    SHARED_GUEST_LIMITS.entrypointBytes,
    'Entrypoint',
    'entrypoint-bytes',
    'entrypoint',
  );
  if (!isNormalizedAbsolutePath(request.entrypoint)) {
    violations.push({
      code: 'entrypoint',
      message: 'Entrypoint must be a normalized absolute path',
      path: 'entrypoint',
    });
  }

  if (request.argv.length > SHARED_GUEST_LIMITS.argumentsPerNode) {
    violations.push({
      code: 'argument-count',
      message: `Node has ${request.argv.length} arguments; the shared guest supports at most ${SHARED_GUEST_LIMITS.argumentsPerNode}`,
      path: 'argv',
    });
  }
  for (const [index, argument] of request.argv.entries()) {
    decodedField(
      argument,
      SHARED_GUEST_LIMITS.argumentBytes,
      `Argument ${index}`,
      'argument-bytes',
      `argv[${index}]`,
      { empty: true },
    );
  }

  const environment = Object.entries(request.environment);
  if (environment.length > SHARED_GUEST_LIMITS.environmentPerNode) {
    violations.push({
      code: 'environment-count',
      message: `Node has ${environment.length} environment variables; the shared guest supports at most ${SHARED_GUEST_LIMITS.environmentPerNode}`,
      path: 'environment',
    });
  }
  for (const [name, value] of environment) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
      utf8Bytes(name) > SHARED_GUEST_LIMITS.environmentNameBytes
    ) {
      violations.push({
        code: 'environment-name',
        message: `Environment variable name ${JSON.stringify(name)} is not accepted by the shared guest`,
        path: `environment.${name}`,
      });
    }
    decodedField(
      value,
      SHARED_GUEST_LIMITS.environmentValueBytes,
      `Environment variable ${name}`,
      'environment-value-bytes',
      `environment.${name}`,
      { empty: true },
    );
  }

  if (request.interfaces.length > SHARED_GUEST_LIMITS.interfacesPerNode) {
    violations.push({
      code: 'interface-count',
      message: `Node has ${request.interfaces.length} interfaces; the shared guest supports at most ${SHARED_GUEST_LIMITS.interfacesPerNode}`,
      path: 'interfaces',
    });
  }
  let addressCount = 0;
  const interfaceIds = new Set<string>();
  const interfaceNames = new Set<string>();
  const interfaceMacs = new Set<string>();
  for (const [index, networkInterface] of request.interfaces.entries()) {
    const path = `interfaces[${index}]`;
    decodedField(
      networkInterface.id,
      SHARED_GUEST_LIMITS.interfaceIdBytes,
      `Interface ${index} id`,
      'interface-id-bytes',
      `${path}.id`,
    );
    decodedField(
      networkInterface.name,
      SHARED_GUEST_LIMITS.interfaceNameBytes,
      `Interface ${index} name`,
      'interface-name-bytes',
      `${path}.name`,
    );
    if (!isLinuxInterfaceName(networkInterface.name)) {
      violations.push({
        code: 'interface-name',
        message: `Interface name ${networkInterface.name} is invalid or reserved`,
        path: `${path}.name`,
      });
    }
    if (interfaceIds.has(networkInterface.id)) {
      violations.push({
        code: 'interface-id-duplicate',
        message: `Duplicate interface id: ${networkInterface.id}`,
        path: `${path}.id`,
      });
    }
    if (interfaceNames.has(networkInterface.name)) {
      violations.push({
        code: 'interface-name-duplicate',
        message: `Duplicate interface name: ${networkInterface.name}`,
        path: `${path}.name`,
      });
    }
    interfaceIds.add(networkInterface.id);
    interfaceNames.add(networkInterface.name);
    const mac = networkInterface.mac.toLowerCase();
    if (!isCanonicalUnicastMac(mac)) {
      violations.push({
        code: 'interface-mac',
        message: `Invalid unicast MAC address: ${networkInterface.mac}`,
        path: `${path}.mac`,
      });
    } else if (interfaceMacs.has(mac)) {
      violations.push({
        code: 'interface-mac-duplicate',
        message: `Duplicate interface MAC address: ${mac}`,
        path: `${path}.mac`,
      });
    }
    interfaceMacs.add(mac);
    if (
      !Number.isSafeInteger(networkInterface.mtu) ||
      networkInterface.mtu < SHARED_GUEST_LIMITS.minimumMtu ||
      networkInterface.mtu > SHARED_GUEST_LIMITS.maximumMtu
    ) {
      violations.push({
        code: 'interface-mtu',
        message: `Interface MTU ${networkInterface.mtu} is outside the guest range ${SHARED_GUEST_LIMITS.minimumMtu}-${SHARED_GUEST_LIMITS.maximumMtu}`,
        path: `${path}.mtu`,
      });
    }
    for (const [addressIndex, address] of networkInterface.addresses.entries()) {
      validateAddress(address, `${path}.addresses[${addressIndex}]`, violations);
      addressCount += 1;
    }
  }
  if (addressCount > SHARED_GUEST_LIMITS.addressesPerNode) {
    violations.push({
      code: 'address-count',
      message: `Node has ${addressCount} interface addresses; the shared guest supports at most ${SHARED_GUEST_LIMITS.addressesPerNode}`,
      path: 'interfaces',
    });
  }

  if (decodedConfigBytes > SHARED_GUEST_LIMITS.nodeConfigDecodedBytes) {
    violations.push({
      code: 'config-decoded-bytes',
      message: `Decoded node configuration is ${decodedConfigBytes} bytes; the guest limit is ${SHARED_GUEST_LIMITS.nodeConfigDecodedBytes}`,
      path: '',
    });
  }

  const nodeConfigBytes = serializedNodeConfigBytes(request, context);
  if (nodeConfigBytes > SHARED_GUEST_LIMITS.nodeConfigBytes) {
    violations.push({
      code: 'config-bytes',
      message: `Serialized node configuration can require ${nodeConfigBytes} bytes; the guest limit is ${SHARED_GUEST_LIMITS.nodeConfigBytes}`,
      path: '',
    });
  }

  const archive = inspectRootArchive(request.files, violations);
  return {
    violations,
    metrics: {
      decodedConfigBytes,
      nodeConfigBytes,
      rootArchiveBytes: archive.bytes,
      rootArchivePayloadBytes: archive.payloadBytes,
      rootArchiveEntries: archive.entries,
    },
  };
}

/** Fail closed for direct runtime callers, before any emulator or guest work. */
export function validateV86BootRequest(request: ApplianceBootRequest): void {
  const inspection = inspectSharedGuestBootRequest(request);
  if (inspection.violations.length > 0) {
    throw new SharedGuestContractError(inspection.violations);
  }
}

/** Exact outer ustar envelope for the supplied per-node measurements. */
export function inspectSharedBootstrapArchive(
  nodes: readonly SharedGuestBootMetrics[],
): UstarEnvelopeMetrics {
  const directoryEntries = 4 + nodes.length;
  let bytes = directoryEntries * TAR_BLOCK_BYTES + TAR_BLOCK_BYTES * 2;
  let payloadBytes = 0;
  for (const node of nodes) {
    bytes += tarEntryBytes(node.nodeConfigBytes);
    bytes += tarEntryBytes(node.rootArchiveBytes);
    payloadBytes += node.nodeConfigBytes + node.rootArchiveBytes;
  }
  const nodeCountBytes = encoder.encode(`${nodes.length}\n`).byteLength;
  bytes += tarEntryBytes(nodeCountBytes);
  payloadBytes += nodeCountBytes;
  return {
    bytes,
    payloadBytes,
    entries: directoryEntries + nodes.length * 2 + 1,
  };
}

/** Exact deterministic ustar envelope without materializing payload copies. */
export function measureUstarArchive(files: readonly ApplianceFile[]): UstarEnvelopeMetrics {
  const directories = new Set<string>();
  let bytes = TAR_BLOCK_BYTES * 2;
  let payloadBytes = 0;
  for (const file of files) {
    payloadBytes += file.contents.byteLength;
    bytes += tarEntryBytes(file.contents.byteLength);
    const parts = file.path.slice(1).split('/');
    for (let part = 1; part < parts.length; part += 1) {
      directories.add(`${parts.slice(0, part).join('/')}/`);
    }
  }
  bytes += directories.size * TAR_BLOCK_BYTES;
  return { bytes, payloadBytes, entries: files.length + directories.size };
}

export function validateSharedBootstrapArchive(files: readonly ApplianceFile[]): void {
  validateSharedBootstrapEnvelope(measureUstarArchive(files));
}

/** Preflight the aggregate before any nested root archive is materialized. */
export function validateSharedBootstrapMetrics(nodes: readonly SharedGuestBootMetrics[]): void {
  validateSharedBootstrapEnvelope(inspectSharedBootstrapArchive(nodes));
}

function validateSharedBootstrapEnvelope(metrics: UstarEnvelopeMetrics): void {
  const violations: SharedGuestContractViolation[] = [];
  if (metrics.payloadBytes > SHARED_GUEST_LIMITS.bootstrapArchivePayloadBytes) {
    violations.push({
      code: 'bootstrap-payload-bytes',
      message: `Shared bootstrap payload is ${metrics.payloadBytes} bytes; the guest limit is ${SHARED_GUEST_LIMITS.bootstrapArchivePayloadBytes}`,
      path: 'nodes',
    });
  }
  if (metrics.entries > SHARED_GUEST_LIMITS.bootstrapArchiveEntries) {
    violations.push({
      code: 'bootstrap-entries',
      message: `Shared bootstrap requires ${metrics.entries} entries; the guest limit is ${SHARED_GUEST_LIMITS.bootstrapArchiveEntries}`,
      path: 'nodes',
    });
  }
  if (metrics.bytes > SHARED_GUEST_LIMITS.bootstrapArchiveBytes) {
    violations.push({
      code: 'bootstrap-bytes',
      message: `Shared bootstrap requires ${metrics.bytes} bytes; the guest limit is ${SHARED_GUEST_LIMITS.bootstrapArchiveBytes}`,
      path: 'nodes',
    });
  }
  if (violations.length > 0) throw new SharedGuestContractError(violations);
}

function inspectRootArchive(
  files: readonly ApplianceFile[],
  violations: SharedGuestContractViolation[],
): { readonly bytes: number; readonly payloadBytes: number; readonly entries: number } {
  const paths = new Set<string>();
  const directories = new Set<string>();
  let payloadBytes = 0;
  let bytes = TAR_BLOCK_BYTES * 2;
  for (const [index, file] of files.entries()) {
    const path = `files[${index}]`;
    const size = file.contents.byteLength;
    payloadBytes += size;
    bytes += tarEntryBytes(size);
    if (size > SHARED_GUEST_LIMITS.fileBytes) {
      violations.push({
        code: 'file-bytes',
        message: `Appliance file ${file.path} is ${size} bytes; the guest per-file limit is ${SHARED_GUEST_LIMITS.fileBytes}`,
        path: `${path}.contents`,
      });
    }
    if (!isNormalizedAbsolutePath(file.path) || !isWritableGuestPath(file.path)) {
      violations.push({
        code: 'file-path',
        message: `Appliance file path is not a normalized writable guest path: ${file.path}`,
        path: `${path}.path`,
      });
    } else if (isReservedGuestPath(file.path)) {
      violations.push({
        code: 'file-path-reserved',
        message: `Appliance file path is reserved by the runtime: ${file.path}`,
        path: `${path}.path`,
      });
    } else if (!fitsUstarPath(file.path.slice(1))) {
      violations.push({
        code: 'file-path-bytes',
        message: `Appliance file path does not fit in a POSIX ustar header: ${file.path}`,
        path: `${path}.path`,
      });
    }
    if (paths.has(file.path)) {
      violations.push({
        code: 'file-path-duplicate',
        message: `Duplicate appliance file: ${file.path}`,
        path: `${path}.path`,
      });
    }
    paths.add(file.path);
    const mode = file.mode ?? 0o644;
    if (!Number.isSafeInteger(mode) || mode < 0 || mode > 0o777) {
      violations.push({
        code: 'file-mode',
        message: `Appliance file ${file.path} has unsupported permission bits`,
        path: `${path}.mode`,
      });
    }
    const parts = file.path.slice(1).split('/');
    for (let part = 1; part < parts.length; part += 1) {
      directories.add(`${parts.slice(0, part).join('/')}/`);
    }
  }
  bytes += directories.size * TAR_BLOCK_BYTES;
  const entries = files.length + directories.size;
  if (payloadBytes > SHARED_GUEST_LIMITS.rootArchivePayloadBytes) {
    violations.push({
      code: 'archive-payload-bytes',
      message: `Node file payload is ${payloadBytes} bytes; the guest archive payload limit is ${SHARED_GUEST_LIMITS.rootArchivePayloadBytes}`,
      path: 'files',
    });
  }
  if (entries > SHARED_GUEST_LIMITS.rootArchiveEntries) {
    violations.push({
      code: 'archive-entries',
      message: `Node root archive requires ${entries} entries; the guest limit is ${SHARED_GUEST_LIMITS.rootArchiveEntries}`,
      path: 'files',
    });
  }
  if (bytes > SHARED_GUEST_LIMITS.rootArchiveBytes) {
    violations.push({
      code: 'archive-bytes',
      message: `Node root archive requires ${bytes} bytes; the guest limit is ${SHARED_GUEST_LIMITS.rootArchiveBytes}`,
      path: 'files',
    });
  }
  return { bytes, payloadBytes, entries };
}

function validateAddress(
  address: ApplianceInterfaceAddress,
  path: string,
  violations: SharedGuestContractViolation[],
): void {
  try {
    const parsed = parseIp(address.address);
    if (parsed.family !== address.family || parsed.canonical !== address.address) {
      throw new Error('family or canonical representation does not match');
    }
    const maximum = address.family === 'ipv4' ? 32 : 128;
    if (!Number.isSafeInteger(address.prefixLength) || address.prefixLength < 0 || address.prefixLength > maximum) {
      throw new Error('prefix length is out of range');
    }
  } catch {
    violations.push({
      code: 'interface-address',
      message: `Interface address ${address.address}/${address.prefixLength} is not canonical or valid`,
      path,
    });
  }
}

function serializedNodeConfigBytes(
  request: ApplianceBootRequest,
  context?: SharedGuestNodeConfigContext,
): number {
  const slot = context?.slot ?? SHARED_GUEST_LIMITS.nodes;
  const kind = context?.kind ?? 'client';
  let bytes = encoder.encode('ANYCASTLAB_NODE/1\n').byteLength;
  bytes += asciiBytes('node ') + String(slot).length + 1 + asciiBytes(kind) + 1;
  bytes += encodedTextTokenBytes(request.nodeId) + 1 + encodedTextTokenBytes(request.hostname) + 1;
  bytes += asciiBytes('entrypoint ') + encodedTextTokenBytes(request.entrypoint) + 1;
  for (const argument of request.argv) {
    bytes += asciiBytes('arg ') + encodedTextTokenBytes(argument) + 1;
  }
  for (const [name, value] of Object.entries(request.environment)) {
    bytes += asciiBytes('env ') + utf8Bytes(name) + 1 + encodedTextTokenBytes(value) + 1;
  }
  for (const [index, networkInterface] of request.interfaces.entries()) {
    const vlan = context?.vlanIds[index] ?? 4_094;
    bytes += asciiBytes('interface ') + String(vlan).length + 1;
    bytes += encodedTextTokenBytes(networkInterface.id) + 1;
    bytes += encodedTextTokenBytes(networkInterface.name) + 1;
    bytes += asciiBytes(networkInterface.mac.toLowerCase()) + 1;
    bytes += String(networkInterface.mtu).length + 1;
    bytes += asciiBytes(networkInterface.up ? 'up' : 'down') + 1;
    for (const address of networkInterface.addresses) {
      bytes += asciiBytes('address ') + encodedTextTokenBytes(networkInterface.id) + 1;
      bytes += utf8Bytes(address.address) + 1 + String(address.prefixLength).length + 1;
    }
  }
  return bytes;
}

function isLinuxHostname(value: string): boolean {
  return (
    value.length > 0 &&
    !value.startsWith('-') &&
    !value.endsWith('-') &&
    /^[A-Za-z0-9.-]+$/.test(value)
  );
}

function isLinuxInterfaceName(value: string): boolean {
  return (
    value !== 'lo' &&
    value !== 'labtrunk0' &&
    value !== '.' &&
    value !== '..' &&
    /^[A-Za-z0-9_.-]{1,15}$/.test(value)
  );
}

function isCanonicalUnicastMac(value: string): boolean {
  if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(value)) return false;
  return (Number.parseInt(value.slice(0, 2), 16) & 1) === 0;
}

function isNormalizedAbsolutePath(path: string): boolean {
  return (
    path.startsWith('/') &&
    path !== '/' &&
    !path.endsWith('/') &&
    !path.includes('\0') &&
    !path.includes('//') &&
    utf8Bytes(path) < 4_096 &&
    !path.split('/').some((part) => part === '.' || part === '..')
  );
}

function isWritableGuestPath(path: string): boolean {
  return ['/etc', '/home', '/root', '/run', '/tmp', '/var'].some(
    (root) => path === root || path.startsWith(`${root}/`),
  );
}

function isReservedGuestPath(path: string): boolean {
  return RESERVED_GUEST_PATHS.some(
    (reserved) => path === reserved || path.startsWith(`${reserved}/`),
  );
}

function fitsUstarPath(path: string): boolean {
  if (utf8Bytes(path) <= 100) return true;
  for (let slash = path.lastIndexOf('/'); slash > 0; slash = path.lastIndexOf('/', slash - 1)) {
    if (utf8Bytes(path.slice(0, slash)) <= 155 && utf8Bytes(path.slice(slash + 1)) <= 100) {
      return true;
    }
  }
  return false;
}

function tarEntryBytes(payloadBytes: number): number {
  return TAR_BLOCK_BYTES + Math.ceil(payloadBytes / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
}

function encodedTextTokenBytes(value: string): number {
  const bytes = utf8Bytes(value);
  return bytes === 0 ? 1 : 4 * Math.ceil(bytes / 3);
}

function utf8Bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

function asciiBytes(value: string): number {
  return value.length;
}
