// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflowPath = resolve(
  import.meta.dirname,
  '../../../.github/workflows/publish-native-v86.yml',
);
const workflow = await readFile(workflowPath, 'utf8');
const nativeVmSpec = await readFile(resolve(import.meta.dirname, '../../../e2e/native-vm.spec.ts'), 'utf8');
const appSource = await readFile(resolve(import.meta.dirname, '../../../src/App.tsx'), 'utf8');
const applianceReadme = await readFile(resolve(import.meta.dirname, '../README.md'), 'utf8');
const buildJob = job('build_test');
const publishJob = job('publish');

describe('native v86 PGO publication workflow', () => {
  it('uses the checked-in generate, browser-training, merge, and use contracts', () => {
    expect(buildJob).toContain('timeout-minutes: 360');
    expect(step('Build the instrumented native appliance')).toContain('ANYCAST_PGO_MODE: generate');

    const training = step('Train BIRD and FRR in the native browser lab');
    expect(training).toContain("ANYCAST_LAB_COLLECT_PGO: '1'");
    expect(training).toContain('ANYCAST_LAB_PGO_RAW_DIR: ${{ env.PGO_RAW_DIR }}');
    expect(training).toContain('bunx playwright test e2e/native-vm.spec.ts');
    expect(training).toContain("if: steps.pgo_profile_cache.outputs.cache-hit != 'true'");
    expect(training).not.toContain('github.event_name');

    const merge = step('Merge and seal the trained PGO profiles');
    expect(merge).toContain('pgo-profile-set.mjs merge');
    expect(merge).toContain('--build-output appliances/v86/.work/output');
    expect(merge).toContain('--bird-archive "$PGO_RAW_DIR/bird-native.tar"');
    expect(merge).toContain('--frr-archive "$PGO_RAW_DIR/frr-native.tar"');
    expect(merge).toContain('--evidence "$PGO_RAW_DIR/training-evidence.json"');
    expect(merge).toContain('--manifest appliances/v86/dist/manifest.json');
    expect(applianceReadme).toContain('--evidence appliances/v86/.work/pgo/raw/training-evidence.json');
    expect(applianceReadme).toContain('--manifest appliances/v86/dist/manifest.json');

    const optimized = step('Build the optimized native appliance');
    expect(optimized).toContain('ANYCAST_PGO_MODE: use');
    expect(optimized).toContain('ANYCAST_PGO_PROFILE_DIR: ${{ env.PGO_PROFILE_DIR }}');
    expect(optimized).toContain('set -euo pipefail');
    expect(optimized).toContain('./appliances/v86/scripts/build-image.sh 2>&1 | tee "$log"');
    expect(optimized).toContain("grep -Eiq 'hash mismatch|Wbackend-plugin|profile is cold'");
    expect(step('Verify the optimized native bundle and profile provenance'))
      .toContain('manifest.pgo.profileSetBuildKey !== process.env.EXPECTED_PROFILE_BUILD_KEY');
  });

  it('enables the browser PGO bridge only in the instrumented lab build', () => {
    const instrumentedLab = step('Build the instrumented lab');
    expect(instrumentedLab).toContain("VITE_ANYCAST_LAB_PGO_BRIDGE: '1'");
    expect(instrumentedLab).toContain('run: bun run build:required');

    const finalLab = step('Build the final lab');
    expect(finalLab).not.toContain('VITE_ANYCAST_LAB_PGO_BRIDGE');
    const training = step('Train BIRD and FRR in the native browser lab');
    expect(training).toContain("VITE_ANYCAST_LAB_PGO_BRIDGE: '1'");
    expect(step('Run the final native browser test')).not.toContain('VITE_ANYCAST_LAB_PGO_BRIDGE');
    expect(workflow.match(/VITE_ANYCAST_LAB_PGO_BRIDGE/g)).toHaveLength(2);

    expect(appSource).toContain("import.meta.env.VITE_ANYCAST_LAB_PGO_BRIDGE === '1'");
    expect(appSource).toMatch(/__anycastPgo\s*=\s*\{\s*enabled:\s*true/s);
    expect(appSource).toContain('attachPgoBridgeEngine(engine)');
    expect(appSource).toContain('detachPgoBridgeEngine(native)');
    expect(appSource).toContain('bridge?.enabled !== true');
    expect(appSource).toContain('delete bridge.engine');

    const nativeEngineCreation = appSource.indexOf('const engine = new NativeLabEngine');
    const bridgeAttachment = appSource.indexOf('attachPgoBridgeEngine(engine)', nativeEngineCreation);
    expect(nativeEngineCreation).toBeGreaterThan(-1);
    expect(appSource.match(/new NativeLabEngine/g)).toHaveLength(1);
    expect(bridgeAttachment).toBeGreaterThan(nativeEngineCreation);
    expect(appSource.indexOf('nativeEngineRef.current = engine', nativeEngineCreation))
      .toBeLessThan(bridgeAttachment);
    expect(nativeVmSpec).toContain("test('does not expose the CI-only PGO bridge in an ordinary build'");
    expect(nativeVmSpec).toContain("Object.hasOwn(globalThis, '__anycastPgo')");
  });

  it('uses only the build-gated PGO bridge and fails closed when it is absent', () => {
    expect(nativeVmSpec).not.toContain('/src/native/engine.ts');
    expect(nativeVmSpec).not.toContain('src/native/engine.ts');
    expect(nativeVmSpec).not.toMatch(/\bimport\s*\(/);

    const bridge = sourceFunction(nativeVmSpec, 'async function installPgoBridge');
    expect(bridge).toContain('__anycastPgo');
    expect(bridge).toContain('enabled !== true');
    expect(bridge).toMatch(/throw new Error\([^)]*PGO bridge/s);
    expect(bridge).toContain('delete bridge.engine');
    expect(bridge).toContain('delete bridge.profiles');
  });

  it('restores only an exact trusted master profile set and trains every cache miss, including tags', () => {
    const masterOnly = "if: github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/master'";
    const trustedWrite = "github.ref == 'refs/heads/master' && github.event_name == 'workflow_dispatch'";
    const profileRestore = step('Restore the trusted PGO profile set');
    expect(profileRestore).toContain(masterOnly);
    expect(profileRestore).toContain('uses: actions/cache/restore@');
    expect(profileRestore).toContain(
      'key: native-v86-pgo-profiles-v1-${{ runner.os }}-${{ runner.arch }}-${{ steps.pgo_context.outputs.digest }}',
    );
    expect(profileRestore).not.toContain('restore-keys:');

    const profileSave = step('Save the verified PGO profile set');
    expect(profileSave).toContain('uses: actions/cache/save@');
    expect(profileSave).toContain(trustedWrite);
    expect(profileSave).toContain("steps.pgo_profile_cache.outputs.cache-hit != 'true'");
    expect(profileSave).toContain(
      'key: native-v86-pgo-profiles-v1-${{ runner.os }}-${{ runner.arch }}-${{ steps.pgo_context.outputs.digest }}',
    );

    const finalRestore = step('Restore the verified final native bundle');
    expect(finalRestore).toContain(masterOnly);
    expect(finalRestore).not.toContain('restore-keys:');
    expect(finalRestore).toContain(
      '${{ steps.appliance_inputs.outputs.digest }}-${{ steps.pgo_profiles.outputs.build_key }}',
    );
    expect(workflow.match(new RegExp(escapeRegex(masterOnly), 'g'))).toHaveLength(2);

    const trainingCcache = step('Restore the Buildroot compiler cache for training');
    expect(trainingCcache).toContain(trustedWrite);
    expect(trainingCcache).toContain("steps.pgo_profile_cache.outputs.cache-hit != 'true'");
    expect(trainingCcache).toContain('native-v86-ccache-v1-${{ runner.os }}-${{ runner.arch }}-');
    const optimizedCcache = step('Restore the Buildroot compiler cache for the optimized build');
    expect(optimizedCcache).toContain(trustedWrite);
    expect(optimizedCcache).toContain("steps.pgo_profile_cache.outputs.cache-hit == 'true'");
    expect(optimizedCcache).toContain("steps.final_bundle_cache.outputs.cache-hit != 'true'");
    expect(optimizedCcache).toContain('native-v86-ccache-v1-${{ runner.os }}-${{ runner.arch }}-');
    expect(workflow.split(
      '            native-v86-ccache-v1-${{ runner.os }}-${{ runner.arch }}-\n',
    )).toHaveLength(3);
    expect(step('Save the verified Buildroot compiler cache')).toContain(trustedWrite);
    expect(step('Save the verified final native bundle')).toContain(trustedWrite);
    expect(step('Restore pinned source downloads')).not.toContain('refs/heads/master');
  });

  it('publishes split caches only after mandatory final verification and before unrelated E2E', () => {
    const mandatory = [
      'Build the final lab',
      'Run the TypeScript check',
      'Run lint',
      'Run unit tests',
      'Run the native BIRD ABI harness',
      'Run the final native browser test',
    ];
    for (let index = 1; index < mandatory.length; index += 1) {
      expect(stepIndex(mandatory[index])).toBeGreaterThan(stepIndex(mandatory[index - 1]));
    }

    const saveSteps = [
      'Save verified source downloads',
      'Save the verified Buildroot compiler cache',
      'Save the verified PGO profile set',
      'Save the verified final native bundle',
    ];
    const finalNative = stepIndex('Run the final native browser test');
    const remainingE2e = stepIndex('Run the remaining browser tests');
    for (const name of saveSteps) {
      expect(step(name)).toContain('uses: actions/cache/save@');
      expect(stepIndex(name)).toBeGreaterThan(finalNative);
      expect(stepIndex(name)).toBeLessThan(remainingE2e);
    }
    expect(step('Restore pinned source downloads')).toContain('uses: actions/cache/restore@');
    expect(step('Restore the Buildroot compiler cache for training')).toContain('uses: actions/cache/restore@');
    expect(step('Restore the Buildroot compiler cache for the optimized build'))
      .toContain('uses: actions/cache/restore@');

    const profileArtifact = step('Upload the validated PGO profile set');
    expect(profileArtifact).toContain('appliances/v86/.work/pgo/profiles/profile-set.json');
    expect(profileArtifact).toContain('appliances/v86/.work/pgo/profiles/bird.profdata');
    for (const profile of [
      'frr-libfrr.profdata',
      'frr-libmgmt-be-nb.profdata',
      'frr-bgpd.profdata',
      'frr-zebra.profdata',
      'frr-ospfd.profdata',
    ]) {
      expect(profileArtifact).toContain(`appliances/v86/.work/pgo/profiles/${profile}`);
    }
    expect(profileArtifact).toContain('appliances/v86/.work/pgo/profiles/training-evidence.json');
    expect(profileArtifact).not.toContain('appliances/v86/.work/pgo/raw/training-evidence.json');
    expect(profileArtifact).toContain('retention-days: 30');
    expect(stepIndex('Upload the validated PGO profile set')).toBeGreaterThan(finalNative);
    expect(stepIndex('Upload the validated PGO profile set')).toBeLessThan(remainingE2e);
  });

  it('does not repeat the final native test or make a publish artifact available before all tests pass', () => {
    const nativeCommands = buildJob.match(/bunx playwright test e2e\/native-vm\.spec\.ts/g) ?? [];
    expect(nativeCommands).toHaveLength(2); // instrumented training and final optimized acceptance
    expect(step('Run the remaining browser tests')).toContain("! -name 'native-vm.spec.ts'");
    expect(stepIndex('Verify the release bundle')).toBeGreaterThan(stepIndex('Run the remaining browser tests'));
    expect(stepIndex('Upload the verified workflow artifact')).toBeGreaterThan(stepIndex('Verify the release bundle'));

    expect(publishJob).toMatch(/^ {4}needs: build_test$/m);
    expect(publishJob).toContain('name: native-v86-${{ needs.build_test.outputs.manifest_digest }}');
    expect(buildJob).toContain('manifest_digest: ${{ steps.release.outputs.manifest_digest }}');
    expect(step('Verify the instrumented native bundle')).not.toContain('--require-pgo-use');
    expect(step('Verify the optimized native bundle and profile provenance')).toContain('--require-pgo-use');
    expect(step('Verify the release bundle')).toContain('--require-pgo-use');
    expect(publishJob).toContain('--require-pgo-use --require-filesystem appliances/v86/dist/manifest.json');
    expect(buildJob.match(/--require-filesystem appliances\/v86\/dist\/manifest\.json/g))
      .toHaveLength(3);
    expect(workflow.match(/--require-pgo-use/g)).toHaveLength(3);
    expect(workflow).not.toContain('actions/attest');
  });

  it('carries every verified immutable filesystem layer into the isolated publish job', () => {
    const upload = step('Upload the verified workflow artifact');
    for (const layer of ['complete', 'base', 'bird', 'frr', 'toolbox']) {
      expect(upload).toContain(`appliances/v86/dist/rootfs-${layer}.squashfs`);
    }
    expect(upload).toContain('if-no-files-found: error');
    expect(upload).toContain('compression-level: 0');
  });

  it('requires a concrete native build identity before PGO training can run or write evidence', () => {
    const identityCheck = nativeVmSpec.indexOf(
      'const pgoNativeIdentity = collectPgo ? requirePgoNativeIdentity(nativeStatus) : null;',
    );
    expect(identityCheck).toBeGreaterThan(-1);
    expect(identityCheck).toBeLessThan(nativeVmSpec.indexOf('if (collectPgo) await installPgoBridge(page);'));
    expect(nativeVmSpec).toContain('/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(status.buildId)');
    expect(nativeVmSpec).toContain('/^[a-f0-9]{64}$/.test(status.manifestSha256)');
    expect(nativeVmSpec).toContain('buildId: pgoNativeIdentity.buildId');
    expect(nativeVmSpec).toContain('manifestSha256: pgoNativeIdentity.manifestSha256');
    expect(nativeVmSpec).not.toContain('nativeStatus?.buildId');
    expect(nativeVmSpec).not.toContain('nativeStatus?.manifestSha256');
  });

  it('makes route churn and full BGP/OSPF link-loss recovery mandatory before collection', () => {
    expect(nativeVmSpec).toContain('hold time 6;');
    expect(nativeVmSpec).toContain('neighbor 192.0.2.0 timers 2 6');
    expect(nativeVmSpec).toContain("birdc disable training_routes && sleep 1 && birdc enable training_routes");
    expect(nativeVmSpec).toContain('ROUTE-WITHDRAWN-READY');
    expect(nativeVmSpec).toContain('ROUTE-RESTORED-READY');
    expect(nativeVmSpec).toContain('BIRD-OSPF-RECOVERY-READY');
    expect(nativeVmSpec).toContain('FRR-OSPF-RECOVERY-READY');
    const linkDown = nativeVmSpec.indexOf("setLinkState('bird-frr-link', 'down')");
    const withdrawn = nativeVmSpec.indexOf('ROUTE-WITHDRAWN-READY');
    const linkUp = nativeVmSpec.indexOf("setLinkState('bird-frr-link', 'up')");
    const restored = nativeVmSpec.indexOf('ROUTE-RESTORED-READY');
    expect(linkDown).toBeGreaterThan(-1);
    expect(withdrawn).toBeGreaterThan(linkDown);
    expect(linkUp).toBeGreaterThan(withdrawn);
    expect(restored).toBeGreaterThan(linkUp);
  });
});

function job(id) {
  const marker = `\n  ${id}:\n`;
  const start = workflow.indexOf(marker);
  if (start < 0) throw new Error(`Workflow job is missing: ${id}`);
  const bodyStart = start + 1;
  const following = /^ {2}[A-Za-z0-9_-]+:\s*$/gm;
  following.lastIndex = bodyStart + marker.length;
  const next = following.exec(workflow);
  return workflow.slice(bodyStart, next?.index ?? workflow.length);
}

function step(name) {
  const marker = `      - name: ${name}\n`;
  const start = buildJob.indexOf(marker);
  if (start < 0) throw new Error(`Workflow step is missing: ${name}`);
  const next = buildJob.indexOf('\n      - name: ', start + marker.length);
  return buildJob.slice(start, next < 0 ? buildJob.length : next);
}

function stepIndex(name) {
  const index = buildJob.indexOf(`      - name: ${name}\n`);
  if (index < 0) throw new Error(`Workflow step is missing: ${name}`);
  return index;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sourceFunction(source, declaration) {
  const start = source.indexOf(declaration);
  if (start < 0) throw new Error(`Source function is missing: ${declaration}`);
  const next = source.indexOf('\nasync function ', start + declaration.length);
  return source.slice(start, next < 0 ? source.length : next);
}
