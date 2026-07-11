#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import {
  lstat,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { computeApplianceCacheKey } from './appliance-cache-key.mjs';

export const PGO_CONTEXT_SCHEMA_VERSION = 2;
export const PGO_PROFILE_SET_SCHEMA_VERSION = 3;
export const PGO_FRR_PROFILE_COMPONENTS = Object.freeze({
  selected: Object.freeze([
    Object.freeze({
      component: 'libfrr',
      fingerprint: 'event_fetch',
      profile: 'frr-libfrr.profdata',
    }),
    Object.freeze({
      component: 'libmgmt-be-nb',
      fingerprint: 'zebra_cli_init',
      profile: 'frr-libmgmt-be-nb.profdata',
    }),
    Object.freeze({
      component: 'bgpd',
      fingerprint: 'bgp_process_packet',
      profile: 'frr-bgpd.profdata',
    }),
    Object.freeze({
      component: 'zebra',
      fingerprint: 'rib_update',
      profile: 'frr-zebra.profdata',
    }),
    Object.freeze({
      component: 'ospfd',
      fingerprint: 'ospf_read',
      profile: 'frr-ospfd.profdata',
    }),
  ]),
  forbidden: Object.freeze([
    Object.freeze({ component: 'staticd', fingerprint: 'static_zebra_init' }),
    Object.freeze({ component: 'mgmtd', fingerprint: 'mgmt_master_init' }),
    Object.freeze({ component: 'watchfrr', fingerprint: 'watchfrr_vty_init' }),
    Object.freeze({ component: 'vtysh', fingerprint: 'vtysh_init_cmd' }),
  ]),
});
export const PGO_PROFILE_FILES = Object.freeze({
  bird: 'bird.profdata',
  ...Object.fromEntries(PGO_FRR_PROFILE_COMPONENTS.selected.map(({ component, profile }) => (
    [component, profile]
  ))),
});
export const PGO_PROFILE_SET_FILE = 'profile-set.json';
export const PGO_TRAINING_EVIDENCE_FILE = 'training-evidence.json';
export const PGO_TRAINING_EVIDENCE_SCHEMA_VERSION = 1;
export const PGO_TRAINING_WORKLOAD = 'bird-frr-bgp-ospfv2-route-churn-link-recovery-v1';
export const PGO_PROFILE_COVERAGE_SENTINELS = Object.freeze({
  bird: Object.freeze(['io_loop']),
  ...Object.fromEntries(PGO_FRR_PROFILE_COMPONENTS.selected.map(({ component, fingerprint }) => (
    [component, Object.freeze([fingerprint])]
  ))),
});
export const MAX_PGO_PROFILE_BYTES = 64 * 1024 * 1024;
export const MAX_PGO_ARCHIVE_BYTES = 65 * 1024 * 1024;
export const MAX_PGO_RAW_PROFILES = 128;
export const MAX_PGO_EVIDENCE_BYTES = 1024 * 1024;
export const MAX_PGO_MANIFEST_BYTES = 1024 * 1024;
export const PGO_TRAINING_INPUTS = Object.freeze([
  '../../e2e/native-vm.spec.ts',
  '../../src',
  '../../index.html',
  '../../package.json',
  '../../bun.lock',
  '../../playwright.config.ts',
  '../../vite.config.ts',
  '../../tsconfig.json',
  '../../tsconfig.app.json',
  '../../tsconfig.node.json',
  '../../scripts/sync-native-artifacts.mjs',
  '../../.github/workflows/publish-native-v86.yml',
]);

const REQUIRED_VERSION_KEYS = Object.freeze([
  'BUILDROOT_VERSION',
  'BUILDROOT_SHA256',
  'BIRD_VERSION',
  'FRR_VERSION',
  'IMAGE_BUILD_ID',
  'LLVM_VERSION',
  'LLVM_SOURCE_SHA256',
  'LLVM_THIRD_PARTY_SHA256',
  'LLVM_CMAKE_SOURCE_SHA256',
  'CLANG_SOURCE_SHA256',
  'LLD_SOURCE_SHA256',
  'COMPILER_RT_SOURCE_SHA256',
]);
const TAR_BLOCK_BYTES = 512;
const execFile = promisify(execFileCallback);

export async function createPgoContext(root) {
  const absoluteRoot = resolve(root);
  const versions = parseVersions(await readFile(resolve(absoluteRoot, 'versions.env'), 'utf8'));
  const applianceInputSha256 = await computeApplianceCacheKey(absoluteRoot);
  const trainingInputSha256 = await hashTrainingInputs(absoluteRoot);
  const payload = {
    schemaVersion: PGO_CONTEXT_SCHEMA_VERSION,
    buildId: versions.IMAGE_BUILD_ID,
    applianceInputSha256,
    trainingInputSha256,
    buildroot: {
      version: versions.BUILDROOT_VERSION,
      sourceSha256: versions.BUILDROOT_SHA256,
    },
    llvm: {
      version: versions.LLVM_VERSION,
      llvmSourceSha256: versions.LLVM_SOURCE_SHA256,
      thirdPartySourceSha256: versions.LLVM_THIRD_PARTY_SHA256,
      cmakeSourceSha256: versions.LLVM_CMAKE_SOURCE_SHA256,
      clangSourceSha256: versions.CLANG_SOURCE_SHA256,
      lldSourceSha256: versions.LLD_SOURCE_SHA256,
      compilerRtSourceSha256: versions.COMPILER_RT_SOURCE_SHA256,
    },
    daemons: {
      bird: versions.BIRD_VERSION,
      frr: versions.FRR_VERSION,
    },
    target: {
      triple: 'i686-buildroot-linux-gnu',
      cpu: 'pentiumpro',
      libc: 'glibc',
    },
    optimization: {
      level: 'O3',
      lto: 'thin',
      linker: 'lld',
    },
    instrumentation: {
      kind: 'llvm-ir-pgo',
      generateFlags: [
        '-fprofile-generate=/tmp/anycast-pgo',
        '-fprofile-update=atomic',
      ],
      useFlag: '-fprofile-use=<component.profdata>',
      rawProfileDirectory: '/tmp/anycast-pgo',
      rawProfilePattern: 'daemon-<kind>_%m_%p.profraw',
      continuous: false,
      requiresGracefulExit: true,
      llvmProfdataFailureMode: 'any',
      maxRawProfileBytes: MAX_PGO_PROFILE_BYTES,
      maxRawArchiveBytes: MAX_PGO_ARCHIVE_BYTES,
      maxRawProfilesPerArchive: MAX_PGO_RAW_PROFILES,
      profileSelection: {
        classifier: 'llvm-profdata-show-all-functions-v1',
        package: 'frr',
        selected: PGO_FRR_PROFILE_COMPONENTS.selected,
        forbidden: PGO_FRR_PROFILE_COMPONENTS.forbidden,
      },
    },
  };
  return {
    ...payload,
    contextSha256: sha256(Buffer.from(JSON.stringify(payload))),
  };
}

async function hashTrainingInputs(root) {
  const hash = createHash('sha256');
  hash.update('anycast-lab-pgo-training-inputs-v2\0');
  for (const input of PGO_TRAINING_INPUTS) {
    const path = resolve(root, input);
    await hashTrainingInput(hash, path, input);
  }
  return hash.digest('hex');
}

async function hashTrainingInput(hash, path, label) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) throw new Error(`PGO training input must not be a symlink: ${label}`);
  if (metadata.isFile()) {
    const bytes = await readFile(path);
    if (bytes.byteLength !== metadata.size) throw new Error(`PGO training input changed while hashing: ${label}`);
    hash.update(`file\0${label}\0${(metadata.mode & 0o777).toString(8)}\0${bytes.byteLength}\0`);
    hash.update(bytes);
    hash.update('\0');
    return;
  }
  if (!metadata.isDirectory()) throw new Error(`PGO training input has an unsupported type: ${label}`);
  hash.update(`directory\0${label}\0`);
  const entries = (await readdir(path)).sort((left, right) => left.localeCompare(right));
  for (const entry of entries) {
    await hashTrainingInput(hash, resolve(path, entry), `${label}/${entry}`);
  }
}

export async function writePgoContext(root, output) {
  const context = await createPgoContext(root);
  await writeJsonAtomically(resolve(output), context);
  return context;
}

export async function sealPgoProfileSet(root, profileDirectory, training) {
  const absoluteDirectory = resolve(profileDirectory);
  const context = await createPgoContext(root);
  const validatedTraining = await validateStoredTrainingEvidence(
    context,
    absoluteDirectory,
    training,
  );
  const profiles = {};
  for (const [name, file] of Object.entries(PGO_PROFILE_FILES)) {
    profiles[name] = await inspectProfile(resolve(absoluteDirectory, file), file);
  }
  const manifest = {
    schemaVersion: PGO_PROFILE_SET_SCHEMA_VERSION,
    contextSha256: context.contextSha256,
    llvmVersion: context.llvm.version,
    targetTriple: context.target.triple,
    training: validatedTraining,
    profiles,
  };
  await writeJsonAtomically(resolve(absoluteDirectory, PGO_PROFILE_SET_FILE), manifest);
  return {
    manifest,
    buildKey: profileBuildKey(manifest),
  };
}

export async function validatePgoProfileSet(root, profileDirectory) {
  const absoluteDirectory = resolve(profileDirectory);
  const context = await createPgoContext(root);
  const manifestPath = resolve(absoluteDirectory, PGO_PROFILE_SET_FILE);
  await requireRegularFile(manifestPath, PGO_PROFILE_SET_FILE);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid ${PGO_PROFILE_SET_FILE}: ${errorMessage(error)}`);
  }
  validateManifestShape(manifest);
  if (manifest.contextSha256 !== context.contextSha256) {
    throw new Error(
      `Stale PGO profile set: expected context ${context.contextSha256}, received ${manifest.contextSha256}`,
    );
  }
  if (manifest.llvmVersion !== context.llvm.version) {
    throw new Error(`PGO profile LLVM version must be ${context.llvm.version}`);
  }
  if (manifest.targetTriple !== context.target.triple) {
    throw new Error(`PGO profile target must be ${context.target.triple}`);
  }
  const training = await validateStoredTrainingEvidence(
    context,
    absoluteDirectory,
    manifest.training,
  );
  for (const [name, file] of Object.entries(PGO_PROFILE_FILES)) {
    const actual = await inspectProfile(resolve(absoluteDirectory, file), file);
    const recorded = manifest.profiles[name];
    if (recorded.file !== file || recorded.bytes !== actual.bytes || recorded.sha256 !== actual.sha256) {
      throw new Error(`PGO profile checksum or size mismatch: ${file}`);
    }
  }
  return {
    context,
    manifest,
    buildKey: profileBuildKey(manifest),
    birdProfile: resolve(absoluteDirectory, PGO_PROFILE_FILES.bird),
    componentProfiles: Object.fromEntries(Object.entries(PGO_PROFILE_FILES).map(([name, file]) => (
      [name, resolve(absoluteDirectory, file)]
    ))),
    trainingEvidence: resolve(absoluteDirectory, PGO_TRAINING_EVIDENCE_FILE),
    training,
  };
}

export async function mergePgoProfileArchives({
  root,
  profileDirectory,
  buildOutput,
  birdArchive,
  frrArchive,
  evidence,
  manifest,
}) {
  requirePathOption(evidence, '--evidence');
  requirePathOption(manifest, '--manifest');
  const context = await createPgoContext(root);
  const llvmProfdata = resolve(buildOutput, 'host/bin/llvm-profdata');
  const toolMetadata = await lstat(llvmProfdata);
  if (!toolMetadata.isFile() || toolMetadata.isSymbolicLink() || (toolMetadata.mode & 0o111) === 0) {
    throw new Error(`Built llvm-profdata is not a regular executable: ${llvmProfdata}`);
  }
  const version = await execFile(llvmProfdata, ['--version'], { maxBuffer: 1024 * 1024 });
  if (!version.stdout.includes(`LLVM version ${context.llvm.version}`)) {
    throw new Error(`Built llvm-profdata must be LLVM ${context.llvm.version}`);
  }

  const archiveInputs = {
    bird: resolve(birdArchive),
    frr: resolve(frrArchive),
  };
  const archiveMetadata = await Promise.all(
    Object.entries(archiveInputs).map(async ([name, path]) => {
      const file = await readBoundedRegularFile(path, `${name}-native.tar`, MAX_PGO_ARCHIVE_BYTES);
      return { name, bytes: file.bytes };
    }),
  );

  const entriesByPackage = {};
  for (const { name, bytes } of archiveMetadata) {
    const entries = parsePgoUstar(bytes, `${name}-native.tar`);
    if (entries.length === 0) throw new Error(`PGO archive has no raw profiles: ${name}-native.tar`);
    if (entries.some((entry) => !entry.name.startsWith(`daemon-${name}_`))) {
      throw new Error(`${name}-native.tar contains a profile from the wrong daemon kind`);
    }
    const rawBytes = entries.reduce((total, entry) => total + entry.contents.byteLength, 0);
    if (rawBytes > MAX_PGO_PROFILE_BYTES) {
      throw new Error(`${name} raw PGO profiles exceed ${MAX_PGO_PROFILE_BYTES} bytes`);
    }
    entriesByPackage[name] = entries;
  }

  const training = await validateTrainingInputs({
    context,
    evidencePath: resolve(evidence),
    manifestPath: resolve(manifest),
    entriesByPackage,
  });

  const absoluteProfileDirectory = resolve(profileDirectory);
  await mkdir(absoluteProfileDirectory, { recursive: true });
  const temporary = await mkdtemp(resolve(absoluteProfileDirectory, '.merge-'));
  try {
    const rawPathsByPackage = {};
    for (const name of Object.keys(entriesByPackage)) {
      const packageDirectory = resolve(temporary, `raw-${name}`);
      await mkdir(packageDirectory, { mode: 0o700 });
      const rawPaths = [];
      for (const entry of entriesByPackage[name]) {
        const path = resolve(packageDirectory, entry.name);
        await writeFile(path, entry.contents, { flag: 'wx', mode: 0o600 });
        rawPaths.push(path);
      }
      rawPaths.sort();
      rawPathsByPackage[name] = rawPaths;
    }

    const classifiedFrr = await classifyFrrRawProfiles(
      llvmProfdata,
      rawPathsByPackage.frr,
    );
    const mergeTargets = [
      { component: 'bird', rawPaths: rawPathsByPackage.bird },
      ...PGO_FRR_PROFILE_COMPONENTS.selected.map(({ component }) => ({
        component,
        rawPaths: classifiedFrr.get(component),
      })),
    ];

    const merged = {};
    for (const { component, rawPaths } of mergeTargets) {
      const output = resolve(temporary, PGO_PROFILE_FILES[component]);
      await execFile(
        llvmProfdata,
        ['merge', '--failure-mode=any', `--output=${output}`, ...rawPaths],
        { maxBuffer: 8 * 1024 * 1024 },
      );
      const shown = await execFile(llvmProfdata, ['show', output], { maxBuffer: 8 * 1024 * 1024 });
      if (!/Total functions: [1-9][0-9]*/.test(shown.stdout)) {
        throw new Error(`Merged ${component} profile contains no functions`);
      }
      const covered = await execFile(
        llvmProfdata,
        ['show', '--covered', output],
        { maxBuffer: 8 * 1024 * 1024 },
      );
      for (const sentinel of PGO_PROFILE_COVERAGE_SENTINELS[component]) {
        assertCoveredProfileFunction(covered.stdout, component, sentinel);
      }
      const outputMetadata = await lstat(output);
      if (!outputMetadata.isFile() || outputMetadata.size < 1 || outputMetadata.size > MAX_PGO_PROFILE_BYTES) {
        throw new Error(`Merged ${component} profile has an invalid size`);
      }
      merged[component] = output;
    }
    for (const [name, file] of Object.entries(PGO_PROFILE_FILES)) {
      await rename(merged[name], resolve(absoluteProfileDirectory, file));
    }
    await writeFile(
      resolve(temporary, PGO_TRAINING_EVIDENCE_FILE),
      training.evidenceBytes,
      { flag: 'wx', mode: 0o600 },
    );
    await rename(
      resolve(temporary, PGO_TRAINING_EVIDENCE_FILE),
      resolve(absoluteProfileDirectory, PGO_TRAINING_EVIDENCE_FILE),
    );
    return await sealPgoProfileSet(root, absoluteProfileDirectory, training.identity);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function classifyFrrRawProfiles(llvmProfdata, rawPaths) {
  const selected = PGO_FRR_PROFILE_COMPONENTS.selected;
  const forbidden = PGO_FRR_PROFILE_COMPONENTS.forbidden;
  const definitions = [...selected, ...forbidden];
  const classified = new Map(selected.map(({ component }) => [component, []]));

  for (const rawPath of rawPaths) {
    const shown = await execFile(
      llvmProfdata,
      ['show', '--all-functions', rawPath],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    const records = parseLlvmProfileFunctionRecords(shown.stdout, rawPath);
    const matches = [];
    for (const definition of definitions) {
      const fingerprints = records.filter(({ name }) => name === definition.fingerprint);
      if (fingerprints.length > 1) {
        throw new Error(
          `FRR raw profile ${rawPath} contains duplicate ${definition.component} fingerprint ` +
          definition.fingerprint,
        );
      }
      if (fingerprints.length === 1) matches.push(definition);
    }
    if (matches.length !== 1) {
      const reason = matches.length === 0
        ? 'does not match any expected component'
        : `matches multiple components: ${matches.map(({ component }) => component).join(', ')}`;
      throw new Error(`FRR raw profile ${rawPath} ${reason}`);
    }
    const [match] = matches;
    if (!classified.has(match.component)) {
      throw new Error(
        `FRR raw profile ${rawPath} contains unselected component ${match.component} ` +
        `(${match.fingerprint}); PGO instrumentation leaked outside the selected scope`,
      );
    }
    classified.get(match.component).push(rawPath);
  }

  for (const { component, fingerprint } of selected) {
    if (classified.get(component).length === 0) {
      throw new Error(`FRR raw profiles are missing expected component ${component} (${fingerprint})`);
    }
  }
  for (const paths of classified.values()) paths.sort();
  return classified;
}

export function parseLlvmProfileFunctionRecords(output, label = 'llvm-profdata output') {
  if (typeof output !== 'string') throw new TypeError(`${label} must be text`);
  const lines = output.split(/\r?\n/);
  if (lines[0] !== 'Counters:') throw new Error(`${label} has an invalid all-functions header`);
  const records = [];
  const identities = new Set();
  let totalFunctions = null;
  for (let index = 1; index < lines.length; index += 1) {
    const functionMatch = /^ {2}(.+):$/.exec(lines[index]);
    if (functionMatch !== null) {
      const hashMatch = /^ {4}Hash: (0x[0-9a-fA-F]+)$/.exec(lines[index + 1] ?? '');
      if (hashMatch === null) {
        throw new Error(`${label} has a function without a CFG hash: ${functionMatch[1]}`);
      }
      const record = { name: functionMatch[1], cfgHash: hashMatch[1].toLowerCase() };
      const identity = JSON.stringify([record.name, record.cfgHash]);
      if (identities.has(identity)) {
        throw new Error(`${label} contains a duplicate name and CFG hash record: ${record.name}`);
      }
      identities.add(identity);
      records.push(record);
      index += 1;
      continue;
    }
    const totalMatch = /^Total functions: ([0-9]+)$/.exec(lines[index]);
    if (totalMatch !== null) {
      if (totalFunctions !== null) throw new Error(`${label} has multiple total-function summaries`);
      totalFunctions = Number.parseInt(totalMatch[1], 10);
    }
  }
  if (records.length === 0) throw new Error(`${label} contains no function records`);
  if (totalFunctions === null || totalFunctions !== records.length) {
    throw new Error(`${label} function records do not match its total-function summary`);
  }
  return records;
}

export function assertCoveredProfileFunction(output, profileName, sentinel) {
  const lines = output.split(/\r?\n/);
  if (lines.some((line) => line.trim() === sentinel)) return;
  throw new Error(`Merged ${profileName} profile did not execute required function ${sentinel}`);
}

export function computeFrrProfileCompositeSha256(profiles) {
  if (profiles === null || typeof profiles !== 'object' || Array.isArray(profiles)) {
    throw new TypeError('FRR profile records must be an object');
  }
  const hash = createHash('sha256');
  hash.update('anycast-lab-frr-profile-composite-v1\0');
  for (const { component, profile } of PGO_FRR_PROFILE_COMPONENTS.selected) {
    const record = profiles[component];
    if (
      record === null ||
      typeof record !== 'object' ||
      record.file !== profile ||
      !/^[a-f0-9]{64}$/.test(record.sha256)
    ) {
      throw new Error(`Invalid sealed FRR profile record for ${component}`);
    }
    hash.update(component);
    hash.update('\0');
    hash.update(profile);
    hash.update('\0');
    hash.update(record.sha256);
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function parsePgoUstar(archive, label = 'PGO archive') {
  if (!(archive instanceof Uint8Array)) throw new TypeError(`${label} must be bytes`);
  if (archive.byteLength < TAR_BLOCK_BYTES * 3 || archive.byteLength % TAR_BLOCK_BYTES !== 0) {
    throw new Error(`${label} has an invalid tar length`);
  }
  const entries = [];
  const names = new Set();
  let offset = 0;
  let trailer = false;
  while (offset < archive.byteLength) {
    const header = archive.subarray(offset, offset + TAR_BLOCK_BYTES);
    if (isZeroBlock(header)) {
      const second = archive.subarray(offset + TAR_BLOCK_BYTES, offset + TAR_BLOCK_BYTES * 2);
      if (second.byteLength !== TAR_BLOCK_BYTES || !isZeroBlock(second)) {
        throw new Error(`${label} has an incomplete tar trailer`);
      }
      for (let index = offset + TAR_BLOCK_BYTES * 2; index < archive.byteLength; index += 1) {
        if (archive[index] !== 0) throw new Error(`${label} has data after its tar trailer`);
      }
      trailer = true;
      break;
    }
    verifyTarChecksum(header, label);
    const magic = asciiField(header, 257, 8);
    if (magic !== 'ustar') throw new Error(`${label} contains a non-ustar header`);
    const prefix = asciiField(header, 345, 155);
    if (prefix !== '') throw new Error(`${label} profile paths must be flat`);
    const name = asciiField(header, 0, 100);
    if (!/^daemon-(bird|frr)_[A-Za-z0-9][A-Za-z0-9._-]*\.profraw$/.test(name)) {
      throw new Error(`${label} has an invalid profile name: ${name}`);
    }
    if (names.has(name)) throw new Error(`${label} contains a duplicate profile: ${name}`);
    names.add(name);
    const type = header[156];
    if (type !== 0 && type !== 0x30) throw new Error(`${label} profiles must be regular files`);
    const size = tarOctal(header, 124, 12, `${label} size`);
    if (size < 1 || size > MAX_PGO_PROFILE_BYTES) throw new Error(`${label} has an invalid profile size`);
    const contentsOffset = offset + TAR_BLOCK_BYTES;
    const paddedSize = Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
    const nextOffset = contentsOffset + paddedSize;
    if (nextOffset > archive.byteLength) throw new Error(`${label} is truncated`);
    for (let index = contentsOffset + size; index < nextOffset; index += 1) {
      if (archive[index] !== 0) throw new Error(`${label} has non-zero tar padding`);
    }
    entries.push({ name, contents: archive.slice(contentsOffset, contentsOffset + size) });
    if (entries.length > MAX_PGO_RAW_PROFILES) throw new Error(`${label} contains too many profiles`);
    offset = nextOffset;
  }
  if (!trailer) throw new Error(`${label} has no tar trailer`);
  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

export function parseVersions(contents) {
  const values = {};
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    if (line === '' || line.startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=([^\s]+)$/.exec(line);
    if (match === null) throw new Error(`Invalid versions.env line ${index + 1}`);
    const [, name, value] = match;
    if (Object.hasOwn(values, name)) throw new Error(`Duplicate versions.env key: ${name}`);
    values[name] = value;
  }
  for (const name of REQUIRED_VERSION_KEYS) {
    if (values[name] === undefined) throw new Error(`Missing versions.env key: ${name}`);
  }
  for (const name of REQUIRED_VERSION_KEYS.filter((key) => key.endsWith('_SHA256'))) {
    if (!/^[a-f0-9]{64}$/.test(values[name])) throw new Error(`Invalid SHA-256 in versions.env: ${name}`);
  }
  return values;
}

function validateManifestShape(value) {
  requireExactKeys(
    value,
    ['contextSha256', 'llvmVersion', 'profiles', 'schemaVersion', 'targetTriple', 'training'],
    PGO_PROFILE_SET_FILE,
  );
  if (value.schemaVersion !== PGO_PROFILE_SET_SCHEMA_VERSION) {
    throw new Error(`Unsupported PGO profile-set schema: ${String(value.schemaVersion)}`);
  }
  if (!/^[a-f0-9]{64}$/.test(value.contextSha256)) throw new Error('Invalid PGO context digest');
  if (typeof value.llvmVersion !== 'string' || typeof value.targetTriple !== 'string') {
    throw new Error('Invalid PGO profile-set toolchain identity');
  }
  requireExactKeys(value.profiles, Object.keys(PGO_PROFILE_FILES), 'profiles');
  for (const [name, file] of Object.entries(PGO_PROFILE_FILES)) {
    const profile = value.profiles[name];
    requireExactKeys(profile, ['bytes', 'file', 'sha256'], `profiles.${name}`);
    if (profile.file !== file) throw new Error(`Unexpected PGO profile filename for ${name}`);
    if (!Number.isSafeInteger(profile.bytes) || profile.bytes < 1 || profile.bytes > MAX_PGO_PROFILE_BYTES) {
      throw new Error(`Invalid PGO profile size for ${name}`);
    }
    if (!/^[a-f0-9]{64}$/.test(profile.sha256)) throw new Error(`Invalid PGO profile digest for ${name}`);
  }
  validateTrainingIdentityShape(value.training);
}

async function validateTrainingInputs({
  context,
  evidencePath,
  manifestPath,
  entriesByPackage,
}) {
  const evidenceFile = await readBoundedRegularFile(
    evidencePath,
    PGO_TRAINING_EVIDENCE_FILE,
    MAX_PGO_EVIDENCE_BYTES,
  );
  const evidence = parseJsonFile(evidenceFile.bytes, PGO_TRAINING_EVIDENCE_FILE);
  validateTrainingEvidenceShape(evidence);

  const manifestFile = await readBoundedRegularFile(
    manifestPath,
    'instrumented manifest',
    MAX_PGO_MANIFEST_BYTES,
  );
  const generateManifest = parseJsonFile(manifestFile.bytes, 'instrumented manifest');
  validateGenerateManifest(generateManifest, context);
  const manifestSha256 = sha256(manifestFile.bytes);
  if (evidence.buildId !== generateManifest.buildId) {
    throw new Error('Training evidence buildId does not match the instrumented manifest');
  }
  if (evidence.manifestSha256 !== manifestSha256) {
    throw new Error('Training evidence manifestSha256 does not match the instrumented manifest bytes');
  }

  const collections = new Map(evidence.collections.map((collection) => [collection.kind, collection]));
  for (const [kind, expectedNodeId] of [['bird', 'bird-native'], ['frr', 'frr-native']]) {
    const collection = collections.get(kind);
    if (collection === undefined || collection.nodeId !== expectedNodeId) {
      throw new Error(`Training evidence must contain ${expectedNodeId} as the ${kind} collection`);
    }
    const entries = entriesByPackage[kind];
    if (!Array.isArray(entries) || collection.files.length !== entries.length) {
      throw new Error(`Training evidence file count does not match the ${kind} archive`);
    }
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const file = collection.files[index];
      const expectedPath = `/${entry.name}`;
      if (
        file.path !== expectedPath ||
        file.size !== entry.contents.byteLength ||
        file.sha256 !== sha256(entry.contents)
      ) {
        throw new Error(`Training evidence does not match ${kind} archive entry ${expectedPath}`);
      }
    }
  }

  return {
    evidenceBytes: evidenceFile.bytes,
    identity: createTrainingIdentity(context, evidence, evidenceFile, manifestSha256),
  };
}

function validateGenerateManifest(value, context) {
  requireExactKeys(value, [
    'artifacts',
    'buildId',
    'buildroot',
    'daemons',
    'imageId',
    'machine',
    'pgo',
    'schemaVersion',
    'sourceDateEpoch',
    'toolchain',
    'v86',
  ], 'instrumented manifest');
  if (value.schemaVersion !== 1 || value.imageId !== 'anycast-lab-router') {
    throw new Error('Instrumented manifest has an unsupported identity');
  }
  if (value.buildId !== context.buildId) {
    throw new Error(`Instrumented manifest buildId must be ${context.buildId}`);
  }
  requireExactKeys(value.daemons, ['bird', 'frr'], 'instrumented manifest daemons');
  if (value.daemons.bird !== context.daemons.bird || value.daemons.frr !== context.daemons.frr) {
    throw new Error('Instrumented manifest daemon versions do not match the PGO context');
  }
  requireExactKeys(
    value.toolchain,
    ['compiler', 'compilerVersion', 'linker', 'lto', 'optimization', 'scope'],
    'instrumented manifest toolchain',
  );
  if (
    value.toolchain.scope !== 'bird-and-frr' ||
    value.toolchain.compiler !== 'clang' ||
    value.toolchain.compilerVersion !== context.llvm.version ||
    value.toolchain.linker !== context.optimization.linker ||
    value.toolchain.optimization !== context.optimization.level ||
    value.toolchain.lto !== context.optimization.lto
  ) {
    throw new Error('Instrumented manifest toolchain does not match the PGO context');
  }
  requireExactKeys(
    value.pgo,
    ['birdProfileSha256', 'contextSha256', 'frrProfileSha256', 'mode', 'profileSetBuildKey'],
    'instrumented manifest pgo',
  );
  if (value.pgo.mode !== 'generate') {
    throw new Error('Instrumented manifest PGO mode must be generate');
  }
  if (value.pgo.contextSha256 !== context.contextSha256) {
    throw new Error('Instrumented manifest PGO context is stale');
  }
  if (
    value.pgo.profileSetBuildKey !== null ||
    value.pgo.birdProfileSha256 !== null ||
    value.pgo.frrProfileSha256 !== null
  ) {
    throw new Error('Instrumented manifest must not contain profile-use identity');
  }
}

function validateTrainingEvidenceShape(value) {
  requireExactKeys(
    value,
    ['buildId', 'collections', 'manifestSha256', 'schemaVersion', 'workload'],
    PGO_TRAINING_EVIDENCE_FILE,
  );
  if (value.schemaVersion !== PGO_TRAINING_EVIDENCE_SCHEMA_VERSION) {
    throw new Error(`Unsupported training evidence schema: ${String(value.schemaVersion)}`);
  }
  if (typeof value.buildId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.buildId)) {
    throw new Error('Invalid training evidence buildId');
  }
  if (!/^[a-f0-9]{64}$/.test(value.manifestSha256)) {
    throw new Error('Invalid training evidence manifestSha256');
  }
  if (value.workload !== PGO_TRAINING_WORKLOAD) {
    throw new Error(`Training evidence workload must be ${PGO_TRAINING_WORKLOAD}`);
  }
  if (!Array.isArray(value.collections) || value.collections.length !== 2) {
    throw new Error('Training evidence must contain exactly two collections');
  }
  const kinds = new Set();
  const nodeIds = new Set();
  for (const collection of value.collections) {
    requireExactKeys(collection, ['files', 'kind', 'nodeId'], 'training evidence collection');
    if (collection.kind !== 'bird' && collection.kind !== 'frr') {
      throw new Error('Training evidence collection has an invalid kind');
    }
    if (collection.nodeId !== `${collection.kind}-native`) {
      throw new Error(`Training evidence has an invalid nodeId for ${collection.kind}`);
    }
    if (kinds.has(collection.kind) || nodeIds.has(collection.nodeId)) {
      throw new Error('Training evidence contains a duplicate collection');
    }
    kinds.add(collection.kind);
    nodeIds.add(collection.nodeId);
    if (
      !Array.isArray(collection.files) ||
      collection.files.length < 1 ||
      collection.files.length > MAX_PGO_RAW_PROFILES
    ) {
      throw new Error('Training evidence collection has an invalid file count');
    }
    let previousPath = '';
    const paths = new Set();
    for (const file of collection.files) {
      requireExactKeys(file, ['path', 'sha256', 'size'], 'training evidence file');
      const expectedProfilePath = new RegExp(`^/daemon-${collection.kind}_[A-Za-z0-9][A-Za-z0-9._-]*\\.profraw$`);
      if (!expectedProfilePath.test(file.path)) {
        throw new Error(`Training evidence has an invalid profile path: ${String(file.path)}`);
      }
      if (paths.has(file.path) || (previousPath !== '' && file.path.localeCompare(previousPath) <= 0)) {
        throw new Error('Training evidence profile paths must be unique and sorted');
      }
      paths.add(file.path);
      previousPath = file.path;
      if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_PGO_PROFILE_BYTES) {
        throw new Error(`Training evidence has an invalid profile size: ${file.path}`);
      }
      if (!/^[a-f0-9]{64}$/.test(file.sha256)) {
        throw new Error(`Training evidence has an invalid profile digest: ${file.path}`);
      }
    }
  }
  if (!kinds.has('bird') || !kinds.has('frr')) {
    throw new Error('Training evidence must contain BIRD and FRR collections');
  }
}

function createTrainingIdentity(context, evidence, evidenceFile, manifestSha256) {
  return {
    evidence: {
      file: PGO_TRAINING_EVIDENCE_FILE,
      bytes: evidenceFile.bytes.byteLength,
      sha256: sha256(evidenceFile.bytes),
    },
    buildId: evidence.buildId,
    manifestSha256,
    pgoMode: 'generate',
    contextSha256: context.contextSha256,
    workload: evidence.workload,
    collections: evidence.collections,
  };
}

function validateTrainingIdentityShape(value) {
  requireExactKeys(value, [
    'buildId',
    'collections',
    'contextSha256',
    'evidence',
    'manifestSha256',
    'pgoMode',
    'workload',
  ], 'training identity');
  requireExactKeys(value.evidence, ['bytes', 'file', 'sha256'], 'training evidence identity');
  if (
    value.evidence.file !== PGO_TRAINING_EVIDENCE_FILE ||
    !Number.isSafeInteger(value.evidence.bytes) ||
    value.evidence.bytes < 1 ||
    value.evidence.bytes > MAX_PGO_EVIDENCE_BYTES ||
    !/^[a-f0-9]{64}$/.test(value.evidence.sha256)
  ) {
    throw new Error('Invalid stored training evidence identity');
  }
  if (
    typeof value.buildId !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.manifestSha256) ||
    !/^[a-f0-9]{64}$/.test(value.contextSha256) ||
    value.pgoMode !== 'generate' ||
    value.workload !== PGO_TRAINING_WORKLOAD
  ) {
    throw new Error('Invalid stored training run identity');
  }
  validateTrainingEvidenceShape({
    schemaVersion: PGO_TRAINING_EVIDENCE_SCHEMA_VERSION,
    buildId: value.buildId,
    manifestSha256: value.manifestSha256,
    workload: value.workload,
    collections: value.collections,
  });
}

async function validateStoredTrainingEvidence(context, directory, training) {
  if (training === undefined) {
    throw new Error('A validated training identity is required to seal PGO profiles');
  }
  validateTrainingIdentityShape(training);
  if (training.buildId !== context.buildId) {
    throw new Error(`Stored training buildId must be ${context.buildId}`);
  }
  if (training.contextSha256 !== context.contextSha256) {
    throw new Error('Stored training evidence belongs to a stale PGO context');
  }
  const evidenceFile = await readBoundedRegularFile(
    resolve(directory, PGO_TRAINING_EVIDENCE_FILE),
    PGO_TRAINING_EVIDENCE_FILE,
    MAX_PGO_EVIDENCE_BYTES,
  );
  const evidence = parseJsonFile(evidenceFile.bytes, PGO_TRAINING_EVIDENCE_FILE);
  validateTrainingEvidenceShape(evidence);
  const expected = createTrainingIdentity(
    context,
    evidence,
    evidenceFile,
    evidence.manifestSha256,
  );
  if (JSON.stringify(training) !== JSON.stringify(expected)) {
    throw new Error('Stored training evidence does not match the sealed training identity');
  }
  return training;
}

function requireExactKeys(value, expected, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
    throw new Error(`${label} has unexpected fields`);
  }
}

function verifyTarChecksum(header, label) {
  const expected = tarOctal(header, 148, 8, `${label} checksum`);
  let actual = 0;
  for (let index = 0; index < header.byteLength; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  if (actual !== expected) throw new Error(`${label} has an invalid tar checksum`);
}

function tarOctal(bytes, offset, length, label) {
  const field = bytes.subarray(offset, offset + length);
  const raw = Buffer.from(field).toString('latin1').replace(/^[\0 ]+|[\0 ]+$/g, '');
  if (!/^[0-7]*$/.test(raw)) throw new Error(`${label} is not octal`);
  const value = raw;
  if (value === '') return 0;
  const result = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(result)) throw new Error(`${label} is too large`);
  return result;
}

function asciiField(bytes, offset, length) {
  const field = bytes.subarray(offset, offset + length);
  const zero = field.indexOf(0);
  const value = field.subarray(0, zero < 0 ? field.length : zero);
  for (const byte of value) {
    if (byte < 0x20 || byte > 0x7e) throw new Error('PGO tar field is not printable ASCII');
  }
  return Buffer.from(value).toString('ascii').replace(/\s+$/, '');
}

function isZeroBlock(bytes) {
  return bytes.byteLength === TAR_BLOCK_BYTES && bytes.every((byte) => byte === 0);
}

async function inspectProfile(path, file) {
  const metadata = await requireRegularFile(path, file);
  if (metadata.size < 1) throw new Error(`PGO profile is empty: ${file}`);
  if (metadata.size > MAX_PGO_PROFILE_BYTES) {
    throw new Error(`PGO profile exceeds ${MAX_PGO_PROFILE_BYTES} bytes: ${file}`);
  }
  const bytes = await readFile(path);
  if (bytes.byteLength !== metadata.size) throw new Error(`PGO profile changed while it was being read: ${file}`);
  return {
    file,
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
  };
}

async function readBoundedRegularFile(path, label, maximumBytes) {
  const metadata = await requireRegularFile(path, label);
  if (metadata.size < 1) throw new Error(`${label} is empty`);
  if (metadata.size > maximumBytes) throw new Error(`${label} exceeds ${maximumBytes} bytes`);
  const bytes = await readFile(path);
  if (bytes.byteLength !== metadata.size) throw new Error(`${label} changed while it was being read`);
  return { bytes, size: metadata.size };
}

function parseJsonFile(bytes, label) {
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch (error) {
    throw new Error(`Invalid ${label}: ${errorMessage(error)}`);
  }
}

async function requireRegularFile(path, label) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    throw new Error(`Missing PGO file ${label}: ${errorMessage(error)}`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`PGO file must be a regular file, not a symlink: ${label}`);
  }
  return metadata;
}

function profileBuildKey(manifest) {
  return sha256(Buffer.from(JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    contextSha256: manifest.contextSha256,
    llvmVersion: manifest.llvmVersion,
    targetTriple: manifest.targetTriple,
    training: manifest.training,
    profiles: manifest.profiles,
  })));
}

async function writeJsonAtomically(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function option(arguments_, name) {
  const index = arguments_.indexOf(name);
  if (index < 0 || index + 1 >= arguments_.length) throw new Error(`Missing ${name}`);
  return arguments_[index + 1];
}

function requirePathOption(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`);
}

async function main(arguments_) {
  const [command, ...options] = arguments_;
  const root = option(options, '--root');
  if (command === 'context') {
    const context = await writePgoContext(root, option(options, '--output'));
    process.stdout.write(`${context.contextSha256}\n`);
    return;
  }
  const profileDirectory = option(options, '--profile-dir');
  if (command === 'validate') {
    const result = await validatePgoProfileSet(root, profileDirectory);
    process.stdout.write(`${result.buildKey}\n`);
    return;
  }
  if (command === 'frr-digest') {
    const result = await validatePgoProfileSet(root, profileDirectory);
    process.stdout.write(`${computeFrrProfileCompositeSha256(result.manifest.profiles)}\n`);
    return;
  }
  if (command === 'merge') {
    const result = await mergePgoProfileArchives({
      root,
      profileDirectory,
      buildOutput: option(options, '--build-output'),
      birdArchive: option(options, '--bird-archive'),
      frrArchive: option(options, '--frr-archive'),
      evidence: option(options, '--evidence'),
      manifest: option(options, '--manifest'),
    });
    process.stdout.write(`${result.buildKey}\n`);
    return;
  }
  throw new Error(
    'Usage: pgo-profile-set.mjs context|validate|frr-digest|merge --root PATH ' +
    '[--output FILE|--profile-dir DIR --build-output DIR --bird-archive FILE --frr-archive FILE ' +
    '--evidence FILE --manifest FILE]',
  );
}

const script = process.argv[1];
if (script !== undefined && import.meta.url === pathToFileURL(resolve(script)).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
