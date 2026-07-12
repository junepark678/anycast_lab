#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { validateFilesystemMetadata } from './filesystem-layout.mjs';

export const MAX_RELEASE_ARTIFACT_BYTES = 512 * 1024 * 1024;

export const PINNED_V86_MANIFEST_IDENTITY = Object.freeze({
  schemaVersion: 1,
  imageId: 'anycast-lab-router',
  buildId: 'anycastlab-v86-br2026.02.3-r4',
  sourceDateEpoch: 1_781_643_617,
  buildroot: Object.freeze({
    version: '2026.02.3',
    sha256: '5a59e7501b0b4ec52c41f4bfa79412320e0b37eae5f719605a258e8d0c6fc7fb',
  }),
  v86: Object.freeze({
    packageVersion: '0.5.424',
    commit: '2f1346b0e7d88d4cbbbcc05fe15b4e369c3de23f',
  }),
  daemons: Object.freeze({
    bird: '2.15.1',
    frr: '10.5.1',
  }),
  toolchain: Object.freeze({
    scope: 'bird-and-frr',
    compiler: 'clang',
    compilerVersion: '21.1.8',
    linker: 'lld',
    optimization: 'O3',
    lto: 'thin',
  }),
});

const EXPECTED_ARTIFACTS = new Map([
  ['v86-wasm', 'v86.wasm'],
  ['bios', 'seabios.bin'],
  ['vga-bios', 'vgabios.bin'],
  ['bzimage', 'router-bzimage.bin'],
]);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function requireRecord(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requirePowerOfTwo(value, label) {
  const integer = requirePositiveInteger(value, label);
  if (!Number.isInteger(Math.log2(integer))) throw new Error(`${label} must be a power of two`);
  return integer;
}

/**
 * Verify the complete deployable v86 bundle and return its trusted metadata.
 * Only fixed, flat artifact names are accepted so a manifest cannot make the
 * publisher or deployment sync read arbitrary files.
 */
export async function verifyV86ArtifactBundle(
  manifestInput,
  {
    expectedManifestSha256,
    maxArtifactBytes = MAX_RELEASE_ARTIFACT_BYTES,
    requiredFilesystem = false,
    requiredPgoMode,
  } = {},
) {
  const manifestPath = resolve(manifestInput);
  const manifestBytes = await readFile(manifestPath);
  const manifestSha256 = sha256(manifestBytes);
  if (expectedManifestSha256 !== undefined && manifestSha256 !== expectedManifestSha256) {
    throw new Error(`Manifest digest mismatch: expected ${expectedManifestSha256}, received ${manifestSha256}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch (error) {
    throw new Error('Native artifact manifest is not valid JSON', { cause: error });
  }
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    throw new Error('Native artifact manifest must be an object');
  }
  if (
    manifest.schemaVersion !== PINNED_V86_MANIFEST_IDENTITY.schemaVersion ||
    manifest.imageId !== PINNED_V86_MANIFEST_IDENTITY.imageId ||
    manifest.buildId !== PINNED_V86_MANIFEST_IDENTITY.buildId ||
    manifest.sourceDateEpoch !== PINNED_V86_MANIFEST_IDENTITY.sourceDateEpoch
  ) {
    throw new Error('Unexpected appliance manifest identity');
  }
  const buildroot = requireRecord(manifest.buildroot, 'buildroot');
  if (
    buildroot.version !== PINNED_V86_MANIFEST_IDENTITY.buildroot.version ||
    buildroot.sha256 !== PINNED_V86_MANIFEST_IDENTITY.buildroot.sha256
  ) {
    throw new Error('Unexpected Buildroot release metadata');
  }
  const v86 = requireRecord(manifest.v86, 'v86');
  if (
    v86.packageVersion !== PINNED_V86_MANIFEST_IDENTITY.v86.packageVersion ||
    v86.commit !== PINNED_V86_MANIFEST_IDENTITY.v86.commit
  ) {
    throw new Error('Unexpected v86 release metadata');
  }
  const daemons = requireRecord(manifest.daemons, 'daemons');
  if (
    daemons.bird !== PINNED_V86_MANIFEST_IDENTITY.daemons.bird ||
    daemons.frr !== PINNED_V86_MANIFEST_IDENTITY.daemons.frr
  ) {
    throw new Error('Unexpected routing daemon release metadata');
  }
  const toolchain = requireRecord(manifest.toolchain, 'toolchain');
  for (const [name, expected] of Object.entries(PINNED_V86_MANIFEST_IDENTITY.toolchain)) {
    if (toolchain[name] !== expected) throw new Error('Unexpected routing daemon toolchain metadata');
  }
  const pgo = requireRecord(manifest.pgo, 'pgo');
  if (!['none', 'generate', 'use'].includes(pgo.mode)) throw new Error('Invalid PGO mode');
  requireSha256(pgo.contextSha256, 'pgo.contextSha256');
  const profileFields = ['profileSetBuildKey', 'birdProfileSha256', 'frrProfileSha256'];
  if (pgo.mode === 'use') {
    for (const field of profileFields) requireSha256(pgo[field], `pgo.${field}`);
  } else if (profileFields.some((field) => pgo[field] !== null)) {
    throw new Error('Only PGO use mode may identify optimized profiles');
  }
  if (requiredPgoMode !== undefined && pgo.mode !== requiredPgoMode) {
    throw new Error(`Native bundle requires PGO mode ${requiredPgoMode}; received ${pgo.mode}`);
  }
  const machine = requireRecord(manifest.machine, 'machine');
  if (machine.model !== 'shared-namespaces') {
    throw new Error('machine.model must identify the shared-namespaces appliance contract');
  }
  const memoryBytes = requirePowerOfTwo(machine.memoryBytes, 'machine.memoryBytes');
  requirePowerOfTwo(machine.vgaMemoryBytes, 'machine.vgaMemoryBytes');
  const trunkMtu = requirePositiveInteger(machine.trunkMtu, 'machine.trunkMtu');
  if (trunkMtu < 1504 || trunkMtu > 65_535) {
    throw new Error('machine.trunkMtu must be between 1504 and 65535');
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length !== EXPECTED_ARTIFACTS.size) {
    throw new Error(`Expected exactly ${EXPECTED_ARTIFACTS.size} native artifacts`);
  }

  const remaining = new Map(EXPECTED_ARTIFACTS);
  const artifacts = [];
  for (const artifact of manifest.artifacts) {
    if (typeof artifact !== 'object' || artifact === null || typeof artifact.id !== 'string') {
      throw new Error('Invalid native artifact entry');
    }
    const expectedFile = remaining.get(artifact.id);
    if (expectedFile === undefined) throw new Error(`Unexpected or duplicate artifact ${artifact.id}`);
    if (artifact.file !== expectedFile || basename(artifact.file) !== artifact.file) {
      throw new Error(`Artifact ${artifact.id} must use the fixed filename ${expectedFile}`);
    }
    remaining.delete(artifact.id);
    const declaredSize = requirePositiveInteger(artifact.size, `${artifact.id}.size`);
    if (declaredSize > maxArtifactBytes) {
      throw new Error(`Artifact ${artifact.id} exceeds the ${maxArtifactBytes}-byte release safety limit`);
    }
    if (typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.sha256)) {
      throw new Error(`Artifact ${artifact.id} has an invalid SHA-256 digest`);
    }

    const path = resolve(dirname(manifestPath), artifact.file);
    const bytes = await readFile(path);
    const digest = sha256(bytes);
    if (bytes.byteLength !== declaredSize || digest !== artifact.sha256) {
      throw new Error(`Artifact verification failed: ${artifact.id}`);
    }
    artifacts.push({
      id: artifact.id,
      file: artifact.file,
      path,
      size: bytes.byteLength,
      sha256: digest,
    });
  }
  if (remaining.size !== 0) throw new Error(`Missing artifacts: ${[...remaining.keys()].join(', ')}`);

  let filesystem;
  const filesystemLayers = [];
  if (manifest.filesystem === undefined) {
    if (requiredFilesystem) throw new Error('Native bundle requires filesystem layer metadata');
  } else {
    filesystem = validateFilesystemMetadata(manifest.filesystem);
    for (const layer of filesystem.layers) {
      if (layer.size > maxArtifactBytes) {
        throw new Error(`Filesystem layer ${layer.id} exceeds the ${maxArtifactBytes}-byte release safety limit`);
      }
      const path = resolve(dirname(manifestPath), layer.file);
      const bytes = await readFile(path);
      const layerDigest = sha256(bytes);
      if (bytes.byteLength !== layer.size || layerDigest !== layer.sha256) {
        throw new Error(`Filesystem layer verification failed: ${layer.id}`);
      }
      filesystemLayers.push({
        ...layer,
        path,
        size: bytes.byteLength,
        sha256: layerDigest,
      });
    }
  }

  return {
    manifestPath,
    manifest,
    manifestBytes,
    manifestSha256,
    memoryBytes,
    artifacts,
    filesystem,
    filesystemLayers,
  };
}

function requireSha256(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  const arguments_ = process.argv.slice(2);
  const requirePgoUse = arguments_.includes('--require-pgo-use');
  const requireFilesystem = arguments_.includes('--require-filesystem');
  const manifestPath = arguments_.find((value) => !value.startsWith('--')) ?? 'dist/manifest.json';
  const result = await verifyV86ArtifactBundle(manifestPath, {
    ...(requirePgoUse ? { requiredPgoMode: 'use' } : {}),
    requiredFilesystem: requireFilesystem,
  });
  process.stdout.write(`${result.manifestSha256}  manifest.json\n`);
}
