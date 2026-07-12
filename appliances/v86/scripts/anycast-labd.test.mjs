import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { SHARED_GUEST_LIMITS } from '../../../src/appliances/v86/shared-guest-contract.ts';

const scripts = dirname(fileURLToPath(import.meta.url));
const appliance = resolve(scripts, '..');
const buildroot = resolve(appliance, 'buildroot');
const packageRoot = resolve(buildroot, 'package/anycast-labd');
const sourceRoot = resolve(packageRoot, 'src');
const labd = readFileSync(resolve(sourceRoot, 'labd.c'), 'utf8');
const config = readFileSync(resolve(sourceRoot, 'config.c'), 'utf8');
const archiveSource = readFileSync(resolve(sourceRoot, 'archive.c'), 'utf8');
const labdHeader = readFileSync(resolve(sourceRoot, 'anycast-labd.h'), 'utf8');
const init = resolve(buildroot, 'board/rootfs-overlay/etc/init.d/S20anycastlab');
const busyboxConfig = readFileSync(resolve(buildroot, 'board/busybox-shared.config'), 'utf8');
const nativeBootSource = readFileSync(resolve(appliance, '../../src/native/boot.ts'), 'utf8');
const legacyRuntimeSource = readFileSync(resolve(appliance, '../../src/appliances/v86/runtime.ts'), 'utf8');
const sharedBootstrap = readFileSync(resolve(appliance, '../../src/appliances/v86/shared-bootstrap.ts'), 'utf8');
const sharedGuestContract = readFileSync(resolve(appliance, '../../src/appliances/v86/shared-guest-contract.ts'), 'utf8');

test('anycast-labd parser/archive unit suite and complete supervisor compile warning-free', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'anycast-labd-test-'));
  try {
    const unit = resolve(directory, 'unit');
    const daemon = resolve(directory, 'anycast-labd');
    const common = ['-std=c11', '-Wall', '-Wextra', '-Werror', '-Wformat=2', '-Wshadow'];
    execFileSync('cc', [
      ...common,
      '-o', unit,
      resolve(sourceRoot, 'tests.c'),
      resolve(sourceRoot, 'config.c'),
      resolve(sourceRoot, 'archive.c'),
      resolve(sourceRoot, 'protocol.c'),
    ], { stdio: 'pipe' });
    assert.match(execFileSync(unit, { encoding: 'utf8' }), /unit tests passed/);
    execFileSync('cc', [
      ...common,
      '-fPIE', '-pie',
      '-o', daemon,
      resolve(sourceRoot, 'labd.c'),
      resolve(sourceRoot, 'config.c'),
      resolve(sourceRoot, 'archive.c'),
      resolve(sourceRoot, 'protocol.c'),
    ], { stdio: 'pipe' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('package, defconfig, and init select only the shared supervisor', () => {
  const externalConfig = readFileSync(resolve(buildroot, 'Config.in'), 'utf8');
  const defconfig = readFileSync(resolve(buildroot, 'configs/anycast_lab_v86_defconfig'), 'utf8');
  const packageMakefile = readFileSync(resolve(packageRoot, 'anycast-labd.mk'), 'utf8');
  const initSource = readFileSync(init, 'utf8');
  const postBuild = readFileSync(resolve(buildroot, 'board/post-build.sh'), 'utf8');

  assert.match(externalConfig, /package\/anycast-labd\/Config\.in/);
  assert.match(defconfig, /^BR2_PACKAGE_ANYCAST_LABD=y$/m);
  assert.match(packageMakefile, /\$\(TARGET_CC\)/);
  assert.match(packageMakefile, /\$\(TARGET_DIR\)\/usr\/sbin\/anycast-labd/);
  assert.doesNotMatch(packageMakefile, /tests\.c/);
  assert.match(initSource, /HOST_MOUNT=\/run\/anycast-host/);
  assert.match(initSource, /anycastlab-shared-bootstrap\.tar/);
  assert.match(initSource, /\/usr\/sbin\/anycast-labd/);
  assert.doesNotMatch(initSource, /tar -[tx]/);
  assert.match(postBuild, /usr\/sbin\/anycast-labd/);
  assert.match(postBuild, /rm -f[\s\S]*anycastlab-agent[\s\S]*anycastlab-shell/);
  execFileSync('sh', ['-n', init]);
});

test('guest scripts use integer sleeps supported by the compact BusyBox build', () => {
  const fractionalSleepEnabled =
    /^CONFIG_FEATURE_FANCY_SLEEP=y$/m.test(busyboxConfig) ||
    /^CONFIG_FEATURE_FLOAT_SLEEP=y$/m.test(busyboxConfig);
  assert.equal(fractionalSleepEnabled, false, 'fractional BusyBox sleep unexpectedly enabled');
  assert.match(busyboxConfig, /^# CONFIG_FEATURE_FANCY_SLEEP is not set$/m);

  const guestScripts = [
    ['native boot scripts', nativeBootSource],
    ['legacy v86 start script', legacyRuntimeSource],
    ['shared guest init', readFileSync(init, 'utf8')],
  ];
  for (const [label, source] of guestScripts) {
    assert.doesNotMatch(source, /\bsleep\s+\d+\.\d+\b/, `${label} requires fractional sleep`);
  }

  assert.match(nativeBootSource, /"\$start_elapsed" -lt 75/);
  assert.match(nativeBootSource, /readiness_attempts=\$\(\(90 - start_elapsed\)\)/);
  assert.match(legacyRuntimeSource, /GUEST_READINESS_ATTEMPTS = 120/);
  assert.match(readFileSync(init, 'utf8'), /while kill -0 .*\[ "\$attempt" -lt 5 \]/);
});

test('the compact BusyBox build can byte-bound FRR diagnostics', () => {
  assert.match(busyboxConfig, /^CONFIG_HEAD=y$/m);
  assert.match(busyboxConfig, /^CONFIG_FEATURE_FANCY_HEAD=y$/m);
  assert.match(nativeBootSource, /head -c 4096/);
  assert.match(nativeBootSource, /head -c 128/);
});

test('node isolation shares immutable pages while separating process-visible state', () => {
  for (const flag of [
    'CLONE_NEWNS',
    'CLONE_NEWPID',
    'CLONE_NEWNET',
    'CLONE_NEWUTS',
    'CLONE_NEWIPC',
    'CLONE_NEWCGROUP',
  ]) assert.match(labd, new RegExp(`\\b${flag}\\b`));
  assert.match(labd, /unshare\(CLONE_NEWTIME\)/);
  assert.match(labd, /unshare\(CLONE_NEWCGROUP\).*unshare\(CLONE_NEWTIME\)/s);
  assert.doesNotMatch(labd, /CLONE_NEWIPC \| CLONE_NEWCGROUP \| SIGCHLD/);
  assert.match(labd, /time_for_children/);
  assert.doesNotMatch(labd, /CLONE_NEWTIME\s*\|\s*SIGCHLD/);
  assert.match(labd, /lowerdir=%s,upperdir=%s,workdir=%s,index=off,xino=off,redirect_dir=off/);
  assert.doesNotMatch(labd, /redirect_dir=on|metacopy=on/);
  assert.match(labd, /mount\("overlay"/);
  assert.match(labd, /mount\("tmpfs", node->runtime_dir, "tmpfs", MS_NOSUID \| MS_NODEV/);
  assert.match(labd, /NODE_TMPFS_BYTES \(32U \* 1024U \* 1024U\)/);
  assert.match(labd, /NODE_PGO_TMPFS_BYTES \(96U \* 1024U \* 1024U\)/);
  assert.match(labd, /umount2\(node->runtime_dir, MNT_DETACH\)/);
  assert.match(labd, /mount\("proc"/);
  assert.match(labd, /mount\("sysfs"/);
  assert.match(labd, /newinstance,mode=0620,ptmxmode=0666/);
  assert.match(labd, /memory\.max/);
  assert.match(labd, /memory\.swap\.max/);
  assert.match(labd, /pids\.max/);
  assert.match(labd, /NODE_MEMORY_MAX \(96U \* 1024U \* 1024U\)/);
  assert.match(labd, /NODE_PGO_MEMORY_MAX \(192U \* 1024U \* 1024U\)/);
  assert.match(labd, /NODE_PIDS_MAX 256U/);
  assert.match(labd, /"mtu", "65535", "promisc", "on", "up"/);
  assert.match(labd, /\/proc\/sys\/net\/ipv4\/ip_forward", "1\\n"/);
  assert.match(labd, /\/proc\/sys\/net\/ipv6\/conf\/all\/forwarding", "1\\n"/);
});

test('node VLAN interfaces explicitly restore ARP before applying their requested link state', () => {
  const configureStart = labd.indexOf('static int configure_node_network(');
  const configureEnd = labd.indexOf('\nstatic ', configureStart + 1);
  assert.ok(configureStart >= 0 && configureEnd > configureStart);
  const configure = labd.slice(configureStart, configureEnd);
  const arpCommand = [...configure.matchAll(/const char \*(\w+)\[\]\s*=\s*\{([^}]*)\};/gs)]
    .find(([, , commandText]) => (
      /"link",\s*"set",\s*"dev",\s*interface->name/.test(commandText) &&
      /"arp",\s*"on"/.test(commandText)
    ));

  assert.ok(arpCommand, 'configure_node_network must construct an explicit `ip link ... arp on` command');
  const arpInvocation = configure.indexOf(`run_ip(${arpCommand[1]}`);
  const stateInvocation = configure.indexOf('run_ip(state');
  assert.ok(arpInvocation >= 0, 'the ARP-enabling command must be executed');
  assert.ok(stateInvocation > arpInvocation, 'ARP must be enabled before the requested up/down state is applied');
});

test('trunk discovery selects the lowest-index virtio_net interface instead of an arbitrary netdevice', () => {
  const driverStart = labd.indexOf('static bool interface_uses_driver(');
  const findStart = labd.indexOf('static int find_initial_interface(');
  const findEnd = labd.indexOf('\nstatic ', findStart + 1);
  assert.ok(driverStart >= 0 && findStart > driverStart && findEnd > findStart);

  const driverLookup = labd.slice(driverStart, findStart);
  assert.match(driverLookup, /"\/sys\/class\/net\/%s\/device\/driver"/);
  assert.match(driverLookup, /readlink\(path, target, sizeof\(target\) - 1U\)/);
  assert.match(driverLookup, /strrchr\(target, '\/'\)/);
  assert.match(driverLookup, /strcmp\(basename, driver\) == 0/);

  const find = labd.slice(findStart, findEnd);
  assert.match(find, /interface_uses_driver\(entry->d_name, "virtio_net"\)/);
  assert.match(find, /index = if_nametoindex\(entry->d_name\)/);
  assert.match(find, /selected_index != 0U && index >= selected_index/);
  assert.match(find, /selected_index = index/);
  assert.equal((find.match(/return 0;/g) ?? []).length, 1);
  const select = find.indexOf('memcpy(output, entry->d_name');
  const finishScan = find.indexOf('closedir(directory);');
  const accept = find.indexOf('if (selected_index != 0U)');
  const success = find.indexOf('return 0;', accept);
  assert.ok(select >= 0 && finishScan > select, 'discovery must scan every candidate before accepting one');
  assert.ok(accept > finishScan && success > accept, 'success must require a selected virtio_net ifindex');
});

test('wire grammar, readiness, terminals, and PGO remain bounded and kind-aware', () => {
  for (const command of [
    'NODE_START', 'NODE_STOP', 'NODE_DELETE', 'APPLY', 'READ', 'LINK',
    'TERM_OPEN', 'TERM_WRITE', 'TERM_RESIZE', 'TERM_CLOSE', 'COLLECT_PGO', 'PING',
  ]) assert.match(labd, new RegExp(`"${command}"`));
  assert.match(labd, /birdc", "show", "status/);
  assert.match(labd, /frr\.ready/);
  assert.doesNotMatch(labd, /frrinit\.sh", "status/);
  assert.match(labd, /LABD_ENTRYPOINT_FAILURE_PATH/);
  assert.match(labd, /labd_read_failure_detail/);
  assert.match(labd, /NODE_READY %u/);
  assert.match(labd, /LABD_MAX_TERMINAL_CHUNK/);
  assert.match(labd, /SCM_RIGHTS/);
  assert.match(labd, /daemon-%s_%%m_%%p\.profraw/);
  assert.match(labd, /setenv\("LLVM_PROFILE_FILE", profile, 1\)/);
  assert.match(labd, /setenv\("LLVM_PROFILE_FILE", "\/dev\/null", 1\)/);
  assert.match(labd, /total > 64U \* 1024U \* 1024U/);
  assert.match(labd, /count == 128U/);
  assert.match(labd, /stop_node_with_grace\(node, 1500U, &error\)/);
  assert.match(config, /strcmp\(token, "-"\) == 0/);
  assert.match(config, /invalid canonical base64 pad bits/);
  assert.match(readFileSync(resolve(sourceRoot, 'anycast-labd.h'), 'utf8'), /#define LABD_MAX_NODES 64U/);
  assert.match(sharedBootstrap, /SHARED_LAB_MAX_NODES\s*=\s*SHARED_GUEST_LIMITS\.nodes/);
  assert.match(sharedGuestContract, /nodes:\s*64/);
});

test('browser shared-guest limits stay in lockstep with anycast-labd', () => {
  const macros = {
    LABD_MAX_NODES: SHARED_GUEST_LIMITS.nodes,
    LABD_MAX_ARGS: SHARED_GUEST_LIMITS.argumentsPerNode,
    LABD_MAX_ENV: SHARED_GUEST_LIMITS.environmentPerNode,
    LABD_MAX_INTERFACES: SHARED_GUEST_LIMITS.interfacesPerNode,
    LABD_MAX_ADDRESSES: SHARED_GUEST_LIMITS.addressesPerNode,
    LABD_MAX_TERMINALS: SHARED_GUEST_LIMITS.terminals,
    LABD_MAX_CONTROL_LINE: SHARED_GUEST_LIMITS.controlLineBytes,
    LABD_MAX_TERMINAL_CHUNK: SHARED_GUEST_LIMITS.terminalChunkBytes,
    LABD_MAX_CONFIG_BYTES: SHARED_GUEST_LIMITS.nodeConfigBytes,
    LABD_MAX_CONFIG_DECODED: SHARED_GUEST_LIMITS.nodeConfigDecodedBytes,
    LABD_MAX_FILE_BYTES: SHARED_GUEST_LIMITS.fileBytes,
    LABD_MAX_ARCHIVE_BYTES: SHARED_GUEST_LIMITS.rootArchiveBytes,
  };
  for (const [name, expected] of Object.entries(macros)) {
    assert.equal(readUnsignedMacro(labdHeader, name), expected, `${name} drifted from the browser contract`);
  }
  assert.equal(readUnsignedMacro(archiveSource, 'TAR_MAX_ENTRIES'), SHARED_GUEST_LIMITS.rootArchiveEntries);
  assert.equal(SHARED_GUEST_LIMITS.bootstrapArchiveBytes, SHARED_GUEST_LIMITS.rootArchiveBytes);
  assert.equal(SHARED_GUEST_LIMITS.bootstrapArchivePayloadBytes, SHARED_GUEST_LIMITS.rootArchivePayloadBytes);
  assert.equal(SHARED_GUEST_LIMITS.bootstrapArchiveEntries, SHARED_GUEST_LIMITS.rootArchiveEntries);
  assert.match(
    config,
    new RegExp(`labd_canonical_positive\\(tokens\\[5\\], ${SHARED_GUEST_LIMITS.maximumMtu}U, &mtu\\)`),
  );
  assert.match(config, new RegExp(`mtu < ${SHARED_GUEST_LIMITS.minimumMtu}U`));
});

test('control output is queued atomically and drained through POLLOUT backpressure', () => {
  const protocol = readFileSync(resolve(sourceRoot, 'protocol.c'), 'utf8');
  const header = readFileSync(resolve(sourceRoot, 'anycast-labd.h'), 'utf8');

  assert.match(header, /LABD_CONTROL_OUTPUT_BYTES \(256U \* 1024U\)/);
  assert.match(protocol, /written < 0 && \(errno == EAGAIN \|\| errno == EWOULDBLOCK\)/);
  assert.match(protocol, /queue->head = \(queue->head \+ \(size_t\)written\) %/);
  assert.match(labd, /output_pending \? POLLOUT : POLLIN/);
  assert.match(labd, /flush_control_output\(\)/);
  assert.match(labd, /if \(!output_pending\) \{[\s\S]*nodes\[index\]\.event_fd[\s\S]*terminals\[index\]\.master_fd/);
  assert.doesNotMatch(labd, /\bvdprintf\s*\(/);
});

test('APPLY prepares a stopped node before the running-only command gate', () => {
  const apply = labd.indexOf('if (strcmp(tokens[1], "APPLY") == 0)');
  const runningGate = labd.indexOf('state_error = node_state_error(node);', apply);
  const read = labd.indexOf('if (strcmp(tokens[1], "READ") == 0)', apply);

  assert.ok(apply >= 0 && runningGate > apply && read > runningGate);
  const applyBlock = labd.slice(apply, runningGate);
  assert.match(applyBlock, /labd_apply_disposition\([\s\S]*node->running,[\s\S]*node->starting,[\s\S]*node->namespace_alive/);
  assert.match(applyBlock, /disposition == LABD_APPLY_REJECT_TRANSITION/);
  assert.match(applyBlock, /disposition == LABD_APPLY_PREPARE_ROOT &&[\s\S]*prepare_node_root\(node, &error\) < 0/);
  assert.match(applyBlock, /apply_node_archive\(node, &error\)/);
  assert.match(readFileSync(resolve(sourceRoot, 'tests.c'), 'utf8'), /escape\/owned/);
});

function readUnsignedMacro(source, name) {
  const match = source.match(new RegExp(`^#define\\s+${name}\\s+(.+)$`, 'm'));
  assert.ok(match, `missing ${name}`);
  const expression = match[1].replace(/\bU\b|U(?=\s|\)|\*|$)/g, '').replace(/[()]/g, '').trim();
  assert.match(expression, /^\d+(?:\s*\*\s*\d+)*$/);
  return expression.split('*').reduce((value, factor) => value * Number(factor.trim()), 1);
}

test('legacy host-namespace shell and agent are absent from the overlay', () => {
  for (const removed of ['anycastlab-agent', 'anycastlab-shell']) {
    const path = resolve(buildroot, 'board/rootfs-overlay/usr/libexec', removed);
    assert.throws(() => readFileSync(path), { code: 'ENOENT' }, basename(path));
  }
});
