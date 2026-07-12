import { access, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import { verifyV86ArtifactBundle } from '../appliances/v86/scripts/verify-manifest.mjs';

const root = resolve(import.meta.dirname, '..');
const source = resolve(
  process.env.ANYCAST_LAB_NATIVE_ARTIFACT_DIR ?? resolve(root, 'appliances/v86/dist'),
);
const runtimeOutput = resolve(
  process.env.ANYCAST_LAB_RUNTIME_OUTPUT_DIR ?? resolve(root, 'public/runtime'),
);
const destination = resolve(runtimeOutput, 'v86');
const statusPath = resolve(runtimeOutput, 'status.json');
const requireNative = process.env.ANYCAST_LAB_REQUIRE_NATIVE === '1';
const externalStatusUrl = process.env.ANYCAST_LAB_NATIVE_STATUS_URL?.trim();
const mode = process.env.ANYCAST_LAB_NATIVE_MODE ?? 'auto';
if (!['auto', 'external', 'local', 'disabled'].includes(mode)) {
  throw new Error(`Unsupported ANYCAST_LAB_NATIVE_MODE: ${mode}`);
}

function isNotFound(error) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function parseExternalStatusUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error('ANYCAST_LAB_NATIVE_STATUS_URL must be an absolute URL', { cause: error });
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('The external native status URL must use HTTPS (HTTP is allowed only for loopback development)');
  }
  if (url.username !== '' || url.password !== '' || url.hash !== '') {
    throw new Error('The external native status URL cannot contain credentials or a fragment');
  }
  return url.href;
}

async function verifyLocalBundle() {
  try {
    await access(source, constants.R_OK);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }

  const manifestPath = resolve(source, 'manifest.json');
  const digestPath = resolve(source, 'manifest.sha256');
  const digestLine = await readFile(digestPath, 'utf8');
  const expectedDigest = digestLine.trim().split(/\s+/)[0] ?? '';
  if (!/^[a-f0-9]{64}$/.test(expectedDigest)) throw new Error('v86 manifest.sha256 is invalid');
  const verified = await verifyV86ArtifactBundle(manifestPath, {
    expectedManifestSha256: expectedDigest,
    requiredFilesystem: true,
  });
  return { ...verified, digestPath };
}

let status;
let localBundle = null;
const useExternal = mode === 'external' || (mode === 'auto' && externalStatusUrl !== undefined && externalStatusUrl !== '');
if (useExternal && externalStatusUrl !== undefined && externalStatusUrl !== '') {
  status = {
    schemaVersion: 1,
    nativeV86: true,
    releaseStatusUrl: parseExternalStatusUrl(externalStatusUrl),
  };
} else if (mode === 'external' || mode === 'disabled') {
  if (requireNative) {
    throw new Error(mode === 'external'
      ? 'Native runtime is required but ANYCAST_LAB_NATIVE_STATUS_URL is not configured'
      : 'Native runtime is required but deployment mode is disabled');
  }
  status = { schemaVersion: 1, nativeV86: false };
} else {
  localBundle = await verifyLocalBundle();
  if (localBundle === null) {
    if (requireNative) {
      throw new Error('Native runtime artifacts are required but no local bundle or external status URL was configured');
    }
    status = { schemaVersion: 1, nativeV86: false };
  } else {
    status = {
      schemaVersion: 1,
      nativeV86: true,
      manifestSha256: localBundle.manifestSha256,
      buildId: localBundle.manifest.buildId,
      memoryBytes: localBundle.memoryBytes,
    };
  }
}

// Validation happens before replacing build output. A corrupt or partial
// native bundle therefore fails without leaving a misleading deployment.
await rm(runtimeOutput, { recursive: true, force: true });
await mkdir(runtimeOutput, { recursive: true });
if (localBundle !== null) {
  await mkdir(destination, { recursive: true });
  await copyFile(localBundle.manifestPath, resolve(destination, 'manifest.json'));
  await copyFile(localBundle.digestPath, resolve(destination, 'manifest.sha256'));
  await Promise.all(localBundle.artifacts.map((artifact) => (
    copyFile(artifact.path, resolve(destination, artifact.file))
  )));
  await Promise.all(localBundle.filesystemLayers.map((layer) => (
    copyFile(layer.path, resolve(destination, layer.file))
  )));
}
await writeFile(statusPath, `${JSON.stringify(status, null, 2)}\n`);
