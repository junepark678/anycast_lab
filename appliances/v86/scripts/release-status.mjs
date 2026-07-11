#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { verifyV86ArtifactBundle } from './verify-manifest.mjs';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CHANNEL_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const REVISION_PATTERN = /^[a-f0-9]{40}$/;
const RELEASE_STATUS_KEYS = new Set([
  'schemaVersion',
  'nativeV86',
  'channel',
  'manifestUrl',
  'manifestSha256',
  'buildId',
  'memoryBytes',
  'publishedAt',
  'sourceRevision',
]);

export async function createReleaseStatus(options) {
  const recordedDigest = await readRecordedDigest(options.manifestSha256Path);
  const verified = await verifyV86ArtifactBundle(options.manifestPath, {
    expectedManifestSha256: recordedDigest,
  });
  const { manifest, manifestSha256 } = verified;

  assertChannel(options.channel);
  assertManifestUrl(options.manifestUrl, manifestSha256);
  assertSourceRevision(options.sourceRevision);
  const publishedAt = options.publishedAt ?? new Date().toISOString();
  assertPublishedAt(publishedAt);

  return {
    schemaVersion: 1,
    nativeV86: true,
    channel: options.channel,
    manifestUrl: options.manifestUrl,
    manifestSha256,
    buildId: manifest.buildId,
    memoryBytes: manifest.machine.memoryBytes,
    publishedAt,
    sourceRevision: options.sourceRevision,
  };
}

export async function validateReleaseStatus(status, options = {}) {
  if (!isRecord(status)) throw new Error('Release status must be an object');
  const keys = Object.keys(status);
  if (keys.length !== RELEASE_STATUS_KEYS.size || keys.some((key) => !RELEASE_STATUS_KEYS.has(key))) {
    throw new Error('Release status has unexpected or missing fields');
  }
  if (status.schemaVersion !== 1) throw new Error('Unsupported release status schema');
  if (status.nativeV86 !== true) throw new Error('Release status must enable nativeV86');
  assertChannel(status.channel);
  assertSha256('manifestSha256', status.manifestSha256);
  assertManifestUrl(status.manifestUrl, status.manifestSha256);
  if (typeof status.buildId !== 'string' || status.buildId.length === 0) {
    throw new Error('Release status has an invalid buildId');
  }
  if (!Number.isSafeInteger(status.memoryBytes) || status.memoryBytes <= 0) {
    throw new Error('Release status has an invalid memoryBytes');
  }
  assertPublishedAt(status.publishedAt);
  assertSourceRevision(status.sourceRevision);

  if (options.manifestPath !== undefined) {
    const expected = await createReleaseStatus({
      manifestPath: options.manifestPath,
      manifestSha256Path: options.manifestSha256Path,
      manifestUrl: options.manifestUrl ?? status.manifestUrl,
      channel: options.channel ?? status.channel,
      sourceRevision: options.sourceRevision ?? status.sourceRevision,
      publishedAt: options.publishedAt ?? status.publishedAt,
    });
    for (const key of Object.keys(expected)) {
      if (status[key] !== expected[key]) {
        throw new Error(`Release status ${key} does not match the appliance release`);
      }
    }
  }
  return status;
}

async function readRecordedDigest(path) {
  const contents = await readFile(path, 'utf8');
  const match = /^([a-f0-9]{64})[ ]{2}manifest\.json\n?$/.exec(contents);
  if (match === null) throw new Error('manifest.sha256 has an invalid format');
  return match[1];
}

function assertManifestUrl(value, digest) {
  if (typeof value !== 'string') throw new Error('manifestUrl must be a string');
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error('manifestUrl must be an absolute URL', { cause: error });
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    throw new Error('manifestUrl must be an HTTPS URL without credentials');
  }
  if (url.search !== '' || url.hash !== '' || !url.pathname.endsWith('/manifest.json')) {
    throw new Error('manifestUrl must identify manifest.json without a query or fragment');
  }
  if (!url.pathname.split('/').includes(digest)) {
    throw new Error('manifestUrl must be namespaced by the manifest SHA-256 digest');
  }
}

function assertChannel(value) {
  if (typeof value !== 'string' || !CHANNEL_PATTERN.test(value)) {
    throw new Error('channel must contain only lowercase letters, digits, dots, underscores, and hyphens');
  }
}

function assertSourceRevision(value) {
  if (typeof value !== 'string' || !REVISION_PATTERN.test(value)) {
    throw new Error('sourceRevision must be a lowercase 40-character Git commit SHA');
  }
}

function assertPublishedAt(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new Error('publishedAt must be a canonical UTC timestamp');
  }
  if (new Date(value).toISOString() !== value) throw new Error('publishedAt is not a real timestamp');
}

function assertSha256(name, value) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new Error(`${name} must be a lowercase SHA-256 digest`);
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseArguments(argv) {
  const [command, ...tokens] = argv;
  const values = new Map();
  for (let index = 0; index < tokens.length; index += 2) {
    const name = tokens[index];
    const value = tokens[index + 1];
    if (!name?.startsWith('--') || value === undefined) {
      throw new Error(`Invalid argument near ${name ?? '<end>'}`);
    }
    if (values.has(name)) throw new Error(`Duplicate argument ${name}`);
    values.set(name, value);
  }
  return { command, values };
}

function required(values, name) {
  const value = values.get(name);
  if (value === undefined || value === '') throw new Error(`Missing required argument ${name}`);
  return value;
}

async function main(argv) {
  const { command, values } = parseArguments(argv);
  if (command === 'create') {
    const output = required(values, '--output');
    const status = await createReleaseStatus({
      manifestPath: required(values, '--manifest'),
      manifestSha256Path: required(values, '--manifest-sha256'),
      manifestUrl: required(values, '--manifest-url'),
      channel: required(values, '--channel'),
      sourceRevision: required(values, '--source-revision'),
      publishedAt: values.get('--published-at'),
    });
    await writeFile(output, `${JSON.stringify(status, null, 2)}\n`);
    return;
  }
  if (command === 'validate') {
    const statusPath = required(values, '--status');
    const status = JSON.parse(await readFile(statusPath, 'utf8'));
    await validateReleaseStatus(status, {
      manifestPath: values.get('--manifest'),
      manifestSha256Path: values.get('--manifest-sha256'),
      manifestUrl: values.get('--manifest-url'),
      channel: values.get('--channel'),
      sourceRevision: values.get('--source-revision'),
      publishedAt: values.get('--published-at'),
    });
    return;
  }
  throw new Error('Usage: release-status.mjs <create|validate> [options]');
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
