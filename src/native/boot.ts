import type {
  ApplianceBootRequest,
  ApplianceFile,
  ApplianceInterfaceAddress,
  ApplianceInterfaceSpec,
  ApplianceKind as RuntimeApplianceKind,
} from '../appliances/abi';
import type { ApplianceRuntimeRegistry } from '../appliances/registry';
import {
  SHARED_GUEST_CAPACITY_GUIDANCE,
  SHARED_GUEST_LIMITS,
  inspectSharedBootstrapArchive,
  inspectSharedGuestBootRequest,
  type SharedGuestBootMetrics,
  type SharedGuestNodeConfigContext,
} from '../appliances/v86/shared-guest-contract';
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
export const ENTRYPOINT_FAILURE_FILE = '/run/anycastlab/entrypoint.failure';

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
failure_file=${ENTRYPOINT_FAILURE_FILE}
status_file=/run/anycastlab/frr-status.out
start_output_file=/run/anycastlab/frr-start.out
start_output_pipe=/run/anycastlab/frr-start.pipe
start_done_file=/run/anycastlab/frr-start.done
start_done_tmp=/run/anycastlab/frr-start.done.tmp
start_session_file=/run/anycastlab/frr-start.pid
start_session_tmp=/run/anycastlab/frr-start.pid.tmp
start_pid=
start_launcher_pid=
umask 077
rm -f /run/anycastlab/frr.ready "$failure_file" "$status_file" \
  "$start_output_file" "$start_output_pipe" "$start_done_file" "$start_done_tmp" \
  "$start_session_file" "$start_session_tmp"
record_failure() {
  printf '%s\\n' "$1" > "$failure_file"
}
signal_job() {
  signal=$1
  pid=$2
  [ -n "$pid" ] || return 0
  kill "-$signal" "-$pid" 2>/dev/null \
    || kill "-$signal" "$pid" 2>/dev/null \
    || true
}
terminate_start_job() {
  pid=$start_pid
  if [ -n "$pid" ]; then
    signal_job TERM "$pid"
    attempt=0
    while kill -0 "$pid" 2>/dev/null && [ "$attempt" -lt 5 ]; do
      sleep 1
      attempt=$((attempt + 1))
    done
    # The session leader may exit on TERM while a descendant ignores it; always
    # target the original process group after the grace period.
    signal_job KILL "$pid"
  fi
  if [ -n "$start_launcher_pid" ]; then
    wait "$start_launcher_pid" 2>/dev/null || true
  fi
  if [ -n "$pid" ] && [ "$pid" != "$start_launcher_pid" ]; then
    wait "$pid" 2>/dev/null || true
  fi
  start_pid=
  start_launcher_pid=
}
stop_daemons() {
  if [ -e /etc/anycastlab/pgo-generate ]; then
    /usr/libexec/anycastlab-frr stop >/dev/null 2>&1 || true
    return
  fi
  # Keep spontaneous non-PGO health failures responsive. PGO collection uses
  # the synchronous branch above so only the namespace supervisor owns its
  # longer profile-flush deadline.
  /usr/libexec/anycastlab-frr stop >/dev/null 2>&1 &
  stop_pid=$!
  attempt=0
  while kill -0 "$stop_pid" 2>/dev/null && [ "$attempt" -lt 5 ]; do
    sleep 1
    attempt=$((attempt + 1))
  done
  if kill -0 "$stop_pid" 2>/dev/null; then signal_job KILL "$stop_pid"; fi
  wait "$stop_pid" 2>/dev/null || true
  stop_pid=
}
cleanup() {
  trap - EXIT INT TERM
  terminate_start_job
  rm -f /run/anycastlab/frr.ready "$status_file" \
    "$start_output_file" "$start_output_pipe" "$start_done_file" "$start_done_tmp" \
    "$start_session_file" "$start_session_tmp"
  stop_daemons
}
trap cleanup EXIT
trap 'exit 0' INT TERM
last_status=0
probe_status() {
  rm -f "$status_file"
  if [ ! -f /run/frr/watchfrr.pid ] || [ ! -r /run/frr/watchfrr.pid ]; then
    printf '%s\\n' 'watchfrr pid file is missing' > "$status_file"
    last_status=3
    return 1
  fi
  if IFS= read -r watchfrr_pid < /run/frr/watchfrr.pid; then :; else watchfrr_pid=; fi
  case "$watchfrr_pid" in
    ''|0|*[!0-9]*)
      printf '%s\\n' 'watchfrr pid file is invalid' > "$status_file"
      last_status=22
      return 1
      ;;
  esac
  if ! kill -0 "$watchfrr_pid" 2>/dev/null; then
    printf 'watchfrr process %s is not running\\n' "$watchfrr_pid" > "$status_file"
    last_status=3
    return 1
  fi
  last_status=0
  return 0
}
failed_daemons() {
  file=$1
  [ -f "$file" ] || return 0
  extracted=$(sed -n \
    -e 's/^Status of \\([^:][^:]*\\): FAILED$/\\1/p' \
    -e 's/^Failed to start \\([^!][^!]*\\)!$/\\1/p' \
    "$file" \
    | head -c 128 \
    | tr '\\n' ',' \
    | sed 's/,$//')
  if [ -n "$extracted" ]; then
    printf '%s' "$extracted"
  else
    head -c 128 "$file" \
      | tr '\\n\\r\\t' '   ' \
      | sed 's/[[:space:]][[:space:]]*/ /g; s/^ //; s/ $//'
  fi
}

: | START_OUTPUT_FILE="$start_output_file" START_OUTPUT_PIPE="$start_output_pipe" \
  START_DONE_FILE="$start_done_file" \
  START_DONE_TMP="$start_done_tmp" START_SESSION_FILE="$start_session_file" \
  START_SESSION_TMP="$start_session_tmp" \
  setsid /bin/sh -c '
    umask 077
    printf "%s\\n" "$$" > "$START_SESSION_TMP"
    mv -f "$START_SESSION_TMP" "$START_SESSION_FILE"
    status=0
    rm -f "$START_OUTPUT_PIPE"
    mkfifo -m 0600 "$START_OUTPUT_PIPE" || status=125
    if [ "$status" -eq 0 ]; then
      # The FRR daemons retain their inherited stderr after frrinit returns.
      # Drain it for their lifetime while retaining only the first 4 KiB. An
      # RLIMIT_FSIZE here would be inherited and kill FRR with SIGXFSZ.
      { head -c 4096; cat >/dev/null; } \
        < "$START_OUTPUT_PIPE" > "$START_OUTPUT_FILE" &
      /usr/libexec/anycastlab-frr start > "$START_OUTPUT_PIPE" 2>&1
      status=$?
      rm -f "$START_OUTPUT_PIPE"
    fi
    printf "%s\\n" "$status" > "$START_DONE_TMP"
    mv -f "$START_DONE_TMP" "$START_DONE_FILE"
    exit "$status"
  ' &
start_launcher_pid=$!
session_attempt=0
while [ ! -f "$start_session_file" ] && [ "$session_attempt" -lt 5 ]; do
  sleep 1
  session_attempt=$((session_attempt + 1))
done
if IFS= read -r session_pid < "$start_session_file"; then :; else session_pid=; fi
case "$session_pid" in
  ''|*[!0-9]*) start_pid=$start_launcher_pid ;;
  *) start_pid=$session_pid ;;
esac
start_elapsed=0
while [ ! -f "$start_done_file" ] && [ "$start_elapsed" -lt 75 ]; do
  if ! kill -0 "$start_pid" 2>/dev/null; then break; fi
  sleep 1
  start_elapsed=$((start_elapsed + 1))
done
if [ ! -f "$start_done_file" ]; then
  start_timed_out=0
  if [ "$start_elapsed" -ge 75 ]; then start_timed_out=1; fi
  terminate_start_job
  failed=$(failed_daemons "$start_output_file")
  if [ "$start_timed_out" -eq 1 ]; then
    record_failure "FRR start timed out; failed: \${failed:-unknown}"
  else
    record_failure "FRR start exited without status; failed: \${failed:-unknown}"
  fi
  exit 1
fi
if IFS= read -r start_status < "$start_done_file"; then :; else start_status=125; fi
case "$start_status" in ''|*[!0-9]*) start_status=125 ;; esac
if [ -n "$start_launcher_pid" ]; then
  wait "$start_launcher_pid" 2>/dev/null || true
fi
start_pid=
start_launcher_pid=
if [ "$start_status" -ne 0 ]; then
  failed=$(failed_daemons "$start_output_file")
  record_failure "FRR start failed; failed: \${failed:-unknown (status $start_status)}"
  exit 1
fi
ready=0
attempt=0
readiness_attempts=$((90 - start_elapsed))
if [ "$readiness_attempts" -lt 1 ]; then readiness_attempts=1; fi
while [ "$attempt" -lt "$readiness_attempts" ]; do
  if probe_status; then
    ready=1
    break
  fi
  attempt=$((attempt + 1))
  sleep 1
done
[ "$ready" -eq 1 ] || {
  failed=$(failed_daemons "$status_file")
  record_failure "FRR readiness timed out; failed: \${failed:-unknown (status $last_status)}"
  exit 1
}
touch /run/anycastlab/frr.ready
failures=0
while sleep 2; do
  if probe_status; then
    failures=0
    rm -f "$failure_file"
  else
    failures=$((failures + 1))
    [ "$failures" -lt 3 ] || {
      failed=$(failed_daemons "$status_file")
      record_failure "FRR health check failed; failed: \${failed:-unknown (status $last_status)}"
      # Keep the namespace and terminal alive after post-readiness daemon
      # failures. An interactive network appliance must remain diagnosable and
      # can be repaired in place; a later successful probe clears degradation.
      failures=3
    }
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
  const guestMetrics: SharedGuestBootMetrics[] = [];
  const guestNodes = project.nodes.filter((node) => node.kind !== 'switch');
  const guestContexts = new Map<LabNode, SharedGuestNodeConfigContext>();
  let nextGuestSlot = 1;
  let nextGuestVlan = 100;
  for (const node of guestNodes) {
    const kind = runtimeKindForNode(node) ?? 'client';
    const vlanIds = node.interfaces.map(() => nextGuestVlan++);
    guestContexts.set(node, { slot: nextGuestSlot++, kind, vlanIds });
  }

  if (guestNodes.length > SHARED_GUEST_LIMITS.nodes) {
    diagnostics.push({
      severity: 'error',
      code: 'native.guest-node-count',
      message: `The topology has ${guestNodes.length} guest nodes; the shared Linux supervisor supports at most ${SHARED_GUEST_LIMITS.nodes}.`,
      path: 'nodes',
    });
  } else if (guestNodes.length > SHARED_GUEST_CAPACITY_GUIDANCE.recommendedNodes) {
    diagnostics.push({
      severity: 'warning',
      code: 'native.guest-memory-pressure',
      message: `The topology has ${guestNodes.length} guest nodes sharing ${SHARED_GUEST_CAPACITY_GUIDANCE.memoryBytes / (1024 * 1024)} MiB; more than ${SHARED_GUEST_CAPACITY_GUIDANCE.recommendedNodes} nodes may run out of memory depending on enabled daemons and routes.`,
      path: 'nodes',
    });
  }

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

    if (runtimeKind !== null) {
      try {
        // Isolating the node prevents an unrelated malformed explicit MAC from
        // hiding this node's guest-limit diagnostics. Generated MACs remain
        // byte-identical because their seed includes the project and node ids.
        const request = buildNativeBootRequest({ ...project, nodes: [node] }, node);
        const inspection = inspectSharedGuestBootRequest(request, guestContexts.get(node));
        guestMetrics.push(inspection.metrics);
        for (const violation of inspection.violations) {
          diagnostics.push({
            severity: 'error',
            code: `native.guest-${violation.code}`,
            message: `${node.name}: ${violation.message}`,
            nodeId: node.id,
            path: violation.path.length === 0 ? path : `${path}.${violation.path}`,
          });
        }
      } catch (error) {
        const alreadyDiagnosed = diagnostics.some(
          (diagnostic) => diagnostic.severity === 'error' && diagnostic.nodeId === node.id,
        );
        if (!alreadyDiagnosed) {
          diagnostics.push({
            severity: 'error',
            code: 'native.guest-boot-request',
            message: error instanceof Error ? error.message : String(error),
            nodeId: node.id,
            path,
          });
        }
      }
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

  if (guestMetrics.length === guestNodes.length) {
    const bootstrap = inspectSharedBootstrapArchive(guestMetrics);
    if (bootstrap.payloadBytes > SHARED_GUEST_LIMITS.bootstrapArchivePayloadBytes) {
      diagnostics.push({
        severity: 'error',
        code: 'native.guest-bootstrap-payload-bytes',
        message: `The shared bootstrap payload is ${formatMiB(bootstrap.payloadBytes)} MiB; the guest limit is ${formatMiB(SHARED_GUEST_LIMITS.bootstrapArchivePayloadBytes)} MiB.`,
        path: 'nodes',
      });
    }
    if (bootstrap.entries > SHARED_GUEST_LIMITS.bootstrapArchiveEntries) {
      diagnostics.push({
        severity: 'error',
        code: 'native.guest-bootstrap-entries',
        message: `The shared bootstrap requires ${bootstrap.entries} entries; the guest limit is ${SHARED_GUEST_LIMITS.bootstrapArchiveEntries}.`,
        path: 'nodes',
      });
    }
    if (bootstrap.bytes > SHARED_GUEST_LIMITS.bootstrapArchiveBytes) {
      diagnostics.push({
        severity: 'error',
        code: 'native.guest-bootstrap-bytes',
        message: `The shared bootstrap requires ${formatMiB(bootstrap.bytes)} MiB; the guest limit is ${formatMiB(SHARED_GUEST_LIMITS.bootstrapArchiveBytes)} MiB.`,
        path: 'nodes',
      });
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

function formatMiB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '');
}
