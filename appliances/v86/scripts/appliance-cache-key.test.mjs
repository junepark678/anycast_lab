// @vitest-environment node
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';

import {
  APPLIANCE_CACHE_INPUTS,
  DAEMON_CACHE_INPUTS,
  computeApplianceCacheKey,
  computeDaemonCacheKey,
} from './appliance-cache-key.mjs';

const temporaryDirectories = [];

async function createFixture() {
  const root = await mkdtemp(resolve(tmpdir(), 'anycast-appliance-cache-key-'));
  temporaryDirectories.push(root);
  for (const input of APPLIANCE_CACHE_INPUTS) {
    if (input === 'buildroot') {
      await mkdir(resolve(root, input), { recursive: true });
      await writeFile(resolve(root, input, 'defconfig'), 'CONFIG_ROUTER=y\n');
      continue;
    }
    const path = resolve(root, input);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${input}\n`);
  }
  for (const input of [
    'buildroot/configs/anycast_lab_v86_defconfig',
    'buildroot/external.mk',
    'buildroot/package/anycast-clang-toolchain/anycast-clang-toolchain.mk',
    'buildroot/patches/bird/0001.patch',
    'buildroot/patches/frr/0001.patch',
  ]) {
    const path = resolve(root, input);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${input}\n`);
  }
  await chmod(resolve(root, 'scripts/build-image.sh'), 0o755);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

it('is deterministic and returns a lowercase SHA-256 digest', async () => {
  const root = await createFixture();
  const first = await computeApplianceCacheKey(root);
  const second = await computeApplianceCacheKey(root);
  expect(first).toMatch(/^[a-f0-9]{64}$/);
  expect(second).toBe(first);
});

it('changes for build input contents, paths, executable modes, and symlinks', async () => {
  const root = await createFixture();
  const original = await computeApplianceCacheKey(root);

  await writeFile(resolve(root, 'versions.env'), 'VERSION=2\n');
  const contentChanged = await computeApplianceCacheKey(root);
  expect(contentChanged).not.toBe(original);

  await writeFile(resolve(root, 'buildroot/new-input'), 'new\n');
  const pathChanged = await computeApplianceCacheKey(root);
  expect(pathChanged).not.toBe(contentChanged);

  await chmod(resolve(root, 'scripts/build-image.sh'), 0o644);
  const modeChanged = await computeApplianceCacheKey(root);
  expect(modeChanged).not.toBe(pathChanged);

  await symlink('defconfig', resolve(root, 'buildroot/config-link'));
  const symlinkAdded = await computeApplianceCacheKey(root);
  expect(symlinkAdded).not.toBe(modeChanged);
  await rm(resolve(root, 'buildroot/config-link'));
  await symlink('new-input', resolve(root, 'buildroot/config-link'));
  expect(await computeApplianceCacheKey(root)).not.toBe(symlinkAdded);
});

it('ignores release tooling and documentation that cannot affect the appliance bytes', async () => {
  const root = await createFixture();
  const original = await computeApplianceCacheKey(root);
  await writeFile(resolve(root, 'README.md'), 'documentation only\n');
  await writeFile(resolve(root, 'scripts/publish-oci.sh'), 'release only\n');
  expect(await computeApplianceCacheKey(root)).toBe(original);
});

it('reuses daemon objects across browser, supervisor, kernel, and rootfs-only changes', async () => {
  const root = await createFixture();
  const original = await computeDaemonCacheKey(root);
  const originalAppliance = await computeApplianceCacheKey(root);
  expect(original).toMatch(/^[a-f0-9]{64}$/);

  for (const [path, contents] of [
    ['src/App.tsx', 'export const App = null;\n'],
    ['e2e/native-vm.spec.ts', 'browser training only\n'],
    ['buildroot/package/anycast-labd/src/labd.c', 'supervisor only\n'],
    ['buildroot/board/linux.config', 'CONFIG_NET_NS=y\n'],
    ['buildroot/board/post-build.sh', 'rootfs packaging only\n'],
  ]) {
    const output = resolve(root, path);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, contents);
  }
  expect(await computeDaemonCacheKey(root)).toBe(original);
  expect(await computeApplianceCacheKey(root)).not.toBe(originalAppliance);
});

it('invalidates daemon objects for every declared compiler, source, and configuration input', async () => {
  const root = await createFixture();
  let previous = await computeDaemonCacheKey(root);
  for (const input of [
    'buildroot/configs/anycast_lab_v86_defconfig',
    'buildroot/external.mk',
    'buildroot/package/anycast-clang-toolchain/anycast-clang-toolchain.mk',
    'buildroot/patches/bird/0001.patch',
    'buildroot/patches/frr/0001.patch',
    'scripts/appliance-cache-key.mjs',
    'scripts/pgo-profile-set.mjs',
    'versions.env',
  ]) {
    const path = resolve(root, input);
    await writeFile(path, `${await readFile(path, 'utf8')}changed\n`);
    const changed = await computeDaemonCacheKey(root);
    expect(changed, input).not.toBe(previous);
    previous = changed;
  }
});

it('covers only the declared appliance build inputs', () => {
  expect(APPLIANCE_CACHE_INPUTS).toEqual([
    'artifact-manifest.template.json',
    'buildroot',
    'scripts/appliance-cache-key.mjs',
    'scripts/build-filesystem-layers.mjs',
    'scripts/build-filesystem-layers.sh',
    'scripts/build-image.sh',
    'scripts/filesystem-layout.mjs',
    'scripts/pgo-profile-set.mjs',
    'scripts/verify-manifest.mjs',
    'scripts/verify-optimized-daemons.sh',
    'scripts/verify-effective-config.mjs',
    'scripts/verify-rootfs-policy.sh',
    'versions.env',
  ]);
});

it('declares the bounded BIRD/FRR cache input surface explicitly', () => {
  expect(DAEMON_CACHE_INPUTS).toEqual([
    'buildroot/configs/anycast_lab_v86_defconfig',
    'buildroot/external.mk',
    'buildroot/package/anycast-clang-toolchain',
    'buildroot/patches/bird',
    'buildroot/patches/frr',
    'scripts/appliance-cache-key.mjs',
    'scripts/pgo-profile-set.mjs',
    'versions.env',
  ]);
});

it('keeps the checked-in Buildroot and Actions ccache policy enabled and bounded', async () => {
  const applianceRoot = resolve(import.meta.dirname, '..');
  const defconfig = await readFile(
    resolve(applianceRoot, 'buildroot/configs/anycast_lab_v86_defconfig'),
    'utf8',
  );
  expect(defconfig).toMatch(/^BR2_CCACHE=y$/m);
  expect(defconfig).toMatch(/^BR2_CCACHE_INITIAL_SETUP="--max-size=3G"$/m);
  expect(defconfig).toMatch(/^BR2_CCACHE_USE_BASEDIR=y$/m);

  const workflow = await readFile(
    resolve(applianceRoot, '../../.github/workflows/publish-native-v86.yml'),
    'utf8',
  );
  expect(workflow).toContain('path: appliances/v86/.work/ccache');
  expect(workflow).toContain('BR2_CCACHE_DIR: ${{ github.workspace }}/appliances/v86/.work/ccache');
  expect(workflow).toContain('native-v86-ccache-v1-${{ runner.os }}-${{ runner.arch }}-');
  expect(workflow).toContain('key: native-v86-downloads-${{ hashFiles(');
  expect(workflow).toContain('restore-keys: |\n            native-v86-downloads-');
  expect(workflow.match(/if: github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/master'/g))
    .toHaveLength(2);
});
