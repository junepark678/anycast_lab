import type {
  ApplianceBootRequest,
  ApplianceFile,
  ApplianceInterfaceAddress,
  ApplianceInterfaceSpec,
  ApplianceKind as RuntimeApplianceKind,
} from '../appliances/abi';
import type { ApplianceRuntimeRegistry } from '../appliances/registry';
import { parseIp, parsePrefix } from '../core/ip';
import type { LabFile, LabNode, LabProject } from '../core/types';
import type {
  NativeProjectDiagnostic,
  NativeProjectEligibility,
} from './types';

const encoder = new TextEncoder();

export const BIRD_NATIVE_EXECUTABLE = '/usr/sbin/bird';
export const FRR_NATIVE_WRAPPER = '/run/anycastlab/frr-entrypoint.sh';
export const FRR_DAEMONS_FILE = '/etc/frr/daemons';
export const FRR_CONFIG_FILE = '/etc/frr/frr.conf';
export const CLIENT_NATIVE_EXECUTABLE = '/bin/sh';

/**
 * FRR's normal init wrapper reads this file. It is injected only when a
 * project did not provide `/etc/frr/daemons` itself; `frr.conf` is never
 * rewritten or interpreted by the engine.
 */
export const DEFAULT_FRR_DAEMONS = `bgpd=yes
ospfd=no
ospf6d=no
bfdd=no
isisd=no
ripd=no
ripngd=no
babeld=no
pimd=no
vtysh_enable=yes
zebra_options="-A 127.0.0.1"
bgpd_options="-A 127.0.0.1"
ospfd_options="-A 127.0.0.1"
ospf6d_options="-A ::1"
staticd_options="-A 127.0.0.1"
bfdd_options="-A 127.0.0.1"
isisd_options="-A 127.0.0.1"
ripd_options="-A 127.0.0.1"
ripngd_options="-A ::1"
babeld_options="-A 127.0.0.1"
pimd_options="-A 127.0.0.1"
`;

export const FRR_WRAPPER_SOURCE = `#!/bin/sh
set -eu
install -d -m 0755 /run/frr /var/log/frr
chown -R frr:frr /etc/frr
if [ -e /etc/frr/vtysh.conf ]; then chown frr:frrvty /etc/frr/vtysh.conf; fi
rm -f /run/anycastlab/frr.ready
/usr/libexec/anycastlab-frr start
cleanup() {
  rm -f /run/anycastlab/frr.ready
  /usr/libexec/anycastlab-frr stop >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
ready=0
attempt=0
while [ "$attempt" -lt 120 ]; do
  if /usr/sbin/frrinit.sh status >/dev/null 2>&1; then ready=1; break; fi
  attempt=$((attempt + 1))
  sleep 0.25
done
[ "$ready" -eq 1 ] || { echo 'FRR did not become ready' >&2; exit 1; }
touch /run/anycastlab/frr.ready
failures=0
while sleep 2; do
  if /usr/sbin/frrinit.sh status >/dev/null 2>&1; then
    failures=0
  else
    failures=$((failures + 1))
    [ "$failures" -lt 3 ] || exit 1
  fi
done
`;

export function runtimeKindForNode(node: LabNode): RuntimeApplianceKind | null {
  if (node.kind === 'switch') return null;
  if (node.kind === 'client' || node.kind === 'service') return 'client';
  if (node.appliance.kind === 'bird' || node.appliance.kind === 'frr') {
    return node.appliance.kind;
  }
  return null;
}

export function analyzeNativeProject(
  project: LabProject,
  registry?: ApplianceRuntimeRegistry,
): NativeProjectEligibility {
  const diagnostics: NativeProjectDiagnostic[] = [];
  const runtimes: Record<string, ReturnType<ApplianceRuntimeRegistry['resolve']>['descriptor']> = {};
  const nodes = new Map(project.nodes.map((node) => [node.id, node]));
  const interfaces = new Set<string>();
  const macOwners = new Map<string, string>();

  for (const [index, node] of project.nodes.entries()) {
    const path = `nodes[${index}]`;
    const runtimeKind = runtimeKindForNode(node);
    if (node.kind !== 'switch' && runtimeKind === null) {
      diagnostics.push({
        severity: 'error',
        code: 'native.appliance-kind',
        message: `Node ${node.name} cannot be mapped to a native BIRD, FRR, or client appliance.`,
        nodeId: node.id,
        path: `${path}.appliance.kind`,
      });
      continue;
    }

    if (node.kind !== 'switch' && node.appliance.runtime !== 'wasm') {
      diagnostics.push({
        severity: 'error',
        code: 'native.runtime-not-selected',
        message:
          `Node ${node.name} is configured for the compatibility runtime. ` +
          'Select the native runtime before starting the native lab.',
        nodeId: node.id,
        path: `${path}.appliance.runtime`,
      });
    }

    if (node.kind === 'switch' && node.appliance.kind !== 'switch') {
      diagnostics.push({
        severity: 'error',
        code: 'native.switch-appliance',
        message: `Switch ${node.name} must use the switch appliance.`,
        nodeId: node.id,
        path: `${path}.appliance.kind`,
      });
    }

    const interfaceNames = new Set<string>();
    for (const [interfaceIndex, networkInterface] of node.interfaces.entries()) {
      interfaces.add(endpointKey(node.id, networkInterface.id));
      if (interfaceNames.has(networkInterface.name)) {
        diagnostics.push({
          severity: 'error',
          code: 'native.interface-name-duplicate',
          message: `Node ${node.name} has more than one interface named ${networkInterface.name}.`,
          nodeId: node.id,
          path: `${path}.interfaces[${interfaceIndex}].name`,
        });
      }
      interfaceNames.add(networkInterface.name);
      if (!/^[a-zA-Z0-9_.-]{1,15}$/.test(networkInterface.name)) {
        diagnostics.push({
          severity: 'error',
          code: 'native.interface-name',
          message: `Interface name ${networkInterface.name} is not a valid Linux interface name.`,
          nodeId: node.id,
          path: `${path}.interfaces[${interfaceIndex}].name`,
        });
      }
      if (networkInterface.mac !== undefined) {
        try {
          const mac = normalizeMac(networkInterface.mac);
          const owner = macOwners.get(mac);
          if (owner !== undefined) {
            diagnostics.push({
              severity: 'error',
              code: 'native.mac-duplicate',
              message: `MAC address ${mac} is already assigned to ${owner}.`,
              nodeId: node.id,
              path: `${path}.interfaces[${interfaceIndex}].mac`,
            });
          } else {
            macOwners.set(mac, `${node.id}:${networkInterface.id}`);
          }
        } catch (error) {
          diagnostics.push({
            severity: 'error',
            code: 'native.mac-invalid',
            message: error instanceof Error ? error.message : String(error),
            nodeId: node.id,
            path: `${path}.interfaces[${interfaceIndex}].mac`,
          });
        }
      }
      for (const [addressIndex, address] of networkInterface.addresses.entries()) {
        try {
          parsePrefix(address);
        } catch (error) {
          diagnostics.push({
            severity: 'error',
            code: 'native.interface-address',
            message: error instanceof Error ? error.message : String(error),
            nodeId: node.id,
            path: `${path}.interfaces[${interfaceIndex}].addresses[${addressIndex}]`,
          });
        }
      }
    }

    if (runtimeKind === 'bird' && selectConfig(node, ['/etc/bird/bird.conf', '/etc/bird.conf']) === null) {
      diagnostics.push({
        severity: 'error',
        code: 'native.bird-config-missing',
        message: `BIRD node ${node.name} has no native configuration entrypoint.`,
        nodeId: node.id,
        path: `${path}.files`,
      });
    }
    if (runtimeKind === 'frr') {
      const config = selectConfig(node, [FRR_CONFIG_FILE]);
      if (config === null) {
        diagnostics.push({
          severity: 'error',
          code: 'native.frr-config-missing',
          message: `FRR node ${node.name} has no native configuration entrypoint.`,
          nodeId: node.id,
          path: `${path}.files`,
        });
      } else if (config.path !== FRR_CONFIG_FILE) {
        diagnostics.push({
          severity: 'error',
          code: 'native.frr-entrypoint-path',
          message: `Native FRR uses its integrated configuration and requires the selected entrypoint at ${FRR_CONFIG_FILE}; received ${config.path}.`,
          nodeId: node.id,
          path: `${path}.appliance.entrypoint`,
        });
      }
    }
    if (runtimeKind === 'frr' && !node.files.some((file) => file.path === FRR_DAEMONS_FILE)) {
      diagnostics.push({
        severity: 'info',
        code: 'native.frr-daemons-generated',
        message: `${FRR_DAEMONS_FILE} is absent; the lab will inject its native appliance daemon set without changing frr.conf.`,
        nodeId: node.id,
        path: `${path}.files`,
      });
    }
    if (runtimeKind === 'frr' && node.files.some((file) => file.path === FRR_NATIVE_WRAPPER)) {
      diagnostics.push({
        severity: 'error',
        code: 'native.frr-wrapper-reserved',
        message: `${FRR_NATIVE_WRAPPER} is reserved for the native FRR appliance wrapper.`,
        nodeId: node.id,
        path: `${path}.files`,
      });
    }
    if (node.kind === 'service' && node.interfaces.length === 0 && (node.service?.addresses.length ?? 0) > 0) {
      diagnostics.push({
        severity: 'error',
        code: 'native.service-interface-missing',
        message: `Service ${node.name} needs an interface for its service addresses.`,
        nodeId: node.id,
        path: `${path}.interfaces`,
      });
    }

    if (runtimeKind !== null && registry !== undefined) {
      try {
        const factory = registry.resolve({
          kind: runtimeKind,
          ...(
            runtimeKind === 'client' || node.appliance.version === undefined
              ? {}
              : { upstreamVersion: node.appliance.version }
          ),
        });
        if (factory.descriptor.fidelity !== 'native') {
          throw new Error(`Resolved runtime ${factory.descriptor.runtimeId} is not native`);
        }
        if (!factory.descriptor.capabilities.ethernet || !factory.descriptor.capabilities.nativeConfig) {
          throw new Error(`Runtime ${factory.descriptor.runtimeId} lacks native Ethernet/config support`);
        }
        runtimes[node.id] = factory.descriptor;
      } catch (error) {
        diagnostics.push({
          severity: 'error',
          code: `native.${runtimeKind}-runtime-unavailable`,
          message: error instanceof Error ? error.message : String(error),
          nodeId: node.id,
          path: `${path}.appliance`,
        });
      }
    }
  }

  const usedEndpoints = new Set<string>();
  for (const [index, link] of project.links.entries()) {
    for (const [endpointIndex, endpoint] of link.endpoints.entries()) {
      const key = endpointKey(endpoint.nodeId, endpoint.interfaceId);
      if (!nodes.has(endpoint.nodeId) || !interfaces.has(key)) {
        diagnostics.push({
          severity: 'error',
          code: 'native.link-endpoint-missing',
          message: `Link ${link.id} references missing endpoint ${endpoint.nodeId}:${endpoint.interfaceId}.`,
          linkId: link.id,
          path: `links[${index}].endpoints[${endpointIndex}]`,
        });
      }
      if (usedEndpoints.has(key)) {
        diagnostics.push({
          severity: 'error',
          code: 'native.link-endpoint-reused',
          message: `Endpoint ${endpoint.nodeId}:${endpoint.interfaceId} is attached to more than one link.`,
          linkId: link.id,
          path: `links[${index}].endpoints[${endpointIndex}]`,
        });
      }
      usedEndpoints.add(key);
    }
  }

  return {
    eligible: !diagnostics.some((diagnostic) => diagnostic.severity === 'error'),
    diagnostics,
    runtimes,
  };
}

export function buildNativeBootRequest(project: LabProject, node: LabNode): ApplianceBootRequest {
  const runtimeKind = runtimeKindForNode(node);
  if (runtimeKind === null) throw new Error(`Node ${node.id} is fabric-only and has no appliance boot request`);

  const files = node.files.map(toApplianceFile);
  const interfaces = buildInterfaces(project, node);
  const common = {
    nodeId: node.id,
    hostname: linuxHostname(node),
    environment: {
      ANYCAST_LAB_NODE_ID: node.id,
      ANYCAST_LAB_PROJECT_ID: project.id,
    },
    randomSeed: `${project.seed}:${node.id}`,
    interfaces,
  } as const;

  if (runtimeKind === 'bird') {
    const config = requireConfig(node, ['/etc/bird/bird.conf', '/etc/bird.conf'], 'BIRD');
    return {
      ...common,
      entrypoint: BIRD_NATIVE_EXECUTABLE,
      argv: ['-f', '-c', config.path],
      files,
    };
  }

  if (runtimeKind === 'frr') {
    const config = requireConfig(node, [FRR_CONFIG_FILE], 'FRR');
    if (config.path !== FRR_CONFIG_FILE) {
      throw new Error(`Native FRR requires its selected entrypoint at ${FRR_CONFIG_FILE}; received ${config.path}`);
    }
    if (files.some((file) => file.path === FRR_NATIVE_WRAPPER)) {
      throw new Error(`${FRR_NATIVE_WRAPPER} is reserved for the native FRR appliance wrapper`);
    }
    const runtimeFiles = [...files];
    if (!runtimeFiles.some((file) => file.path === FRR_DAEMONS_FILE)) {
      runtimeFiles.push({ path: FRR_DAEMONS_FILE, contents: encoder.encode(DEFAULT_FRR_DAEMONS), mode: 0o640 });
    }
    runtimeFiles.push({ path: FRR_NATIVE_WRAPPER, contents: encoder.encode(FRR_WRAPPER_SOURCE), mode: 0o755 });
    return {
      ...common,
      entrypoint: FRR_NATIVE_WRAPPER,
      argv: [],
      files: runtimeFiles,
    };
  }

  return {
    ...common,
    entrypoint: CLIENT_NATIVE_EXECUTABLE,
    argv: ['-c', clientStartupScript(node, interfaces)],
    files,
  };
}

function buildInterfaces(project: LabProject, node: LabNode): ApplianceInterfaceSpec[] {
  const macs = allocateMacAddresses(project);
  return node.interfaces.map((networkInterface, index) => {
    const addresses = networkInterface.addresses.map(toInterfaceAddress);
    if (node.kind === 'service' && index === 0) {
      for (const serviceAddress of node.service?.addresses ?? []) {
        const parsed = toInterfaceAddress(serviceAddress);
        if (!addresses.some((address) => address.family === parsed.family && address.address === parsed.address && address.prefixLength === parsed.prefixLength)) {
          addresses.push(parsed);
        }
      }
    }
    return {
      id: networkInterface.id,
      name: networkInterface.name,
      mac: normalizeMac(networkInterface.mac ?? macs.get(endpointKey(node.id, networkInterface.id))!),
      mtu: networkInterface.mtu ?? 1500,
      up: node.state === 'up' && networkInterface.state === 'up',
      addresses,
    };
  });
}

function toInterfaceAddress(value: string): ApplianceInterfaceAddress {
  const prefix = parsePrefix(value);
  return {
    family: prefix.family,
    address: prefix.canonical,
    prefixLength: prefix.prefixLength,
  };
}

function toApplianceFile(file: LabFile): ApplianceFile {
  return {
    path: file.path,
    contents: encoder.encode(file.content),
    mode: file.path.startsWith('/etc/frr/') ? 0o640 : 0o644,
  };
}

function selectConfig(node: LabNode, fallbacks: readonly string[]): LabFile | null {
  const requested = node.appliance.entrypoint;
  if (requested !== undefined) {
    return node.files.find((file) => file.path === requested) ?? null;
  }
  return node.files.find((file) => file.entrypoint) ??
    fallbacks.map((path) => node.files.find((file) => file.path === path)).find((file) => file !== undefined) ??
    null;
}

function requireConfig(node: LabNode, fallbacks: readonly string[], daemon: string): LabFile {
  const file = selectConfig(node, fallbacks);
  if (file === null) throw new Error(`${daemon} node ${node.id} has no native configuration entrypoint`);
  return file;
}

function clientStartupScript(
  node: LabNode,
  interfaces: readonly ApplianceInterfaceSpec[],
): string {
  const commands = ['set -eu'];
  const configured = new Set<string>();
  for (const [index, networkInterface] of node.interfaces.entries()) {
    const gateway = networkInterface.gateway ?? (index === 0 ? node.client?.defaultGateway : undefined);
    if (gateway === undefined) continue;
    const family = parseIp(gateway).family;
    const key = `${family}:${gateway}`;
    if (configured.has(key)) continue;
    configured.add(key);
    const guestInterface = interfaces[index];
    if (guestInterface === undefined) continue;
    commands.push(
      family === 'ipv4'
        ? `ip route replace default via ${shellQuote(gateway)} dev ${shellQuote(guestInterface.name)}`
        : `ip -6 route replace default via ${shellQuote(gateway)} dev ${shellQuote(guestInterface.name)}`,
    );
  }
  commands.push('while :; do sleep 3600; done');
  return commands.join('\n');
}

function allocateMacAddresses(project: LabProject): Map<string, string> {
  const output = new Map<string, string>();
  const used = new Set<string>();
  for (const node of project.nodes) {
    for (const networkInterface of node.interfaces) {
      const key = endpointKey(node.id, networkInterface.id);
      if (networkInterface.mac !== undefined) {
        const value = normalizeMac(networkInterface.mac);
        if (used.has(value)) throw new Error(`Duplicate MAC address in native project: ${value}`);
        used.add(value);
        output.set(key, value);
        continue;
      }
      let salt = 0;
      let value: string;
      do {
        value = generatedMac(`${project.seed}:${key}:${salt++}`);
      } while (used.has(value));
      used.add(value);
      output.set(key, value);
    }
  }
  return output;
}

function generatedMac(input: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of encoder.encode(input)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  const bytes = [0x02];
  for (let shift = 32n; shift >= 0n; shift -= 8n) bytes.push(Number((hash >> shift) & 0xffn));
  return bytes.map((byte) => byte.toString(16).padStart(2, '0')).join(':');
}

function normalizeMac(value: string): string {
  const normalized = value.toLowerCase();
  if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(normalized)) {
    throw new Error(`Invalid MAC address: ${value}`);
  }
  return normalized;
}

function linuxHostname(node: LabNode): string {
  const value = node.name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  return value || node.id.replace(/[^a-zA-Z0-9-]+/g, '-').slice(0, 63) || 'anycast-node';
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function endpointKey(nodeId: string, interfaceId: string): string {
  return `${nodeId}\u0000${interfaceId}`;
}
