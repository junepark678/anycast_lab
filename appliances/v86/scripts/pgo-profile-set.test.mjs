// @vitest-environment node
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { APPLIANCE_CACHE_INPUTS } from './appliance-cache-key.mjs';
import {
  MAX_PGO_PROFILE_BYTES,
  MAX_PGO_ARCHIVE_BYTES,
  MAX_PGO_EVIDENCE_BYTES,
  MAX_PGO_RAW_PROFILES,
  PGO_PROFILE_FILES,
  PGO_PROFILE_SET_FILE,
  PGO_TRAINING_EVIDENCE_FILE,
  PGO_TRAINING_WORKLOAD,
  PGO_TRAINING_INPUTS,
  assertCoveredProfileFunction,
  createPgoContext,
  mergePgoProfileArchives,
  parsePgoUstar,
  sealPgoProfileSet,
  validatePgoProfileSet,
} from './pgo-profile-set.mjs';

const temporaryDirectories = [];
const encoder = new TextEncoder();

const versions = `BUILDROOT_VERSION=2026.02.3
BUILDROOT_SHA256=${'1'.repeat(64)}
BIRD_VERSION=2.15.1
FRR_VERSION=10.5.1
IMAGE_BUILD_ID=anycastlab-v86-br2026.02.3-r2
LLVM_VERSION=21.1.8
LLVM_SOURCE_SHA256=${'2'.repeat(64)}
LLVM_THIRD_PARTY_SHA256=${'3'.repeat(64)}
LLVM_CMAKE_SOURCE_SHA256=${'4'.repeat(64)}
CLANG_SOURCE_SHA256=${'5'.repeat(64)}
LLD_SOURCE_SHA256=${'6'.repeat(64)}
COMPILER_RT_SOURCE_SHA256=${'7'.repeat(64)}
`;

async function fixture() {
  const base = await mkdtemp(resolve(tmpdir(), 'anycast-pgo-profile-set-'));
  temporaryDirectories.push(base);
  const root = resolve(base, 'lab/appliances/v86');
  for (const input of APPLIANCE_CACHE_INPUTS) {
    const path = resolve(root, input);
    if (input === 'buildroot') {
      await mkdir(path, { recursive: true });
      await writeFile(resolve(path, 'external.mk'), 'BUILD := router\n');
    } else {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, input === 'versions.env' ? versions : `${input}\n`);
    }
  }
  for (const input of PGO_TRAINING_INPUTS) {
    const path = resolve(root, input);
    if (input === '../../src') {
      await mkdir(path, { recursive: true });
      await writeFile(resolve(path, 'fixture.ts'), 'export const trainingFixture = true;\n');
    } else {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${input}\n`);
    }
  }
  const profiles = resolve(base, 'profiles');
  await mkdir(profiles);
  return { base, root, profiles };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('PGO context and sealed profile set', () => {
  it('binds profiles to pinned tools, target, flags, appliance inputs, and training inputs', async () => {
    const { root } = await fixture();
    const first = await createPgoContext(root);
    const second = await createPgoContext(root);
    expect(second).toEqual(first);
    expect(first.contextSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.trainingInputSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.llvm.version).toBe('21.1.8');
    expect(first.target).toEqual({ triple: 'i686-buildroot-linux-gnu', cpu: 'pentiumpro', libc: 'glibc' });
    expect(first.optimization).toEqual({ level: 'O3', lto: 'thin', linker: 'lld' });
    expect(first.instrumentation).toMatchObject({
      kind: 'llvm-ir-pgo',
      generateFlags: ['-fprofile-generate=/tmp/anycast-pgo', '-fprofile-update=atomic'],
      rawProfilePattern: 'daemon-<kind>_%m_%p.profraw',
      continuous: false,
      requiresGracefulExit: true,
      llvmProfdataFailureMode: 'any',
      maxRawProfileBytes: MAX_PGO_PROFILE_BYTES,
      maxRawArchiveBytes: MAX_PGO_ARCHIVE_BYTES,
      maxRawProfilesPerArchive: MAX_PGO_RAW_PROFILES,
    });
  });

  it('invalidates the context when either an appliance input or training corpus source changes', async () => {
    const { root } = await fixture();
    const original = await createPgoContext(root);
    await writeFile(resolve(root, 'buildroot/new-flag.mk'), 'CFLAGS += -fnew\n');
    const buildChanged = await createPgoContext(root);
    expect(buildChanged.applianceInputSha256).not.toBe(original.applianceInputSha256);
    expect(buildChanged.contextSha256).not.toBe(original.contextSha256);

    const trainingPath = resolve(root, PGO_TRAINING_INPUTS[0]);
    await writeFile(trainingPath, 'different route churn corpus\n');
    const trainingChanged = await createPgoContext(root);
    expect(trainingChanged.trainingInputSha256).not.toBe(buildChanged.trainingInputSha256);
    expect(trainingChanged.contextSha256).not.toBe(buildChanged.contextSha256);

    await writeFile(resolve(root, '../../src/fixture.ts'), 'export const trainingFixture = false;\n');
    const sourceTreeChanged = await createPgoContext(root);
    expect(sourceTreeChanged.trainingInputSha256).not.toBe(trainingChanged.trainingInputSha256);
    expect(sourceTreeChanged.contextSha256).not.toBe(trainingChanged.contextSha256);
  });

  it('seals and validates separate non-empty BIRD and FRR profiles', async () => {
    const { root, profiles } = await fixture();
    await writeFile(resolve(profiles, PGO_PROFILE_FILES.bird), 'bird-indexed-profile');
    await writeFile(resolve(profiles, PGO_PROFILE_FILES.frr), 'frr-indexed-profile');
    const training = await storedTrainingIdentity(root, profiles);
    const sealed = await sealPgoProfileSet(root, profiles, training);
    const validated = await validatePgoProfileSet(root, profiles);
    expect(validated.buildKey).toBe(sealed.buildKey);
    expect(validated.birdProfile).toBe(resolve(profiles, 'bird.profdata'));
    expect(validated.frrProfile).toBe(resolve(profiles, 'frr.profdata'));
    expect(validated.trainingEvidence).toBe(resolve(profiles, PGO_TRAINING_EVIDENCE_FILE));
    expect(validated.training).toEqual(training);
    expect(JSON.parse(await readFile(resolve(profiles, PGO_PROFILE_SET_FILE), 'utf8'))).toEqual(sealed.manifest);
  });

  it('fails closed for missing, empty, oversized, symlinked, tampered, and stale profiles', async () => {
    const missing = await fixture();
    await writeFile(resolve(missing.profiles, 'bird.profdata'), 'bird');
    const missingTraining = await storedTrainingIdentity(missing.root, missing.profiles);
    await expect(sealPgoProfileSet(missing.root, missing.profiles, missingTraining)).rejects.toThrow(/Missing PGO file frr/);

    const empty = await fixture();
    await writeFile(resolve(empty.profiles, 'bird.profdata'), '');
    await writeFile(resolve(empty.profiles, 'frr.profdata'), 'frr');
    const emptyTraining = await storedTrainingIdentity(empty.root, empty.profiles);
    await expect(sealPgoProfileSet(empty.root, empty.profiles, emptyTraining)).rejects.toThrow(/empty/);

    const oversized = await fixture();
    await writeFile(resolve(oversized.profiles, 'bird.profdata'), 'bird');
    await writeFile(resolve(oversized.profiles, 'frr.profdata'), 'frr');
    await truncate(resolve(oversized.profiles, 'bird.profdata'), MAX_PGO_PROFILE_BYTES + 1);
    const oversizedTraining = await storedTrainingIdentity(oversized.root, oversized.profiles);
    await expect(sealPgoProfileSet(oversized.root, oversized.profiles, oversizedTraining)).rejects.toThrow(/exceeds/);

    const linked = await fixture();
    await writeFile(resolve(linked.base, 'outside.profdata'), 'outside');
    await symlink(resolve(linked.base, 'outside.profdata'), resolve(linked.profiles, 'bird.profdata'));
    await writeFile(resolve(linked.profiles, 'frr.profdata'), 'frr');
    const linkedTraining = await storedTrainingIdentity(linked.root, linked.profiles);
    await expect(sealPgoProfileSet(linked.root, linked.profiles, linkedTraining)).rejects.toThrow(/not a symlink/);

    const tampered = await fixture();
    await writeFile(resolve(tampered.profiles, 'bird.profdata'), 'bird');
    await writeFile(resolve(tampered.profiles, 'frr.profdata'), 'frr');
    await sealPgoProfileSet(tampered.root, tampered.profiles, await storedTrainingIdentity(tampered.root, tampered.profiles));
    await writeFile(resolve(tampered.profiles, 'bird.profdata'), 'changed');
    await expect(validatePgoProfileSet(tampered.root, tampered.profiles)).rejects.toThrow(/checksum or size mismatch/);

    const stale = await fixture();
    await writeFile(resolve(stale.profiles, 'bird.profdata'), 'bird');
    await writeFile(resolve(stale.profiles, 'frr.profdata'), 'frr');
    await sealPgoProfileSet(stale.root, stale.profiles, await storedTrainingIdentity(stale.root, stale.profiles));
    await writeFile(resolve(stale.root, PGO_TRAINING_INPUTS[1], 'fixture.ts'), 'new harness behavior\n');
    await expect(validatePgoProfileSet(stale.root, stale.profiles)).rejects.toThrow(/Stale PGO profile set/);
  });

  it('rejects unknown profile-set fields and toolchain identity changes', async () => {
    const { root, profiles } = await fixture();
    await writeFile(resolve(profiles, 'bird.profdata'), 'bird');
    await writeFile(resolve(profiles, 'frr.profdata'), 'frr');
    const { manifest } = await sealPgoProfileSet(root, profiles, await storedTrainingIdentity(root, profiles));
    await writeFile(resolve(profiles, PGO_PROFILE_SET_FILE), JSON.stringify({ ...manifest, extra: true }));
    await expect(validatePgoProfileSet(root, profiles)).rejects.toThrow(/unexpected fields/);

    await writeFile(resolve(profiles, PGO_PROFILE_SET_FILE), JSON.stringify({ ...manifest, llvmVersion: '22.0.0' }));
    await expect(validatePgoProfileSet(root, profiles)).rejects.toThrow(/LLVM version must be 21.1.8/);
  });
});

describe('untrusted PGO ustar parsing', () => {
  it('accepts only flat, non-empty daemon-tagged profiles and sorts them deterministically', () => {
    const archive = ustar([
      { name: 'daemon-bird_b_2.profraw', contents: encoder.encode('b') },
      { name: 'daemon-bird_a_1.profraw', contents: encoder.encode('a') },
    ]);
    expect(parsePgoUstar(archive).map((entry) => entry.name)).toEqual([
      'daemon-bird_a_1.profraw',
      'daemon-bird_b_2.profraw',
    ]);
  });

  it.each([
    ['bad checksum', (archive) => { archive[0] ^= 1; }, /checksum/],
    ['bad name', (_archive, entries) => { entries[0].name = '../daemon-bird_a_1.profraw'; }, /invalid profile name/],
    ['directory type', (_archive, entries) => { entries[0].type = 0x35; }, /regular files/],
    ['empty profile', (_archive, entries) => { entries[0].contents = new Uint8Array(); }, /profile size/],
    ['duplicate profile', (_archive, entries) => { entries.push({ ...entries[0] }); }, /duplicate profile/],
    ['non-zero padding', (archive) => { archive[513] = 1; }, /padding/],
    ['missing trailer', (archive) => archive.fill(1, archive.length - 1024), /checksum|trailer/],
    ['data after trailer', (archive) => {
      const extended = new Uint8Array(archive.length + 512);
      extended.set(archive);
      extended[extended.length - 1] = 1;
      return extended;
    }, /data after/],
  ])('rejects %s', (_name, mutate, expected) => {
    const entries = [{ name: 'daemon-bird_a_1.profraw', contents: encoder.encode('a') }];
    let archive = ustar(entries);
    const result = mutate(archive, entries);
    if (result instanceof Uint8Array) archive = result;
    else if (_name === 'bad name' || _name === 'directory type' || _name === 'empty profile' || _name === 'duplicate profile') {
      archive = ustar(entries);
    }
    expect(() => parsePgoUstar(archive)).toThrow(expected);
  });

  it('caps each VM archive at 128 raw profiles', () => {
    const entries = Array.from({ length: MAX_PGO_RAW_PROFILES + 1 }, (_, index) => ({
      name: `daemon-bird_${index}_1.profraw`,
      contents: encoder.encode('x'),
    }));
    expect(() => parsePgoUstar(ustar(entries))).toThrow(/too many profiles/);
  });
});

describe('archive merge command', () => {
  it('requires an exact function from llvm-profdata covered output', () => {
    expect(() => assertCoveredProfileFunction(
      'io_loop\n',
      'bird',
      'io_loop',
    )).not.toThrow();
    expect(() => assertCoveredProfileFunction(
      'other_io_loop\n',
      'bird',
      'io_loop',
    )).toThrow(/did not execute/);
  });

  it('uses the exact built LLVM 21 tool, failure-mode any, deterministic inputs, then seals', async () => {
    const { base, root, profiles } = await fixture();
    const buildOutput = resolve(base, 'output');
    const tool = resolve(buildOutput, 'host/bin/llvm-profdata');
    const log = resolve(base, 'llvm-profdata.log');
    await mkdir(dirname(tool), { recursive: true });
    await writeFile(tool, fakeLlvmProfdata(log));
    await chmod(tool, 0o755);
    const birdArchive = resolve(base, 'bird-native.tar');
    const frrArchive = resolve(base, 'frr-native.tar');
    const birdArchiveBytes = ustar([
      { name: 'daemon-bird_z_2.profraw', contents: encoder.encode('bird-z') },
      { name: 'daemon-bird_a_1.profraw', contents: encoder.encode('bird-a') },
    ]);
    const frrArchiveBytes = ustar([
      { name: 'daemon-frr_main_1.profraw', contents: encoder.encode('frr') },
    ]);
    await writeFile(birdArchive, birdArchiveBytes);
    await writeFile(frrArchive, frrArchiveBytes);
    const training = await trainingMaterials(root, base, {
      bird: birdArchiveBytes,
      frr: frrArchiveBytes,
    });

    const merged = await mergePgoProfileArchives({
      root,
      profileDirectory: profiles,
      buildOutput,
      birdArchive,
      frrArchive,
      evidence: training.evidencePath,
      manifest: training.manifestPath,
    });
    expect(merged.buildKey).toMatch(/^[a-f0-9]{64}$/);
    await expect(validatePgoProfileSet(root, profiles)).resolves.toMatchObject({ buildKey: merged.buildKey });
    const copiedEvidence = await readFile(resolve(profiles, PGO_TRAINING_EVIDENCE_FILE));
    expect(digest(copiedEvidence)).toBe(digest(await readFile(training.evidencePath)));
    expect(merged.manifest.training).toMatchObject({
      buildId: training.context.buildId,
      manifestSha256: training.evidence.manifestSha256,
      pgoMode: 'generate',
      contextSha256: training.context.contextSha256,
    });
    const invocations = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    const mergeCalls = invocations.filter((arguments_) => arguments_[0] === 'merge');
    expect(mergeCalls).toHaveLength(2);
    for (const arguments_ of mergeCalls) {
      expect(arguments_).toContain('--failure-mode=any');
      expect(arguments_).not.toContain('--sparse');
      const inputs = arguments_.filter((argument) => argument.endsWith('.profraw'));
      expect(inputs).toEqual([...inputs].sort());
    }
    const coverageCalls = invocations.filter((arguments_) =>
      arguments_[0] === 'show' && arguments_.includes('--covered'));
    expect(coverageCalls).toHaveLength(2);
    expect(coverageCalls.every((arguments_) =>
      arguments_.every((argument) => !argument.startsWith('--function=')))).toBe(true);
    await writeFile(resolve(profiles, PGO_TRAINING_EVIDENCE_FILE), '{"tampered":true}\n');
    await expect(validatePgoProfileSet(root, profiles)).rejects.toThrow(/training-evidence|unexpected fields/);
  });

  it('rejects profiles that did not execute every required daemon', async () => {
    const harness = await mergeHarness();
    const tool = resolve(harness.buildOutput, 'host/bin/llvm-profdata');
    await writeFile(tool, fakeLlvmProfdata(resolve(harness.base, 'missing-coverage.log'), 'ospf_read'));
    await chmod(tool, 0o755);
    await expect(mergePgoProfileArchives({
      root: harness.root,
      profileDirectory: harness.profiles,
      buildOutput: harness.buildOutput,
      birdArchive: harness.birdArchive,
      frrArchive: harness.frrArchive,
      evidence: harness.training.evidencePath,
      manifest: harness.training.manifestPath,
    })).rejects.toThrow(/did not execute required function ospf_read/);
    await expect(readFile(resolve(harness.profiles, PGO_PROFILE_SET_FILE))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects an archive whose daemon tag does not match its package', async () => {
    const harness = await mergeHarness();
    await writeFile(
      harness.birdArchive,
      ustar([{ name: 'daemon-frr_wrong_1.profraw', contents: encoder.encode('wrong') }]),
    );
    await expect(mergePgoProfileArchives({
      root: harness.root,
      profileDirectory: harness.profiles,
      buildOutput: harness.buildOutput,
      birdArchive: harness.birdArchive,
      frrArchive: harness.frrArchive,
      evidence: harness.training.evidencePath,
      manifest: harness.training.manifestPath,
    })).rejects.toThrow(/wrong daemon kind/);
  });

  it('requires bounded regular evidence and manifest inputs', async () => {
    const harness = await mergeHarness();
    const common = {
      root: harness.root,
      profileDirectory: harness.profiles,
      buildOutput: harness.buildOutput,
      birdArchive: harness.birdArchive,
      frrArchive: harness.frrArchive,
    };
    await expect(mergePgoProfileArchives({
      ...common,
      manifest: harness.training.manifestPath,
    })).rejects.toThrow(/--evidence is required/);
    await expect(mergePgoProfileArchives({
      ...common,
      evidence: harness.training.evidencePath,
    })).rejects.toThrow(/--manifest is required/);

    const outside = resolve(harness.base, 'outside-evidence.json');
    await writeFile(outside, await readFile(harness.training.evidencePath));
    await rm(harness.training.evidencePath);
    await symlink(outside, harness.training.evidencePath);
    await expect(mergePgoProfileArchives({
      ...common,
      evidence: harness.training.evidencePath,
      manifest: harness.training.manifestPath,
    })).rejects.toThrow(/not a symlink/);

    await rm(harness.training.evidencePath);
    await writeFile(harness.training.evidencePath, 'x');
    await truncate(harness.training.evidencePath, MAX_PGO_EVIDENCE_BYTES + 1);
    await expect(mergePgoProfileArchives({
      ...common,
      evidence: harness.training.evidencePath,
      manifest: harness.training.manifestPath,
    })).rejects.toThrow(/exceeds/);
  });

  it('rejects non-exact evidence, generate-manifest identity drift, and archive metadata mismatches', async () => {
    const harness = await mergeHarness();
    const merge = () => mergePgoProfileArchives({
      root: harness.root,
      profileDirectory: harness.profiles,
      buildOutput: harness.buildOutput,
      birdArchive: harness.birdArchive,
      frrArchive: harness.frrArchive,
      evidence: harness.training.evidencePath,
      manifest: harness.training.manifestPath,
    });

    await writeFile(harness.training.evidencePath, JSON.stringify({
      ...harness.training.evidence,
      unexpected: true,
    }));
    await expect(merge()).rejects.toThrow(/unexpected fields/);

    const wrongArchiveEvidence = structuredClone(harness.training.evidence);
    wrongArchiveEvidence.collections[0].files[0].sha256 = '0'.repeat(64);
    await writeFile(harness.training.evidencePath, JSON.stringify(wrongArchiveEvidence));
    await expect(merge()).rejects.toThrow(/does not match bird archive/);

    const useManifest = structuredClone(harness.training.manifest);
    useManifest.pgo.mode = 'use';
    const useManifestBytes = Buffer.from(`${JSON.stringify(useManifest)}\n`);
    await writeFile(harness.training.manifestPath, useManifestBytes);
    await writeFile(harness.training.evidencePath, JSON.stringify({
      ...harness.training.evidence,
      manifestSha256: digest(useManifestBytes),
    }));
    await expect(merge()).rejects.toThrow(/mode must be generate/);

    const staleManifest = structuredClone(harness.training.manifest);
    staleManifest.pgo.contextSha256 = 'f'.repeat(64);
    const staleManifestBytes = Buffer.from(`${JSON.stringify(staleManifest)}\n`);
    await writeFile(harness.training.manifestPath, staleManifestBytes);
    await writeFile(harness.training.evidencePath, JSON.stringify({
      ...harness.training.evidence,
      manifestSha256: digest(staleManifestBytes),
    }));
    await expect(merge()).rejects.toThrow(/context is stale/);
  });

  it('rejects the wrong llvm-profdata version and malformed archives before sealing', async () => {
    const wrongTool = await fixture();
    const buildOutput = resolve(wrongTool.base, 'output');
    const tool = resolve(buildOutput, 'host/bin/llvm-profdata');
    await mkdir(dirname(tool), { recursive: true });
    await writeFile(tool, '#!/bin/sh\necho "LLVM version 22.0.0"\n');
    await chmod(tool, 0o755);
    const archive = resolve(wrongTool.base, 'valid.tar');
    const archiveBytes = ustar([{ name: 'daemon-bird_a_1.profraw', contents: encoder.encode('x') }]);
    await writeFile(archive, archiveBytes);
    const wrongTraining = await trainingMaterials(wrongTool.root, wrongTool.base, {
      bird: archiveBytes,
      frr: archiveBytes,
    });
    await expect(mergePgoProfileArchives({
      root: wrongTool.root,
      profileDirectory: wrongTool.profiles,
      buildOutput,
      birdArchive: archive,
      frrArchive: archive,
      evidence: wrongTraining.evidencePath,
      manifest: wrongTraining.manifestPath,
    })).rejects.toThrow(/must be LLVM 21.1.8/);

    const malformed = await fixture();
    const goodTool = resolve(malformed.base, 'output/host/bin/llvm-profdata');
    await mkdir(dirname(goodTool), { recursive: true });
    await writeFile(goodTool, fakeLlvmProfdata(resolve(malformed.base, 'log')));
    await chmod(goodTool, 0o755);
    const bad = resolve(malformed.base, 'bad.tar');
    const badBytes = ustar([{ name: 'daemon-bird_a_1.profraw', contents: encoder.encode('x') }]);
    badBytes[0] ^= 1;
    await writeFile(bad, badBytes);
    const goodBytes = ustar([
      { name: 'daemon-frr_b_1.profraw', contents: encoder.encode('x') },
    ]);
    await writeFile(resolve(malformed.base, 'good.tar'), goodBytes);
    const malformedTraining = await trainingMaterials(malformed.root, malformed.base, {
      bird: goodBytes,
      frr: goodBytes,
    });
    await expect(mergePgoProfileArchives({
      root: malformed.root,
      profileDirectory: malformed.profiles,
      buildOutput: resolve(malformed.base, 'output'),
      birdArchive: bad,
      frrArchive: resolve(malformed.base, 'good.tar'),
      evidence: malformedTraining.evidencePath,
      manifest: malformedTraining.manifestPath,
    })).rejects.toThrow(/checksum/);
    await expect(readFile(resolve(malformed.profiles, PGO_PROFILE_SET_FILE))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

async function storedTrainingIdentity(root, profiles) {
  const context = await createPgoContext(root);
  const evidence = {
    schemaVersion: 1,
    buildId: context.buildId,
    manifestSha256: '8'.repeat(64),
    workload: PGO_TRAINING_WORKLOAD,
    collections: [
      {
        nodeId: 'bird-native',
        kind: 'bird',
        files: [{ path: '/daemon-bird_main_1.profraw', size: 1, sha256: 'a'.repeat(64) }],
      },
      {
        nodeId: 'frr-native',
        kind: 'frr',
        files: [{ path: '/daemon-frr_main_1.profraw', size: 1, sha256: 'b'.repeat(64) }],
      },
    ],
  };
  const bytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
  await writeFile(resolve(profiles, PGO_TRAINING_EVIDENCE_FILE), bytes);
  return {
    evidence: {
      file: PGO_TRAINING_EVIDENCE_FILE,
      bytes: bytes.byteLength,
      sha256: digest(bytes),
    },
    buildId: context.buildId,
    manifestSha256: evidence.manifestSha256,
    pgoMode: 'generate',
    contextSha256: context.contextSha256,
    workload: evidence.workload,
    collections: evidence.collections,
  };
}

async function trainingMaterials(root, base, archives) {
  const context = await createPgoContext(root);
  const manifest = {
    schemaVersion: 1,
    imageId: 'anycast-lab-router',
    buildId: context.buildId,
    sourceDateEpoch: 1,
    buildroot: {},
    v86: {},
    daemons: { ...context.daemons },
    toolchain: {
      scope: 'bird-and-frr',
      compiler: 'clang',
      compilerVersion: context.llvm.version,
      linker: context.optimization.linker,
      optimization: context.optimization.level,
      lto: context.optimization.lto,
    },
    pgo: {
      mode: 'generate',
      contextSha256: context.contextSha256,
      profileSetBuildKey: null,
      birdProfileSha256: null,
      frrProfileSha256: null,
    },
    machine: {},
    artifacts: [],
  };
  const manifestPath = resolve(base, 'instrumented-manifest.json');
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(manifestPath, manifestBytes);
  const collections = [];
  for (const kind of ['bird', 'frr']) {
    const entries = parsePgoUstar(archives[kind]);
    collections.push({
      nodeId: `${kind}-native`,
      kind,
      files: entries.map((entry) => ({
        path: `/${entry.name}`,
        size: entry.contents.byteLength,
        sha256: digest(entry.contents),
      })),
    });
  }
  const evidence = {
    schemaVersion: 1,
    buildId: context.buildId,
    manifestSha256: digest(manifestBytes),
    workload: PGO_TRAINING_WORKLOAD,
    collections,
  };
  const evidencePath = resolve(base, PGO_TRAINING_EVIDENCE_FILE);
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  return { context, evidence, evidencePath, manifest, manifestPath };
}

async function mergeHarness() {
  const current = await fixture();
  const buildOutput = resolve(current.base, 'output');
  const tool = resolve(buildOutput, 'host/bin/llvm-profdata');
  await mkdir(dirname(tool), { recursive: true });
  await writeFile(tool, fakeLlvmProfdata(resolve(current.base, 'llvm-profdata.log')));
  await chmod(tool, 0o755);
  const birdBytes = ustar([{ name: 'daemon-bird_main_1.profraw', contents: encoder.encode('bird') }]);
  const frrBytes = ustar([{ name: 'daemon-frr_main_1.profraw', contents: encoder.encode('frr') }]);
  const birdArchive = resolve(current.base, 'bird-native.tar');
  const frrArchive = resolve(current.base, 'frr-native.tar');
  await writeFile(birdArchive, birdBytes);
  await writeFile(frrArchive, frrBytes);
  const training = await trainingMaterials(current.root, current.base, {
    bird: birdBytes,
    frr: frrBytes,
  });
  return { ...current, buildOutput, birdArchive, frrArchive, training };
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function ustar(entries) {
  const blocks = [];
  for (const entry of entries) {
    const contents = entry.contents;
    const header = new Uint8Array(512);
    writeAscii(header, 0, 100, entry.name);
    writeOctal(header, 100, 8, 0o600);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, contents.byteLength);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = entry.type ?? 0x30;
    writeAscii(header, 257, 8, 'ustar  ');
    let checksum = 0;
    for (const byte of header) checksum += byte;
    const encoded = checksum.toString(8).padStart(6, '0');
    writeAscii(header, 148, 6, encoded);
    header[154] = 0;
    header[155] = 0x20;
    blocks.push(header);
    const payload = new Uint8Array(Math.ceil(contents.byteLength / 512) * 512);
    payload.set(contents);
    blocks.push(payload);
  }
  blocks.push(new Uint8Array(1024));
  const bytes = new Uint8Array(blocks.reduce((total, block) => total + block.byteLength, 0));
  let offset = 0;
  for (const block of blocks) {
    bytes.set(block, offset);
    offset += block.byteLength;
  }
  return bytes;
}

function writeAscii(target, offset, length, value) {
  const bytes = encoder.encode(value);
  if (bytes.length > length) throw new Error('test tar field too long');
  target.set(bytes, offset);
}

function writeOctal(target, offset, length, value) {
  writeAscii(target, offset, length - 1, value.toString(8).padStart(length - 1, '0'));
}

function fakeLlvmProfdata(log, missingSentinel = null) {
  return `#!/usr/bin/env node
const { appendFile, readFile, writeFile } = require('node:fs/promises');
const args = process.argv.slice(2);
if (args[0] === '--version') {
  process.stdout.write('LLVM version 21.1.8\\n');
  process.exit(0);
}
(async () => {
  await appendFile(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
  if (args[0] === 'merge') {
    const output = args.find((value) => value.startsWith('--output=')).slice('--output='.length);
    const inputs = args.filter((value) => value.endsWith('.profraw'));
    const chunks = await Promise.all(inputs.map((path) => readFile(path)));
    await writeFile(output, Buffer.concat([Buffer.from('indexed:'), ...chunks]));
  } else if (args[0] === 'show') {
    if (!args.includes('--covered')) {
      process.stdout.write('Instrumentation level: IR\\nTotal functions: 2\\n');
    } else {
      const output = args.at(-1);
      const sentinels = output.endsWith('/bird.profdata')
        ? ['io_loop']
        : ['bgp_process_packet', 'rib_update', 'ospf_read'];
      process.stdout.write(sentinels.filter((sentinel) => sentinel !== ${JSON.stringify(missingSentinel)}).join('\\n') + '\\n');
    }
  } else {
    process.exitCode = 2;
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`;
}
