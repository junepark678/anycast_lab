import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { LabProject } from '../src/core';
import { exportProjectArchive } from '../src/persistence';

interface NativeRuntimeStatus {
  readonly nativeV86?: boolean;
  readonly manifestSha256?: unknown;
  readonly buildId?: unknown;
}

interface PgoNativeIdentity {
  readonly manifestSha256: string;
  readonly buildId: string;
}

const nativeNodeProbes = [
  {
    nodeId: 'bird-native',
    hostname: 'native-bird',
    addresses: ['192.0.2.0/31', '203.0.113.7/32'],
    connectedRoute: '192.0.2.0/31',
    sentinel: '/tmp/anycastlab-bird-namespace',
    daemon: 'bird',
  },
  {
    nodeId: 'frr-native',
    hostname: 'native-frr',
    addresses: ['192.0.2.1/31'],
    connectedRoute: '192.0.2.0/31',
    sentinel: '/tmp/anycastlab-frr-namespace',
    foreignSentinel: '/tmp/anycastlab-bird-namespace',
    daemon: 'frr',
  },
] as const;

type NativeNodeProbe = (typeof nativeNodeProbes)[number];
type NamespaceKind = 'pid' | 'mnt' | 'net' | 'uts' | 'ipc' | 'cgroup' | 'time';
type NamespaceSnapshot = Readonly<Record<NamespaceKind, string>>;

const browserDiagnostics = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const messages: string[] = [];
  browserDiagnostics.set(page, messages);
  const record = (message: string) => {
    messages.push(message);
    if (messages.length > 500) messages.splice(0, messages.length - 500);
  };
  page.on('console', (message) => record(`[console:${message.type()}] ${message.text()}`));
  page.on('pageerror', (error) => record(`[pageerror] ${error.stack ?? error.message}`));
  page.on('requestfailed', (request) => {
    record(`[requestfailed] ${request.method()} ${request.url()} :: ${request.failure()?.errorText ?? 'unknown error'}`);
  });
});

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus || testInfo.status === 'skipped') return;
  await attachNativeFailureDiagnostics(page, testInfo, browserDiagnostics.get(page) ?? []);
});

test('keeps native guest probes within the interactive PTY input budget', () => {
  const phases = nativeNodeProbes.flatMap((probe) => [
    ...nativeNodePreflightCommands(probe),
    ...nativeDiagnosticCommands(probe),
  ]);
  expect(new Set(phases.map(({ marker }) => marker)).size).toBe(phases.length);
  for (const { marker, input } of phases) {
    expect(input, `${marker} must not echo its complete marker before execution`).not.toContain(marker);
    expect(
      new TextEncoder().encode(input).byteLength,
      `${marker} exceeds the conservative canonical PTY line budget`,
    ).toBeLessThanOrEqual(1_024);
  }
});

test('boots real BIRD and FRR namespaces, establishes BGP and OSPF, and forwards over the browser fabric', async ({ page }, testInfo) => {
  const collectPgo = process.env.ANYCAST_LAB_COLLECT_PGO === '1';
  test.setTimeout(collectPgo ? 900_000 : 360_000);
  await page.goto('./');
  const nativeStatus = await page.evaluate(async () => {
    try {
      const response = await fetch('runtime/status.json', { cache: 'no-store' });
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return null;
      const status = await response.json() as NativeRuntimeStatus;
      return status.nativeV86 === true ? status : null;
    } catch {
      return null;
    }
  });
  const pgoNativeIdentity = collectPgo ? requirePgoNativeIdentity(nativeStatus) : null;
  if (nativeStatus === null && process.env.ANYCAST_LAB_REQUIRE_NATIVE === '1') {
    throw new Error('Native VM artifacts are required for this test run but runtime/status.json reports none.');
  }
  test.skip(nativeStatus === null, 'The optional native v86 image was not built for this test run.');
  if (collectPgo) await installPgoBridge(page);

  const now = '2026-07-11T00:00:00.000Z';
  const trainingRoutes = Array.from(
    { length: 128 },
    (_, index) => `  route 198.18.0.${index}/32 blackhole;`,
  ).join('\n');
  const project: LabProject = {
    schemaVersion: 1,
    id: 'native-bird-frr-smoke',
    name: 'Native BIRD and FRR smoke test',
    createdAt: now,
    updatedAt: now,
    seed: 678,
    nodes: [
      {
        id: 'bird-native',
        name: 'Native BIRD',
        kind: 'router',
        appliance: {
          kind: 'bird',
          runtime: 'wasm',
          version: '2.15.1',
          entrypoint: '/etc/bird/bird.conf',
        },
        interfaces: [{
          id: 'bird-eth0', name: 'eth0', addresses: ['192.0.2.0/31', '203.0.113.7/32'], state: 'up', mtu: 1500,
        }],
        files: [{
          path: '/etc/bird/bird.conf',
          content: `router id 192.0.2.10;
protocol device {}
protocol direct { ipv4; }
protocol static training_routes {
  ipv4;
${trainingRoutes}
}
protocol bgp frr_peer {
  local 192.0.2.0 as 65001;
  neighbor 192.0.2.1 as 65002;
  hold time 6;
  keepalive time 2;
  connect retry time 1;
  ipv4 { import all; export all; };
}
protocol ospf v2 frr_ospf {
  ipv4 { import all; export none; };
  area 0 {
    interface "eth0" {
      type ptp;
      hello 1;
      retransmit 2;
      wait 3;
      dead 4;
    };
  };
}
`,
          encoding: 'utf-8',
          entrypoint: true,
        }],
        state: 'up',
        position: { x: 260, y: 180 },
        asn: 65001,
      },
      {
        id: 'frr-native',
        name: 'Native FRR',
        kind: 'router',
        appliance: {
          kind: 'frr',
          runtime: 'wasm',
          version: '10.5.1',
          entrypoint: '/etc/frr/frr.conf',
        },
        interfaces: [{
          id: 'frr-eth0', name: 'eth0', addresses: ['192.0.2.1/31'], state: 'up', mtu: 1500,
        }],
        files: [{
          path: '/etc/frr/frr.conf',
          content: `frr defaults traditional
hostname native-frr
service integrated-vtysh-config
!
interface eth0
 ip ospf area 0
 ip ospf network point-to-point
 ip ospf hello-interval 1
 ip ospf dead-interval 4
!
router bgp 65002
 bgp router-id 192.0.2.20
 neighbor 192.0.2.0 remote-as 65001
 neighbor 192.0.2.0 timers 2 6
 neighbor 192.0.2.0 timers connect 1
 !
 address-family ipv4 unicast
  neighbor 192.0.2.0 activate
  neighbor 192.0.2.0 route-map ACCEPT in
  neighbor 192.0.2.0 route-map ACCEPT out
 exit-address-family
!
route-map ACCEPT permit 10
!
router ospf
 ospf router-id 192.0.2.20
!
line vty
`,
          encoding: 'utf-8',
          entrypoint: true,
        }, {
          path: '/etc/frr/daemons',
          content: `bgpd=yes
ospfd=yes
vtysh_enable=yes
zebra_options="-A 127.0.0.1"
bgpd_options="-A 127.0.0.1"
ospfd_options="-A 127.0.0.1"
`,
          encoding: 'utf-8',
        }],
        state: 'up',
        position: { x: 620, y: 180 },
        asn: 65002,
      },
    ],
    links: [{
      id: 'bird-frr-link',
      endpoints: [
        { nodeId: 'bird-native', interfaceId: 'bird-eth0' },
        { nodeId: 'frr-native', interfaceId: 'frr-eth0' },
      ],
      state: 'up',
      latencyMs: 5,
      jitterMs: 0,
      loss: 0,
      bandwidthMbps: 1_000,
      mtu: 1500,
    }],
    scenarioEvents: [],
    settings: { defaultTtl: 32, maxConvergenceIterations: 64, captureLimit: 5_000 },
  };
  const archivePath = testInfo.outputPath('native-bird-frr.anycastlab');
  await writeFile(archivePath, exportProjectArchive(project));
  await page.locator('input[type=file]').setInputFiles(archivePath);
  await expect(page.getByRole('status')).toContainText('Imported Native BIRD and FRR smoke test');
  const nativeMode = page.getByRole('radio', { name: 'NATIVE VM' });
  await expect(nativeMode).toBeChecked();
  await expect(nativeMode).toBeEnabled();

  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Working…' })).toBeDisabled();
  await expect(page.getByTitle('Import project')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'FRRouting' })).toBeDisabled();
  await expect(page.getByText(/Native fabric is running · 2 real appliances/)).toBeVisible({
    timeout: collectPgo ? 360_000 : 180_000,
  });

  const namespaceSnapshots = new Map<string, NamespaceSnapshot>();
  for (const probe of nativeNodeProbes) {
    const snapshot = await test.step(
      `validate ${probe.nodeId} namespace, interface, routes, and daemon`,
      () => validateNativeNode(page, probe),
    );
    namespaceSnapshots.set(probe.nodeId, snapshot);
  }
  await test.step('validate namespace and filesystem isolation between appliances', async () => {
    expectNamespacesIsolated(
      requireNamespaceSnapshot(namespaceSnapshots, 'bird-native'),
      requireNamespaceSnapshot(namespaceSnapshots, 'frr-native'),
    );
    const output = await runNativeCommand(
      page,
      'bird-native',
      "if [ ! -e /tmp/anycastlab-frr-namespace ]; then isolated=yes; else isolated=no; fi; printf '%s%s %s\\n' 'FILESYSTEM-ISOLATION-' 'DONE' \"$isolated\"",
      'FILESYSTEM-ISOLATION-DONE',
      10_000,
    );
    expect(output).toMatch(/^FILESYSTEM-ISOLATION-DONE yes$/m);
  });

  await page.getByTestId('rf__node-bird-native').click();
  const command = page.getByRole('textbox', { name: 'Terminal command' });
  const terminal = page.locator('.terminal-output');
  const runAndWait = async (input: string, marker: string, timeout: number) => {
    await command.fill(input);
    await command.press('Enter');
    await expect(terminal).toContainText(marker, { timeout });
  };
  await runAndWait(
    "i=0; while [ \"$i\" -lt 10 ]; do if ping -c 1 -W 2 192.0.2.1; then printf 'PING-%s\\n' READY; break; fi; i=$((i + 1)); sleep 1; done",
    'PING-READY',
    35_000,
  );
  await runAndWait(
    "i=0; while [ \"$i\" -lt 45 ]; do birdc show protocols all frr_peer > /tmp/bird-bgp; cat /tmp/bird-bgp; if grep -Eq 'BGP state:[[:space:]]+Established' /tmp/bird-bgp; then printf 'BIRD-BGP-%s\\n' READY; break; fi; i=$((i + 1)); sleep 1; done",
    'BIRD-BGP-READY',
    60_000,
  );
  await expect(terminal).toContainText('BIRD 2.15.1');
  await expect(terminal).toContainText(/BGP state:\s+Established/);

  await page.getByTestId('rf__node-frr-native').click();
  await runAndWait(
    "i=0; while [ \"$i\" -lt 45 ]; do vtysh -c 'show bgp neighbor 192.0.2.0' > /tmp/frr-bgp; cat /tmp/frr-bgp; if grep -q 'BGP state = Established' /tmp/frr-bgp; then printf 'FRR-BGP-%s\\n' READY; break; fi; i=$((i + 1)); sleep 1; done",
    'FRR-BGP-READY',
    60_000,
  );
  await expect(terminal).toContainText('BGP neighbor is 192.0.2.0');
  await expect(terminal).toContainText(/BGP state = Established/);
  await runAndWait(
    "vtysh -c 'show ip route 203.0.113.7/32'; printf 'ROUTE-%s\\n' CHECKED",
    'ROUTE-CHECKED',
    15_000,
  );
  await expect(terminal).toContainText('Routing entry for 203.0.113.7/32');
  await expect(terminal).toContainText('Known via "bgp"');
  await expect(terminal).toContainText(/\* 192\.0\.2\.0, via eth0/);
  await runAndWait(
    "i=0; while [ \"$i\" -lt 10 ]; do if ping -c 1 -W 2 203.0.113.7; then printf 'ROUTED-PING-%s\\n' READY; break; fi; i=$((i + 1)); sleep 1; done",
    'ROUTED-PING-READY',
    35_000,
  );
  await page.getByTestId('rf__node-bird-native').click();
  await runAndWait(
    "i=0; while [ \"$i\" -lt 30 ]; do birdc show ospf neighbors > /tmp/bird-ospf; cat /tmp/bird-ospf; if grep -Eiq '192.0.2.20.*full' /tmp/bird-ospf; then printf 'BIRD-OSPF-%s\\n' READY; break; fi; i=$((i + 1)); sleep 1; done",
    'BIRD-OSPF-READY',
    45_000,
  );
  await expect(terminal).toContainText(/192\.0\.2\.20.*full/i);
  await page.getByTestId('rf__node-frr-native').click();
  await runAndWait(
    "i=0; while [ \"$i\" -lt 30 ]; do vtysh -c 'show ip ospf neighbor' > /tmp/frr-ospf; cat /tmp/frr-ospf; if grep -Eq '192.0.2.10.*Full' /tmp/frr-ospf; then printf 'FRR-OSPF-%s\\n' READY; break; fi; i=$((i + 1)); sleep 1; done",
    'FRR-OSPF-READY',
    45_000,
  );
  await expect(terminal).toContainText(/192\.0\.2\.10.*Full/);

  if (collectPgo) {
    await page.getByTestId('rf__node-bird-native').click();
    await runAndWait(
      "birdc disable training_routes && sleep 1 && birdc enable training_routes && printf 'ROUTE-CHURN-%s\\n' READY",
      'ROUTE-CHURN-READY',
      15_000,
    );
    await page.evaluate(async () => {
      const bridge = (globalThis as typeof globalThis & { __anycastPgo?: PgoBridge }).__anycastPgo;
      if (bridge?.engine === undefined) throw new Error('PGO bridge did not capture the native engine');
      await bridge.engine.setLinkState('bird-frr-link', 'down');
    });
    await page.getByTestId('rf__node-frr-native').click();
    await runAndWait(
      "i=0; while [ \"$i\" -lt 20 ]; do vtysh -c 'show ip route 198.18.0.42/32' > /tmp/frr-route-withdrawn 2>&1; cat /tmp/frr-route-withdrawn; if ! grep -q 'Routing entry for 198.18.0.42/32' /tmp/frr-route-withdrawn; then printf 'ROUTE-WITHDRAWN-%s\\n' READY; break; fi; i=$((i + 1)); sleep 1; done",
      'ROUTE-WITHDRAWN-READY',
      30_000,
    );
    await page.evaluate(async () => {
      const bridge = (globalThis as typeof globalThis & { __anycastPgo?: PgoBridge }).__anycastPgo;
      if (bridge?.engine === undefined) throw new Error('PGO bridge did not capture the native engine');
      await bridge.engine.setLinkState('bird-frr-link', 'up');
    });
    await page.getByTestId('rf__node-bird-native').click();
    await runAndWait(
      "i=0; while [ \"$i\" -lt 45 ]; do birdc show protocols all frr_peer > /tmp/bird-bgp-recovery; if grep -Eq 'BGP state:[[:space:]]+Established' /tmp/bird-bgp-recovery; then printf 'BIRD-RECOVERY-%s\\n' READY; break; fi; i=$((i + 1)); sleep 1; done",
      'BIRD-RECOVERY-READY',
      60_000,
    );
    await runAndWait(
      "i=0; while [ \"$i\" -lt 30 ]; do birdc show ospf neighbors > /tmp/bird-ospf-recovery; cat /tmp/bird-ospf-recovery; if grep -Eiq '192.0.2.20.*full' /tmp/bird-ospf-recovery; then printf 'BIRD-OSPF-RECOVERY-%s\\n' READY; break; fi; i=$((i + 1)); sleep 1; done",
      'BIRD-OSPF-RECOVERY-READY',
      45_000,
    );
    await page.getByTestId('rf__node-frr-native').click();
    await runAndWait(
      "i=0; while [ \"$i\" -lt 45 ]; do vtysh -c 'show bgp neighbor 192.0.2.0' > /tmp/frr-bgp-recovery; if grep -q 'BGP state = Established' /tmp/frr-bgp-recovery; then printf 'FRR-RECOVERY-%s\\n' READY; break; fi; i=$((i + 1)); sleep 1; done",
      'FRR-RECOVERY-READY',
      60_000,
    );
    await runAndWait(
      "i=0; while [ \"$i\" -lt 30 ]; do vtysh -c 'show ip route 198.18.0.42/32' > /tmp/frr-route-restored 2>&1; cat /tmp/frr-route-restored; if grep -q 'Routing entry for 198.18.0.42/32' /tmp/frr-route-restored; then printf 'ROUTE-RESTORED-%s\\n' READY; break; fi; i=$((i + 1)); sleep 1; done",
      'ROUTE-RESTORED-READY',
      45_000,
    );
    await runAndWait(
      "i=0; while [ \"$i\" -lt 30 ]; do vtysh -c 'show ip ospf neighbor' > /tmp/frr-ospf-recovery; cat /tmp/frr-ospf-recovery; if grep -Eq '192.0.2.10.*Full' /tmp/frr-ospf-recovery; then printf 'FRR-OSPF-RECOVERY-%s\\n' READY; break; fi; i=$((i + 1)); sleep 1; done",
      'FRR-OSPF-RECOVERY-READY',
      45_000,
    );
  }

  await page.getByRole('button', { name: 'Open native configuration' }).click();
  await expect(page.getByRole('textbox', { name: '/etc/frr/frr.conf contents' })).not.toBeEditable();
  await expect(page.getByRole('button', { name: 'FRRouting' })).toBeDisabled();

  await page.getByRole('button', { name: /Events/ }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export PCAPNG' }).click();
  const capture = await downloadPromise;
  expect(capture.suggestedFilename()).toMatch(/\.pcapng$/);
  const capturePath = await capture.path();
  expect(capturePath).not.toBeNull();
  const bytes = await readFile(capturePath!);
  expect(bytes.byteLength).toBeGreaterThan(80);
  expect([...bytes.subarray(0, 4)]).toEqual([0x0a, 0x0d, 0x0d, 0x0a]);
  const packetInterfaces = new Set<number>();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset + 12 <= bytes.byteLength;) {
    const blockType = view.getUint32(offset, true);
    const blockLength = view.getUint32(offset + 4, true);
    expect(blockLength).toBeGreaterThanOrEqual(12);
    expect(offset + blockLength).toBeLessThanOrEqual(bytes.byteLength);
    expect(view.getUint32(offset + blockLength - 4, true)).toBe(blockLength);
    if (blockType === 6) packetInterfaces.add(view.getUint32(offset + 8, true));
    offset += blockLength;
  }
  expect(packetInterfaces.size).toBeGreaterThanOrEqual(2);

  if (collectPgo) {
    if (pgoNativeIdentity === null) throw new Error('PGO native identity was not validated');
    const outputDirectory = process.env.ANYCAST_LAB_PGO_RAW_DIR;
    if (outputDirectory === undefined || outputDirectory.trim() === '') {
      throw new Error('ANYCAST_LAB_PGO_RAW_DIR is required while collecting PGO profiles');
    }
    const absoluteOutput = resolve(outputDirectory);
    await mkdir(absoluteOutput, { recursive: true });
    const collections = await page.evaluate(async () => {
      const bridge = (globalThis as typeof globalThis & { __anycastPgo?: PgoBridge }).__anycastPgo;
      if (bridge?.engine === undefined) throw new Error('PGO bridge did not capture the native engine');
      bridge.profiles = await bridge.engine.collectPgoProfiles();
      return bridge.profiles.map(({ nodeId, kind, files }) => ({ nodeId, kind, files }));
    });
    expect(collections.map(({ nodeId, kind }) => ({ nodeId, kind })).sort((left, right) => left.nodeId.localeCompare(right.nodeId))).toEqual([
      { nodeId: 'bird-native', kind: 'bird' },
      { nodeId: 'frr-native', kind: 'frr' },
    ]);
    for (const { nodeId, kind } of collections) {
      const output = resolve(absoluteOutput, `${nodeId}.tar`);
      await downloadCollectedProfile(page, nodeId, output);
      expect((await stat(output)).size).toBeGreaterThan(512);
      expect(kind === 'bird' || kind === 'frr').toBe(true);
    }
    await writeFile(resolve(absoluteOutput, 'training-evidence.json'), `${JSON.stringify({
      schemaVersion: 1,
      buildId: pgoNativeIdentity.buildId,
      manifestSha256: pgoNativeIdentity.manifestSha256,
      workload: 'bird-frr-bgp-ospfv2-route-churn-link-recovery-v1',
      collections,
    }, null, 2)}\n`);
  }
});

async function validateNativeNode(page: Page, probe: NativeNodeProbe): Promise<NamespaceSnapshot> {
  const outputs: string[] = [];
  for (const phase of nativeNodePreflightCommands(probe)) {
    outputs.push(await runNativeCommand(page, probe.nodeId, phase.input, phase.marker, 15_000));
  }
  const output = outputs.join('\n');
  const failedChecks = [...output.matchAll(/^CHECK ([^\r\n]+) failed$/gm)].map((match) => match[1]);
  expect(
    failedChecks,
    `${probe.nodeId} guest preflight failed: ${failedChecks.length > 0 ? failedChecks.join(', ') : 'unknown check'}`,
  ).toEqual([]);
  return parseNamespaceSnapshot(output, probe.nodeId);
}

interface NativeProbePhase {
  readonly marker: string;
  readonly input: string;
}

function nativeNodePreflightCommands(probe: NativeNodeProbe): readonly NativeProbePhase[] {
  const linkState = `/tmp/anycastlab-test-${probe.nodeId}-link`;
  const addressState = `/tmp/anycastlab-test-${probe.nodeId}-addresses`;
  const routeState = `/tmp/anycastlab-test-${probe.nodeId}-routes`;
  const daemonState = `/tmp/anycastlab-test-${probe.nodeId}-daemon`;
  const identity = [
    `check hostname test "$(hostname 2>/dev/null)" = ${shellQuote(probe.hostname)}`,
    "check proc-pid-one test -r /proc/1/status",
    ...('foreignSentinel' in probe ? [
      `if [ ! -e ${shellQuote(probe.foreignSentinel)} ]; then report filesystem-isolation ok; else report filesystem-isolation failed; fi`,
    ] : []),
    `if printf '%s\\n' ${shellQuote(probe.nodeId)} > ${shellQuote(probe.sentinel)}; then report filesystem-writable ok; else report filesystem-writable failed; fi`,
    "for namespace in pid mnt net uts ipc cgroup time; do namespace_id=$(readlink \"/proc/self/ns/$namespace\" 2>/dev/null || true); printf 'NS %s %s\\n' \"$namespace\" \"$namespace_id\"; done",
  ];
  const link = [
    `if ip -o link show dev eth0 > ${shellQuote(linkState)} 2>&1; then report eth0-exists ok; else report eth0-exists failed; fi`,
    `cat ${shellQuote(linkState)}`,
    `check eth0-admin-up grep -Eq '[<,]UP[,>]' ${shellQuote(linkState)}`,
    `if grep -Eq '[<,]NOARP[,>]' ${shellQuote(linkState)}; then report eth0-arp failed; else report eth0-arp ok; fi`,
    `check eth0-mtu grep -Eq ' mtu 1500( |$)' ${shellQuote(linkState)}`,
    "if ip -o link show dev lo > /tmp/anycastlab-test-lo 2>&1 && grep -Eq '[<,]UP[,>]' /tmp/anycastlab-test-lo; then report loopback-up ok; else report loopback-up failed; fi",
  ];
  const addresses = [
    `if ip -o -4 address show dev eth0 scope global > ${shellQuote(addressState)} 2>&1; then report addresses-readable ok; else report addresses-readable failed; fi`,
    `cat ${shellQuote(addressState)}`,
    `address_count=$(wc -l < ${shellQuote(addressState)}); check address-count test "$address_count" -eq ${probe.addresses.length}`,
    ...probe.addresses.map((address) => (
      `check ${shellQuote(`address-${address}`)} grep -Fq ${shellQuote(`inet ${address} `)} ${shellQuote(addressState)}`
    )),
  ];
  const routes = [
    `if ip -4 route show table main dev eth0 > ${shellQuote(routeState)} 2>&1; then report routes-readable ok; else report routes-readable failed; fi`,
    `cat ${shellQuote(routeState)}`,
    `check connected-route grep -Fq ${shellQuote(probe.connectedRoute)} ${shellQuote(routeState)}`,
  ];
  const daemonPhases: readonly (readonly [string, readonly string[]])[] = probe.daemon === 'bird' ? [[
    'DAEMON', [
      `if birdc show status > ${shellQuote(daemonState)} 2>&1; then report bird-control ok; else report bird-control failed; fi`,
      `check bird-version grep -Fq 'BIRD 2.15.1' ${shellQuote(daemonState)}`,
    ],
  ]] : [[
    'DAEMON-HEALTH', [
      'check frr-ready-marker test -f /run/anycastlab/frr.ready',
      'if [ ! -s /run/anycastlab/entrypoint.failure ]; then report frr-not-degraded ok; else report frr-not-degraded failed; fi',
      "for daemon in watchfrr zebra bgpd ospfd; do daemon_pid=; daemon_live=no; if [ -r \"/run/frr/$daemon.pid\" ] && IFS= read -r daemon_pid < \"/run/frr/$daemon.pid\"; then case \"$daemon_pid\" in ''|*[!0-9]*) ;; *) if kill -0 \"$daemon_pid\" 2>/dev/null; then daemon_live=yes; fi ;; esac; fi; if [ \"$daemon_live\" = yes ]; then report \"$daemon-live\" ok; else report \"$daemon-live\" failed; fi; done",
    ],
  ], [
    'DAEMON-CONTROL', [
      `if vtysh -c 'show version' > ${shellQuote(daemonState)} 2>&1; then report frr-vtysh ok; else report frr-vtysh failed; fi`,
      `check frr-version grep -Fq 'FRRouting 10.5.1' ${shellQuote(daemonState)}`,
    ],
  ]];
  return [
    nativeProbePhase(probe.nodeId, 'IDENTITY', identity, true),
    nativeProbePhase(probe.nodeId, 'LINK', link),
    nativeProbePhase(probe.nodeId, 'ADDRESSES', addresses),
    nativeProbePhase(probe.nodeId, 'ROUTES', routes),
    ...daemonPhases.map(([phase, commands]) => nativeProbePhase(probe.nodeId, phase, commands)),
  ];
}

function nativeProbePhase(
  nodeId: string,
  phase: string,
  commands: readonly string[],
  includeHelpers = false,
): NativeProbePhase {
  const marker = `NATIVE-NODE-${nodeId}-${phase}-DONE`;
  const helpers = [
    "report() { if [ \"$2\" = ok ]; then result=ok; else result=failed; fi; printf 'CHECK %s %s\\n' \"$1\" \"$result\"; }",
    "check() { label=$1; shift; if \"$@\"; then report \"$label\" ok; else report \"$label\" failed; fi; }",
  ];
  return {
    marker,
    input: [...(includeHelpers ? helpers : []), ...commands, shellCompletion(marker)].join('; '),
  };
}

async function runNativeCommand(
  page: Page,
  nodeId: string,
  input: string,
  marker: string,
  timeout: number,
): Promise<string> {
  const consolePicker = page.getByRole('combobox', { name: 'Console appliance' });
  await consolePicker.selectOption(nodeId);
  const command = page.getByRole('textbox', { name: 'Terminal command' });
  const terminal = page.locator('.console-panel .terminal-output');
  const lines = terminal.locator('.terminal-line');
  const initialLineCount = await lines.count();
  await expect(command).toBeEnabled();
  await command.fill(input);
  await command.press('Enter');
  await expect(terminal).toContainText(marker, { timeout });
  const allLines = await lines.allInnerTexts();
  return allLines.slice(initialLineCount).join('\n').replaceAll('\r', '');
}

function parseNamespaceSnapshot(output: string, nodeId: string): NamespaceSnapshot {
  const kinds: readonly NamespaceKind[] = ['pid', 'mnt', 'net', 'uts', 'ipc', 'cgroup', 'time'];
  const values = new Map<NamespaceKind, string>();
  for (const match of output.matchAll(/^NS (pid|mnt|net|uts|ipc|cgroup|time) ([a-z_]+:\[\d+\])$/gm)) {
    values.set(match[1] as NamespaceKind, match[2]);
  }
  const missing = kinds.filter((kind) => !values.has(kind));
  if (missing.length > 0) {
    throw new Error(`${nodeId} did not report valid ${missing.join(', ')} namespace identities:\n${output}`);
  }
  return Object.fromEntries(kinds.map((kind) => [kind, values.get(kind)!])) as NamespaceSnapshot;
}

function requireNamespaceSnapshot(
  snapshots: ReadonlyMap<string, NamespaceSnapshot>,
  nodeId: string,
): NamespaceSnapshot {
  const snapshot = snapshots.get(nodeId);
  if (snapshot === undefined) throw new Error(`Missing namespace snapshot for ${nodeId}`);
  return snapshot;
}

function expectNamespacesIsolated(left: NamespaceSnapshot, right: NamespaceSnapshot): void {
  const kinds: readonly NamespaceKind[] = ['pid', 'mnt', 'net', 'uts', 'ipc', 'cgroup', 'time'];
  for (const kind of kinds) {
    expect(left[kind], `${kind} namespace must be isolated per appliance`).not.toBe(right[kind]);
  }
}

function shellCompletion(marker: string): string {
  const pivot = Math.max(1, Math.floor(marker.length / 2));
  return `printf '%s%s\\n' ${shellQuote(marker.slice(0, pivot))} ${shellQuote(marker.slice(pivot))}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function attachNativeFailureDiagnostics(
  page: Page,
  testInfo: TestInfo,
  messages: readonly string[],
): Promise<void> {
  const attachText = async (name: string, body: string) => {
    const path = testInfo.outputPath(name);
    await writeFile(path, body.slice(-200_000));
    await testInfo.attach(name, { path, contentType: 'text/plain' });
  };

  try {
    const screenshotPath = testInfo.outputPath('native-ui.png');
    await page.screenshot({ path: screenshotPath, fullPage: true, timeout: 5_000 });
    await testInfo.attach('native-ui.png', { path: screenshotPath, contentType: 'image/png' });
  } catch (error) {
    await attachText('native-ui-screenshot-error.txt', String(error));
  }

  try {
    const status = await page.evaluate(async () => {
      const response = await fetch('runtime/status.json', { cache: 'no-store' });
      return { status: response.status, body: await response.text() };
    });
    await attachText('native-runtime-status.txt', `${status.status}\n${status.body}`);
  } catch (error) {
    await attachText('native-runtime-status-error.txt', String(error));
  }

  try {
    await attachText('native-ui-state.txt', await page.locator('body').innerText({ timeout: 3_000 }));
  } catch (error) {
    await attachText('native-ui-state-error.txt', String(error));
  }

  const nativeFabricReady = await page.getByText(/Native fabric is running/).first().isVisible().catch(() => false);
  for (const probe of nativeNodeProbes) {
    try {
      const picker = page.getByRole('combobox', { name: 'Console appliance' });
      await picker.selectOption(probe.nodeId, { timeout: 3_000 });
      const terminal = page.locator('.console-panel .terminal-output');
      await attachText(`${probe.nodeId}-console-before.txt`, await terminal.innerText({ timeout: 3_000 }));
      const diagnosticErrors: string[] = [];
      if (nativeFabricReady) {
        for (const phase of nativeDiagnosticCommands(probe)) {
          try {
            await runNativeCommand(page, probe.nodeId, phase.input, phase.marker, 8_000);
          } catch (error) {
            diagnosticErrors.push(`${phase.marker}: ${conciseError(error)}`);
            break;
          }
        }
      }
      await attachText(
        `${probe.nodeId}-diagnostics.txt`,
        `${await terminal.innerText({ timeout: 3_000 })}${diagnosticErrors.length === 0
          ? ''
          : `\n\n[diagnostic commands that did not complete]\n${diagnosticErrors.join('\n')}`}`,
      );
    } catch (error) {
      await attachText(`${probe.nodeId}-diagnostics-error.txt`, String(error));
    }
  }

  try {
    await page.getByRole('button', { name: /Events/ }).click({ timeout: 3_000 });
    await attachText('native-events.txt', await page.locator('.activity-panel').innerText({ timeout: 3_000 }));
  } catch (error) {
    await attachText('native-events-error.txt', String(error));
  }

  try {
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 5_000 }),
      page.getByRole('button', { name: 'Export PCAPNG' }).click({ timeout: 3_000 }),
    ]);
    const path = await download.path();
    if (path === null) throw new Error('Failure PCAPNG download did not produce a local path');
    const attachmentPath = testInfo.outputPath('native-failure.pcapng');
    await download.saveAs(attachmentPath);
    await testInfo.attach('native-failure.pcapng', {
      path: attachmentPath,
      contentType: 'application/vnd.tcpdump.pcap',
    });
  } catch (error) {
    await attachText('native-failure-pcapng-error.txt', String(error));
  }
  await attachText('browser-diagnostics.txt', messages.length > 0 ? messages.join('\n') : '(no browser diagnostics recorded)');
}

function nativeDiagnosticCommands(probe: NativeNodeProbe): readonly NativeProbePhase[] {
  const phases: Array<readonly [string, readonly string[]]> = [
    ['IDENTITY', [
      "printf '%s\\n' '=== ANYCAST LAB NATIVE DIAGNOSTICS: identity ==='",
      'hostname 2>&1',
      'printf "shell-pid=%s\\n" "$$"',
      'for namespace in pid mnt net uts ipc cgroup time; do printf "NS %s " "$namespace"; readlink "/proc/self/ns/$namespace" 2>&1; done',
    ]],
    ['LINKS', [
      "printf '%s\\n' '=== links and addresses ==='",
      'ip -details -statistics link show 2>&1',
      'ip -details address show 2>&1',
    ]],
    ['ROUTES', [
      "printf '%s\\n' '=== routes ==='",
      'ip -4 route show table all 2>&1',
      'ip -6 route show table all 2>&1',
    ]],
    ['RESOURCES', [
      "printf '%s\\n' '=== processes, memory, and cgroup ==='",
      'ps 2>&1',
      'free 2>&1',
      'cat /proc/self/cgroup 2>&1',
      'for file in /sys/fs/cgroup/memory.current /sys/fs/cgroup/memory.events /sys/fs/cgroup/memory.max /sys/fs/cgroup/pids.current /sys/fs/cgroup/pids.max; do if [ -r "$file" ]; then printf "%s=" "$file"; cat "$file"; fi; done',
    ]],
  ];
  if (probe.daemon === 'bird') {
    phases.push(['BIRD', [
      "printf '%s\\n' '=== bird ==='",
      'birdc show status 2>&1',
      'birdc show protocols all 2>&1',
    ]]);
  } else {
    phases.push(['FRR-FILES', [
      "printf '%s\\n' '=== frr runtime files ==='",
      'for file in /run/anycastlab/frr.ready /run/anycastlab/entrypoint.failure /run/anycastlab/frr-status.out /run/anycastlab/frr-start.out /run/anycastlab/frr-start.done /run/anycastlab/frr-start.pid /run/frr/*.pid /var/log/frr/*; do if [ -f "$file" ]; then printf "FILE %s (%s bytes)\\n" "$file" "$(wc -c < "$file")"; tail -n 80 "$file" 2>&1; fi; done',
    ]]);
    phases.push(['FRR-CONTROL', [
      "printf '%s\\n' '=== frr control ==='",
      'cat /tmp/anycastlab-test-frr-native-daemon 2>&1',
      "vtysh -c 'show version' 2>&1",
      "vtysh -c 'show daemons' 2>&1",
    ]]);
  }
  return phases.map(([phase, commands]) => (
    nativeProbePhase(probe.nodeId, `DIAGNOSTIC-${phase}`, commands)
  ));
}

function conciseError(error: unknown): string {
  const value = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return value.replaceAll('\r', '').split('\n').slice(0, 3).join(' ').slice(0, 1_000);
}

function requirePgoNativeIdentity(status: NativeRuntimeStatus | null): PgoNativeIdentity {
  if (status === null) {
    throw new Error('PGO profile collection requires a native v86 runtime status');
  }
  if (
    typeof status.buildId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(status.buildId)
  ) {
    throw new Error('PGO profile collection requires a valid native buildId');
  }
  if (
    typeof status.manifestSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(status.manifestSha256)
  ) {
    throw new Error('PGO profile collection requires a lowercase 64-hex manifestSha256');
  }
  return { buildId: status.buildId, manifestSha256: status.manifestSha256 };
}

interface PgoBridge {
  engine?: {
    setLinkState(linkId: string, state: 'up' | 'down'): Promise<void>;
    collectPgoProfiles(): Promise<Array<{
      nodeId: string;
      kind: 'bird' | 'frr';
      archive: Uint8Array;
      files: Array<{ path: string; size: number; sha256: string }>;
    }>>;
  };
  profiles?: Array<{
    nodeId: string;
    kind: 'bird' | 'frr';
    archive: Uint8Array;
    files: Array<{ path: string; size: number; sha256: string }>;
  }>;
}

async function installPgoBridge(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const moduleUrl = new URL('src/native/engine.ts', document.baseURI).href;
    const nativeModule = await import(/* @vite-ignore */ moduleUrl) as {
      NativeLabEngine: { prototype: { start(): Promise<void> } };
    };
    const prototype = nativeModule.NativeLabEngine.prototype;
    const originalStart = prototype.start;
    (globalThis as typeof globalThis & { __anycastPgo?: PgoBridge }).__anycastPgo = {};
    prototype.start = async function patchedStart(this: PgoBridge['engine']): Promise<void> {
      const bridge = (globalThis as typeof globalThis & { __anycastPgo?: PgoBridge }).__anycastPgo;
      if (bridge === undefined) throw new Error('PGO bridge disappeared before native startup');
      bridge.engine = this;
      return originalStart.call(this);
    };
  });
}

async function downloadCollectedProfile(page: Page, nodeId: string, output: string): Promise<void> {
  const downloadPromise = page.waitForEvent('download');
  await page.evaluate((requestedNode) => {
    const bridge = (globalThis as typeof globalThis & { __anycastPgo?: PgoBridge }).__anycastPgo;
    const collection = bridge?.profiles?.find(({ nodeId: candidate }) => candidate === requestedNode);
    if (collection === undefined) throw new Error(`Collected profile archive is missing for ${requestedNode}`);
    const url = URL.createObjectURL(new Blob([collection.archive.slice()], { type: 'application/x-tar' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${requestedNode}.tar`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }, nodeId);
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(`${nodeId}.tar`);
  await download.saveAs(output);
}
