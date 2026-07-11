// @vitest-environment node
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';

import {
  APPLIANCE_CACHE_INPUTS,
  computeApplianceCacheKey,
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

it('covers only the declared appliance build inputs', () => {
  expect(APPLIANCE_CACHE_INPUTS).toEqual([
    'artifact-manifest.template.json',
    'buildroot',
    'scripts/appliance-cache-key.mjs',
    'scripts/build-image.sh',
    'scripts/verify-manifest.mjs',
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
  expect(defconfig).toMatch(/^BR2_CCACHE_INITIAL_SETUP="--max-size=1G"$/m);
  expect(defconfig).toMatch(/^BR2_CCACHE_USE_BASEDIR=y$/m);

  const workflow = await readFile(
    resolve(applianceRoot, '../../.github/workflows/publish-native-v86.yml'),
    'utf8',
  );
  expect(workflow).toContain('path: appliances/v86/.work/ccache');
  expect(workflow).toContain('BR2_CCACHE_DIR: ${{ github.workspace }}/appliances/v86/.work/ccache');
  expect(workflow).toContain('native-v86-ccache-v1-${{ runner.os }}-${{ runner.arch }}-');
});
