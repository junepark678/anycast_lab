import { expect, test, type Page } from '@playwright/test';
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

test('boots real BIRD and FRR VMs, establishes BGP and OSPF, and forwards over the browser fabric', async ({ page }, testInfo) => {
  const collectPgo = process.env.ANYCAST_LAB_COLLECT_PGO === '1';
  test.setTimeout(collectPgo ? 600_000 : 360_000);
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
  await expect(page.getByText(/Native fabric is running · 2 real appliances/)).toBeVisible({ timeout: 180_000 });

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
