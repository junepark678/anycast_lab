import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  APPLIANCE_HOST_ABI_VERSION,
  APPLIANCE_RUNTIME_API_VERSION,
  type ApplianceKind,
  type ApplianceRuntime,
  type ApplianceRuntimeDescriptor,
} from '../appliances/abi';
import { ApplianceRuntimeRegistry } from '../appliances/registry';
import {
  SHARED_GUEST_CAPACITY_GUIDANCE,
  SHARED_GUEST_LIMITS,
} from '../appliances/v86/shared-guest-contract';
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
    expect(FRR_WRAPPER_SOURCE).toContain('if [ -e /etc/anycastlab/pgo-generate ]; then');
    expect(FRR_WRAPPER_SOURCE).toContain('/usr/libexec/anycastlab-frr stop >/dev/null 2>&1 || true');
    expect(FRR_WRAPPER_SOURCE).toContain('while kill -0 "$stop_pid" 2>/dev/null && [ "$attempt" -lt 5 ]');
    expect(FRR_WRAPPER_SOURCE).toContain('[ "$start_elapsed" -lt 75 ]');
    expect(FRR_WRAPPER_SOURCE).toContain('readiness_attempts=$((90 - start_elapsed))');
    expect(FRR_WRAPPER_SOURCE).toContain('sleep 1');
    expect(FRR_WRAPPER_SOURCE).toContain("trap 'exit 0' INT TERM");
    expect(FRR_WRAPPER_SOURCE).toContain('/run/frr/watchfrr.pid');
    expect(FRR_WRAPPER_SOURCE).toContain('kill -0 "$watchfrr_pid"');
    expect(FRR_WRAPPER_SOURCE).not.toContain("exec /usr/bin/vtysh -c 'show version'");
    expect(FRR_WRAPPER_SOURCE).not.toContain('exec /usr/sbin/frrinit.sh status');
    expect(FRR_WRAPPER_SOURCE).toContain('rm -f /run/anycastlab/frr.ready "$failure_file" "$status_file"');
    expect(FRR_WRAPPER_SOURCE).toContain('mkfifo -m 0600 "$START_OUTPUT_PIPE"');
    expect(FRR_WRAPPER_SOURCE).toContain('{ head -c 4096; cat >/dev/null; }');
    expect(FRR_WRAPPER_SOURCE).not.toContain('ulimit -f');
    expect(FRR_WRAPPER_SOURCE).toContain('rm -f "$START_OUTPUT_PIPE"');
    expect(FRR_WRAPPER_SOURCE).toContain('setsid /bin/sh -c');
    expect(FRR_WRAPPER_SOURCE).toContain('FRR start timed out; failed:');
    expect(FRR_WRAPPER_SOURCE).toContain('signal_job TERM "$pid"');
    expect(FRR_WRAPPER_SOURCE).toContain('signal_job KILL "$pid"');
    expect(FRR_WRAPPER_SOURCE).toContain("head -c 128");
    expect(FRR_WRAPPER_SOURCE).toContain('FRR readiness timed out; failed: ${failed:-unknown');
    expect(FRR_WRAPPER_SOURCE).toContain('FRR health check failed; failed:');
    expect(FRR_WRAPPER_SOURCE).toContain('failures=3');
    expect(FRR_WRAPPER_SOURCE).toContain('rm -f "$failure_file"');
    expect(FRR_WRAPPER_SOURCE).not.toContain('record_failure "FRR health check failed; failed: \\${failed:-unknown (status $last_status)}"\n      exit 1');
    expect(FRR_WRAPPER_SOURCE).toContain('touch /run/anycastlab/frr.ready');
    expect(FRR_WRAPPER_SOURCE).toContain('[ "$failures" -lt 3 ] || {');
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

  it('keeps the generated FRR wrapper shell-valid and extracts a bounded failed-daemon list', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'anycast-frr-wrapper-'));
    try {
      const wrapper = resolve(directory, 'wrapper.sh');
      const status = resolve(directory, 'status.txt');
      writeFileSync(wrapper, FRR_WRAPPER_SOURCE);
      writeFileSync(status, [
        'Status of watchfrr: FAILED',
        'Status of zebra: running',
        'Status of bgpd: FAILED',
        'Status of ospf6d: FAILED',
        '',
      ].join('\n'));
      execFileSync('sh', ['-n', wrapper]);

      const functionBody = FRR_WRAPPER_SOURCE.match(/failed_daemons\(\) \{\n([\s\S]*?)\n\}/)?.[1];
      expect(functionBody).toBeDefined();
      const extracted = execFileSync('sh', [
        '-c',
        `status_file=$1\nfailed_daemons() {\n${functionBody}\n}\nfailed_daemons "$status_file"`,
        'sh',
        status,
      ], { encoding: 'utf8' });

      expect(extracted).toBe('watchfrr,bgpd,ospf6d');
      expect(new TextEncoder().encode(extracted).byteLength).toBeLessThanOrEqual(128);

      writeFileSync(status, 'watchfrr cannot connect\n  control socket is absent\r\n');
      const fallback = execFileSync('sh', [
        '-c',
        `status_file=$1\nfailed_daemons() {\n${functionBody}\n}\nfailed_daemons "$status_file"`,
        'sh',
        status,
      ], { encoding: 'utf8' });
      expect(fallback).toBe('watchfrr cannot connect control socket is absent');
      expect(new TextEncoder().encode(fallback).byteLength).toBeLessThanOrEqual(128);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('waits for upstream FRR shutdown in PGO mode so the namespace supervisor owns the deadline', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'anycast-frr-stop-wait-'));
    try {
      const helper = resolve(directory, 'frr-helper.sh');
      const marker = resolve(directory, 'pgo-generate');
      const completed = resolve(directory, 'completed');
      const runner = resolve(directory, 'stop-daemons.sh');
      writeFileSync(helper, `#!/bin/sh
sleep 0.05
: > ${shellPath(completed)}
exit 7
`, { mode: 0o755 });

      const stopBody = FRR_WRAPPER_SOURCE.match(/stop_daemons\(\) \{\n([\s\S]*?)\n\}/)?.[1];
      expect(stopBody).toBeDefined();
      expect(stopBody).toMatch(/if \[ -e \/etc\/anycastlab\/pgo-generate \]; then\n\s+\/usr\/libexec\/anycastlab-frr stop >\/dev\/null 2>&1 \|\| true\n\s+return/);
      expect(stopBody).toMatch(/\/usr\/libexec\/anycastlab-frr stop >\/dev\/null 2>&1 &/);
      const source = `#!/bin/sh
set -eu
stop_daemons() {
${stopBody}
}
stop_daemons
`
        .replaceAll('/etc/anycastlab/pgo-generate', marker)
        .replaceAll('/usr/libexec/anycastlab-frr', helper);
      writeFileSync(runner, source, { mode: 0o755 });
      writeFileSync(marker, 'llvm-ir-pgo-generate-v1\n');

      const result = spawnSync('sh', [runner], { encoding: 'utf8', timeout: 2_000 });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(readFileSync(completed, 'utf8')).toBe('');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('times out, kills, and reaps a blocked FRR start before bounded cleanup', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'anycast-frr-start-timeout-'));
    try {
      const helper = resolve(directory, 'frr-helper.sh');
      const statusHelper = resolve(directory, 'frr-status.sh');
      const wrapper = resolve(directory, 'wrapper.sh');
      const failure = resolve(directory, 'entrypoint.failure');
      const ready = resolve(directory, 'frr.ready');
      const status = resolve(directory, 'frr-status.out');
      const startOutput = resolve(directory, 'frr-start.out');
      const startPipe = resolve(directory, 'frr-start.pipe');
      const startDone = resolve(directory, 'frr-start.done');
      const startSession = resolve(directory, 'frr-start.session');
      const startPid = resolve(directory, 'start.pid');
      const stopped = resolve(directory, 'stopped');
      writeFileSync(helper, `#!/bin/sh
case "$1" in
  start) printf '%s\\n' "$$" > ${shellPath(startPid)}; trap '' TERM; while :; do sleep 30; done ;;
  stop) : > ${shellPath(stopped)} ;;
esac
`, { mode: 0o755 });
      writeFileSync(statusHelper, '#!/bin/sh\necho "Status of watchfrr: FAILED" >&2\nexit 1\n', { mode: 0o755 });

      const runtimeStart = FRR_WRAPPER_SOURCE.indexOf('failure_file=');
      expect(runtimeStart).toBeGreaterThan(0);
      const source = `#!/bin/sh\nset -eu\n${FRR_WRAPPER_SOURCE.slice(runtimeStart)}`
        .replaceAll('/run/anycastlab/entrypoint.failure', failure)
        .replaceAll('/run/anycastlab/frr.ready', ready)
        .replaceAll('/run/anycastlab/frr-status.out', status)
        .replaceAll('/run/anycastlab/frr-start.out', startOutput)
        .replaceAll('/run/anycastlab/frr-start.pipe', startPipe)
        .replaceAll('/run/anycastlab/frr-start.done', startDone)
        .replaceAll('/run/anycastlab/frr-start.pid', startSession)
        .replaceAll('/usr/libexec/anycastlab-frr', helper)
        .replaceAll('/usr/sbin/frrinit.sh', statusHelper)
        .replaceAll('[ "$start_elapsed" -lt 75 ]', '[ "$start_elapsed" -lt 1 ]')
        .replaceAll('[ "$start_elapsed" -ge 75 ]', '[ "$start_elapsed" -ge 1 ]')
        .replaceAll('[ "$attempt" -lt 5 ]', '[ "$attempt" -lt 1 ]')
        .replaceAll('sleep 1', 'sleep 0.05');
      writeFileSync(wrapper, source, { mode: 0o755 });

      const result = spawnSync('sh', [wrapper], { encoding: 'utf8', timeout: 5_000 });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(readFileSync(failure, 'utf8')).toBe('FRR start timed out; failed: unknown\n');
      expect(readFileSync(stopped, 'utf8')).toBe('');
      const pid = Number.parseInt(readFileSync(startPid, 'utf8'), 10);
      expect(processExists(pid)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('uses the live watchfrr supervisor as the FRR readiness boundary', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'anycast-frr-readiness-'));
    try {
      const pidFile = resolve(directory, 'watchfrr.pid');
      const statusFile = resolve(directory, 'status.out');
      writeFileSync(pidFile, `${process.pid}\n`);
      const match = FRR_WRAPPER_SOURCE.match(/probe_status\(\) \{\n([\s\S]*?)\n\}/);
      expect(match).not.toBeNull();
      const body = match![1]!
        .replaceAll('/run/frr/watchfrr.pid', pidFile);
      const script = `status_file=$1\nlast_status=0\nprobe_status() {\n${body}\n}\nprobe_status`;

      const ready = spawnSync('sh', ['-c', script, 'sh', statusFile], { encoding: 'utf8' });
      expect(ready.status).toBe(0);
      expect(() => readFileSync(statusFile, 'utf8')).toThrow();

      writeFileSync(pidFile, '999999999\n');
      const dead = spawnSync('sh', ['-c', script, 'sh', statusFile], { encoding: 'utf8' });
      expect(dead.status).toBe(1);
      expect(readFileSync(statusFile, 'utf8')).toBe('watchfrr process 999999999 is not running\n');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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

  it('rejects aggregate and per-node structures the shared guest cannot represent', () => {
    const tooManyNodes = projectWith(
      ...Array.from({ length: SHARED_GUEST_LIMITS.nodes + 1 }, (_, index) => clientNode(`client-${index}`)),
    );
    const tooManyInterfaces = clientNode('wide-client');
    tooManyInterfaces.interfaces = Array.from(
      { length: SHARED_GUEST_LIMITS.interfacesPerNode + 1 },
      (_, index) => ({ id: `if-${index}`, name: `eth${index}`, addresses: [], state: 'up' as const }),
    );
    const tooManyAddresses = clientNode('address-heavy');
    tooManyAddresses.interfaces[0]!.addresses = Array.from(
      { length: SHARED_GUEST_LIMITS.addressesPerNode + 1 },
      (_, index) => `${index < 256 ? `10.0.0.${index}` : `10.0.1.${index - 256}`}/24`,
    );

    expect(analyzeNativeProject(tooManyNodes).diagnostics).toContainEqual(expect.objectContaining({
      severity: 'error', code: 'native.guest-node-count', path: 'nodes',
    }));
    expect(analyzeNativeProject(projectWith(tooManyInterfaces)).diagnostics).toContainEqual(
      expect.objectContaining({ severity: 'error', code: 'native.guest-interface-count', nodeId: 'wide-client' }),
    );
    expect(analyzeNativeProject(projectWith(tooManyAddresses)).diagnostics).toContainEqual(
      expect.objectContaining({ severity: 'error', code: 'native.guest-address-count', nodeId: 'address-heavy' }),
    );
  });

  it('surfaces UTF-8 and nested-root-archive limits during project analysis', () => {
    const longId = clientNode('λ'.repeat(129));
    const archiveFull = clientNode('archive-full');
    archiveFull.files.push({
      path: '/etc/full',
      content: 'x'.repeat(SHARED_GUEST_LIMITS.fileBytes),
    });

    expect(analyzeNativeProject(projectWith(longId)).diagnostics).toContainEqual(expect.objectContaining({
      severity: 'error', code: 'native.guest-node-id-bytes', nodeId: longId.id,
    }));
    expect(analyzeNativeProject(projectWith(archiveFull)).diagnostics).toContainEqual(expect.objectContaining({
      severity: 'error', code: 'native.guest-archive-bytes', nodeId: 'archive-full',
    }));
  });

  it('warns rather than rejecting topologies likely to pressure the fixed shared VM', () => {
    const topology = projectWith(
      ...Array.from(
        { length: SHARED_GUEST_CAPACITY_GUIDANCE.recommendedNodes + 1 },
        (_, index) => clientNode(`client-${index}`),
      ),
    );

    const result = analyzeNativeProject(topology);

    expect(result.eligible).toBe(true);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'warning', code: 'native.guest-memory-pressure', path: 'nodes',
    }));
  });

  it('rejects an aggregate bootstrap the guest extractor cannot represent', () => {
    const payload = 'x'.repeat(6 * 1024 * 1024);
    const nodes = Array.from({ length: 3 }, (_, index) => {
      const node = clientNode(`large-${index}`);
      node.files.push({ path: '/etc/payload', content: payload });
      return node;
    });

    const result = analyzeNativeProject(projectWith(...nodes));

    expect(result.eligible).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'error', code: 'native.guest-bootstrap-bytes', path: 'nodes',
    }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'error', code: 'native.guest-bootstrap-payload-bytes', path: 'nodes',
    }));
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

function shellPath(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
