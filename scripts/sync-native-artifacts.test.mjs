// @vitest-environment node
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createFilesystemMetadata,
  FILESYSTEM_LAYER_DEFINITIONS,
} from '../appliances/v86/scripts/filesystem-layout.mjs';
import { PINNED_V86_MANIFEST_IDENTITY } from '../appliances/v86/scripts/verify-manifest.mjs';

const execute = promisify(execFile);
const temporaryDirectories = [];
const script = resolve(import.meta.dirname, 'sync-native-artifacts.mjs');

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function temporaryDirectory() {
  const directory = await mkdtemp(resolve(tmpdir(), 'anycast-native-sync-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function runSync(overrides) {
  const env = { ...process.env };
  delete env.ANYCAST_LAB_NATIVE_STATUS_URL;
  delete env.ANYCAST_LAB_REQUIRE_NATIVE;
  delete env.ANYCAST_LAB_NATIVE_MODE;
  Object.assign(env, overrides);
  return execute(process.execPath, [script], { env });
}

async function createBundle(directory) {
  await mkdir(directory, { recursive: true });
  const definitions = [
    ['v86-wasm', 'v86.wasm'],
    ['bios', 'seabios.bin'],
    ['vga-bios', 'vgabios.bin'],
    ['bzimage', 'router-bzimage.bin'],
  ];
  const artifacts = [];
  for (const [id, file] of definitions) {
    const bytes = Buffer.from(`sync:${id}`);
    await writeFile(resolve(directory, file), bytes);
    artifacts.push({ id, file, size: bytes.byteLength, sha256: digest(bytes) });
  }
  const filesystemArtifacts = [];
  for (const { id, file } of FILESYSTEM_LAYER_DEFINITIONS) {
    const bytes = Buffer.from(`sync-filesystem:${id}`);
    await writeFile(resolve(directory, file), bytes);
    filesystemArtifacts.push({ id, size: bytes.byteLength, sha256: digest(bytes) });
  }
  const filesystem = createFilesystemMetadata(filesystemArtifacts);
  const manifestBytes = Buffer.from(`${JSON.stringify({
    ...PINNED_V86_MANIFEST_IDENTITY,
    pgo: {
      mode: 'use',
      contextSha256: '1'.repeat(64),
      profileSetBuildKey: '2'.repeat(64),
      birdProfileSha256: '3'.repeat(64),
      frrProfileSha256: '4'.repeat(64),
    },
    machine: {
      model: 'shared-namespaces',
      memoryBytes: 128 * 1024 * 1024,
      vgaMemoryBytes: 2 * 1024 * 1024,
      trunkMtu: 65_535,
    },
    filesystem,
    artifacts,
  }, null, 2)}\n`);
  await writeFile(resolve(directory, 'manifest.json'), manifestBytes);
  await writeFile(resolve(directory, 'manifest.sha256'), `${digest(manifestBytes)}  manifest.json\n`);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('sync-native-artifacts deployment modes', () => {
  it('writes only a small pointer for an external native release origin', async () => {
    const root = await temporaryDirectory();
    const output = resolve(root, 'runtime');
    await runSync({
      ANYCAST_LAB_RUNTIME_OUTPUT_DIR: output,
      ANYCAST_LAB_NATIVE_ARTIFACT_DIR: resolve(root, 'absent'),
      ANYCAST_LAB_NATIVE_STATUS_URL: 'https://assets.example/v86/channels/stable/status.json',
    });

    await expect(readFile(resolve(output, 'status.json'), 'utf8')).resolves.toContain(
      'https://assets.example/v86/channels/stable/status.json',
    );
    await expect(access(resolve(output, 'v86'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects an insecure external URL before replacing existing output', async () => {
    const root = await temporaryDirectory();
    const output = resolve(root, 'runtime');
    await mkdir(output);
    await writeFile(resolve(output, 'sentinel'), 'keep');

    await expect(runSync({
      ANYCAST_LAB_RUNTIME_OUTPUT_DIR: output,
      ANYCAST_LAB_NATIVE_ARTIFACT_DIR: resolve(root, 'absent'),
      ANYCAST_LAB_NATIVE_STATUS_URL: 'http://assets.example/status.json',
    })).rejects.toThrow('must use HTTPS');
    await expect(readFile(resolve(output, 'sentinel'), 'utf8')).resolves.toBe('keep');
  });

  it('emits SIM-only metadata when artifacts are absent unless native is required', async () => {
    const root = await temporaryDirectory();
    const output = resolve(root, 'runtime');
    const absent = resolve(root, 'absent');
    await runSync({
      ANYCAST_LAB_RUNTIME_OUTPUT_DIR: output,
      ANYCAST_LAB_NATIVE_ARTIFACT_DIR: absent,
    });
    await expect(readFile(resolve(output, 'status.json'), 'utf8')).resolves.toContain('"nativeV86": false');

    await expect(runSync({
      ANYCAST_LAB_RUNTIME_OUTPUT_DIR: output,
      ANYCAST_LAB_NATIVE_ARTIFACT_DIR: absent,
      ANYCAST_LAB_REQUIRE_NATIVE: '1',
    })).rejects.toThrow('Native runtime artifacts are required');
  });

  it('keeps production external-only even when a cached local bundle exists', async () => {
    const root = await temporaryDirectory();
    const source = resolve(root, 'bundle');
    const output = resolve(root, 'runtime');
    await createBundle(source);
    await runSync({
      ANYCAST_LAB_RUNTIME_OUTPUT_DIR: output,
      ANYCAST_LAB_NATIVE_ARTIFACT_DIR: source,
      ANYCAST_LAB_NATIVE_MODE: 'external',
    });

    await expect(readFile(resolve(output, 'status.json'), 'utf8')).resolves.toContain('"nativeV86": false');
    await expect(access(resolve(output, 'v86'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('verifies and copies only the allowlisted local bundle files', async () => {
    const root = await temporaryDirectory();
    const source = resolve(root, 'bundle');
    const output = resolve(root, 'runtime');
    await createBundle(source);
    await writeFile(resolve(source, 'not-deployed.txt'), 'no');
    await runSync({
      ANYCAST_LAB_RUNTIME_OUTPUT_DIR: output,
      ANYCAST_LAB_NATIVE_ARTIFACT_DIR: source,
      ANYCAST_LAB_NATIVE_MODE: 'local',
      ANYCAST_LAB_REQUIRE_NATIVE: '1',
    });

    const status = JSON.parse(await readFile(resolve(output, 'status.json'), 'utf8'));
    expect(status).toMatchObject({ nativeV86: true, buildId: 'anycastlab-v86-br2026.02.3-r4' });
    await expect(access(resolve(output, 'v86/router-bzimage.bin'))).resolves.toBeUndefined();
    for (const layer of FILESYSTEM_LAYER_DEFINITIONS) {
      await expect(access(resolve(output, 'v86', layer.file))).resolves.toBeUndefined();
    }
    await expect(access(resolve(output, 'v86/not-deployed.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a local bundle without the required filesystem before replacing output', async () => {
    const root = await temporaryDirectory();
    const source = resolve(root, 'bundle');
    const output = resolve(root, 'runtime');
    await createBundle(source);
    const manifestPath = resolve(source, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    delete manifest.filesystem;
    const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(manifestPath, bytes);
    await writeFile(resolve(source, 'manifest.sha256'), `${digest(bytes)}  manifest.json\n`);
    await mkdir(output);
    await writeFile(resolve(output, 'sentinel'), 'keep');

    await expect(runSync({
      ANYCAST_LAB_RUNTIME_OUTPUT_DIR: output,
      ANYCAST_LAB_NATIVE_ARTIFACT_DIR: source,
      ANYCAST_LAB_NATIVE_MODE: 'local',
      ANYCAST_LAB_REQUIRE_NATIVE: '1',
    })).rejects.toThrow('requires filesystem layer metadata');
    await expect(readFile(resolve(output, 'sentinel'), 'utf8')).resolves.toBe('keep');
  });

  it('rejects a corrupt filesystem blob before replacing existing runtime output', async () => {
    const root = await temporaryDirectory();
    const source = resolve(root, 'bundle');
    const output = resolve(root, 'runtime');
    await createBundle(source);
    await writeFile(resolve(source, 'rootfs-complete.squashfs'), 'corrupt');
    await mkdir(output);
    await writeFile(resolve(output, 'sentinel'), 'keep');

    await expect(runSync({
      ANYCAST_LAB_RUNTIME_OUTPUT_DIR: output,
      ANYCAST_LAB_NATIVE_ARTIFACT_DIR: source,
      ANYCAST_LAB_NATIVE_MODE: 'local',
      ANYCAST_LAB_REQUIRE_NATIVE: '1',
    })).rejects.toThrow('Filesystem layer verification failed: complete');
    await expect(readFile(resolve(output, 'sentinel'), 'utf8')).resolves.toBe('keep');
  });

});
