// @vitest-environment node
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { createReleaseStatus } from './release-status.mjs';
import { PINNED_V86_MANIFEST_IDENTITY } from './verify-manifest.mjs';

const execute = promisify(execFile);
const publisher = resolve(import.meta.dirname, 'publish-oci.sh');
const temporaryDirectories = [];

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function temporaryDirectory() {
  const directory = await mkdtemp(resolve(tmpdir(), 'anycast-oci-publish-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function createFixture(root) {
  const artifactDirectory = resolve(root, 'artifacts');
  await mkdir(artifactDirectory, { recursive: true });
  const definitions = [
    ['v86-wasm', 'v86.wasm'],
    ['bios', 'seabios.bin'],
    ['vga-bios', 'vgabios.bin'],
    ['bzimage', 'router-bzimage.bin'],
  ];
  const artifacts = [];
  for (const [id, file] of definitions) {
    const bytes = Buffer.from(`publish:${id}`);
    await writeFile(resolve(artifactDirectory, file), bytes);
    artifacts.push({ id, file, size: bytes.byteLength, sha256: digest(bytes) });
  }
  const manifestBytes = Buffer.from(`${JSON.stringify({
    ...PINNED_V86_MANIFEST_IDENTITY,
    machine: {
      memoryBytes: 128 * 1024 * 1024,
      vgaMemoryBytes: 2 * 1024 * 1024,
      trunkMtu: 65_535,
    },
    artifacts,
  }, null, 2)}\n`);
  const manifestDigest = digest(manifestBytes);
  const manifestPath = resolve(artifactDirectory, 'manifest.json');
  const manifestSha256Path = resolve(artifactDirectory, 'manifest.sha256');
  await writeFile(manifestPath, manifestBytes);
  await writeFile(manifestSha256Path, `${manifestDigest}  manifest.json\n`);

  const statusPath = resolve(root, 'status.json');
  const status = await createReleaseStatus({
    manifestPath,
    manifestSha256Path,
    manifestUrl: `https://testns.objectstorage.test-region.oci.customer-oci.com/n/testns/b/testbucket/o/anycast-lab/native-v86/objects/sha256/${manifestDigest}/manifest.json`,
    channel: 'stable',
    generation: 7,
    sourceRevision: 'a'.repeat(40),
    publishedAt: '2026-07-11T00:00:00.000Z',
  });
  await writeFile(statusPath, `${JSON.stringify(status, null, 2)}\n`);
  return { artifactDirectory, manifestDigest, statusPath };
}

async function createMockCurl(root) {
  const executable = resolve(root, 'bin/curl');
  await mkdir(dirname(executable), { recursive: true });
  await writeFile(executable, `#!/usr/bin/env node
import { access, appendFile, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const optionValues = (name) => args.flatMap((value, index) => value === name ? [args[index + 1]] : []);
const method = option('--request') ?? (args.includes('--upload-file') ? 'PUT' : 'GET');
const url = new URL(args.at(-1));
const objectMarker = '/o/';
const markerIndex = url.pathname.indexOf(objectMarker);
if (markerIndex === -1) throw new Error('Mock OCI URL has no object marker');
const key = decodeURIComponent(url.pathname.slice(markerIndex + objectMarker.length));
const authenticated = url.pathname.includes('/p/');
const objectPath = resolve(process.env.MOCK_OCI_DIRECTORY, key);
await appendFile(process.env.MOCK_OCI_LOG, method + ' ' + (authenticated ? 'par ' : 'public ') + key + '\\n');

let exists = true;
try {
  await access(objectPath);
} catch {
  exists = false;
}

const raced = method === 'GET' && authenticated && !exists && key === process.env.MOCK_RACE_KEY;
if (raced) {
  await mkdir(dirname(objectPath), { recursive: true });
  await copyFile(process.env.MOCK_RACE_SOURCE, objectPath);
  await writeFile(objectPath + '.content-type', 'application/json');
}

let status;
if (method === 'PUT') {
  const headers = optionValues('--header');
  const ifNoneMatch = headers.includes('If-None-Match: *');
  await appendFile(
    process.env.MOCK_OCI_METADATA_LOG,
    key + ' ' + headers.filter((header) => /^(Content-Type|Cache-Control|If-None-Match):/.test(header)).join(' | ') + '\\n',
  );
  if (ifNoneMatch && exists) {
    status = 412;
  } else {
    await mkdir(dirname(objectPath), { recursive: true });
    await copyFile(option('--upload-file'), objectPath);
    const contentType = headers.find((header) => header.startsWith('Content-Type: ')).replace(/^Content-Type: /, '');
    await writeFile(objectPath + '.content-type', contentType);
    status = 200;
  }
  const output = option('--output');
  if (output !== undefined) await writeFile(output, '');
} else if (key === process.env.MOCK_AUTH_FAILURE_KEY) {
  status = 403;
  await writeFile(option('--output'), '{"code":"NotAuthenticated"}');
} else if (exists) {
  status = 200;
  await copyFile(objectPath, option('--output'));
} else {
  status = 404;
  await writeFile(option('--output'), '{"code":"NotFound"}');
}

const headerPath = option('--dump-header');
if (headerPath !== undefined) {
  const requestedOrigin = (optionValues('--header').find((header) => header.startsWith('Origin: ')) ?? '')
    .replace(/^Origin: /, '');
  const allowedOrigin = process.env.MOCK_CORS_ORIGIN ?? requestedOrigin;
  const contentType = exists ? await readFile(objectPath + '.content-type', 'utf8') : 'application/octet-stream';
  await writeFile(
    headerPath,
    process.env.MOCK_CORS_HEADERS ??
      ('HTTP/1.1 ' + status + '\\r\\naccess-control-allow-origin: ' + allowedOrigin +
        '\\r\\ncontent-type: ' + contentType + '\\r\\n\\r\\n'),
  );
}
if (option('--write-out') !== undefined) process.stdout.write(String(status));
`);
  await chmod(executable, 0o755);
  return resolve(root, 'bin');
}

function environment(root, fixture, bin) {
  return {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    OCI_PAR_BASE_URL: 'https://objectstorage.test-region.oraclecloud.com/p/testtoken/n/testns/b/testbucket/o',
    OCI_PUBLIC_BASE_URL: 'https://testns.objectstorage.test-region.oci.customer-oci.com/n/testns/b/testbucket/o',
    OCI_OBJECT_PREFIX: 'anycast-lab/native-v86',
    OCI_CORS_ORIGIN: 'https://anycast.guide',
    RELEASE_CHANNEL: 'stable',
    RELEASE_STATUS_PATH: fixture.statusPath,
    SOURCE_REVISION: 'a'.repeat(40),
    ARTIFACT_DIR: fixture.artifactDirectory,
    MOCK_OCI_DIRECTORY: resolve(root, 'oci'),
    MOCK_OCI_LOG: resolve(root, 'curl.log'),
    MOCK_OCI_METADATA_LOG: resolve(root, 'metadata.log'),
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('publish-oci.sh', () => {
  it('publishes verified immutable objects and writes the channel status last', async () => {
    const root = await temporaryDirectory();
    const fixture = await createFixture(root);
    const bin = await createMockCurl(root);
    const env = environment(root, fixture, bin);
    await execute('bash', [publisher], { env });

    const writes = (await readFile(env.MOCK_OCI_LOG, 'utf8'))
      .trim().split('\n').filter((line) => line.startsWith('PUT par '));
    expect(writes).toHaveLength(7);
    expect(writes.at(-1)).toBe('PUT par anycast-lab/native-v86/channels/stable/status.json');
    for (const file of ['manifest.json', 'manifest.sha256', 'router-bzimage.bin', 'seabios.bin', 'vgabios.bin', 'v86.wasm']) {
      expect(writes).toContain(
        `PUT par anycast-lab/native-v86/objects/sha256/${fixture.manifestDigest}/${file}`,
      );
    }
    const metadata = await readFile(env.MOCK_OCI_METADATA_LOG, 'utf8');
    expect(metadata).toContain('v86.wasm Content-Type: application/wasm | Cache-Control: public, max-age=31536000, immutable | If-None-Match: *');
    expect(metadata).toContain('status.json Content-Type: application/json | Cache-Control: no-store, max-age=0');
  });

  it('reuses identical immutable objects without rewriting them', async () => {
    const root = await temporaryDirectory();
    const fixture = await createFixture(root);
    const bin = await createMockCurl(root);
    const env = environment(root, fixture, bin);
    await execute('bash', [publisher], { env });
    await writeFile(env.MOCK_OCI_LOG, '');
    await execute('bash', [publisher], { env });

    const writes = (await readFile(env.MOCK_OCI_LOG, 'utf8'))
      .trim().split('\n').filter((line) => line.startsWith('PUT par '));
    expect(writes).toEqual(['PUT par anycast-lab/native-v86/channels/stable/status.json']);
  });

  it('refuses to replace a digest-addressed object containing different bytes', async () => {
    const root = await temporaryDirectory();
    const fixture = await createFixture(root);
    const bin = await createMockCurl(root);
    const env = environment(root, fixture, bin);
    await execute('bash', [publisher], { env });
    await writeFile(env.MOCK_OCI_LOG, '');
    await writeFile(
      resolve(env.MOCK_OCI_DIRECTORY, `anycast-lab/native-v86/objects/sha256/${fixture.manifestDigest}/manifest.json`),
      'different',
    );

    await expect(execute('bash', [publisher], { env })).rejects.toMatchObject({
      stderr: expect.stringContaining('Refusing to replace immutable OCI object'),
    });
    const writes = (await readFile(env.MOCK_OCI_LOG, 'utf8'))
      .trim().split('\n').filter((line) => line.startsWith('PUT par '));
    expect(writes).not.toContain('PUT par anycast-lab/native-v86/channels/stable/status.json');
  });

  it('accepts an identical conditional-upload race without replacing the object', async () => {
    const root = await temporaryDirectory();
    const fixture = await createFixture(root);
    const bin = await createMockCurl(root);
    const env = environment(root, fixture, bin);
    env.MOCK_RACE_KEY = `anycast-lab/native-v86/objects/sha256/${fixture.manifestDigest}/manifest.json`;
    env.MOCK_RACE_SOURCE = resolve(fixture.artifactDirectory, 'manifest.json');

    await execute('bash', [publisher], { env });
    const writes = (await readFile(env.MOCK_OCI_LOG, 'utf8'))
      .trim().split('\n').filter((line) => line.startsWith('PUT par '));
    expect(writes.at(-1)).toBe('PUT par anycast-lab/native-v86/channels/stable/status.json');
  });

  it('rejects a conflicting conditional-upload race and preserves the channel', async () => {
    const root = await temporaryDirectory();
    const fixture = await createFixture(root);
    const bin = await createMockCurl(root);
    const env = environment(root, fixture, bin);
    const conflicting = resolve(root, 'conflicting-manifest.json');
    await writeFile(conflicting, 'different');
    env.MOCK_RACE_KEY = `anycast-lab/native-v86/objects/sha256/${fixture.manifestDigest}/manifest.json`;
    env.MOCK_RACE_SOURCE = conflicting;

    await expect(execute('bash', [publisher], { env })).rejects.toMatchObject({
      stderr: expect.stringContaining('OCI object verification failed after upload'),
    });
    const writes = (await readFile(env.MOCK_OCI_LOG, 'utf8'))
      .trim().split('\n').filter((line) => line.startsWith('PUT par '));
    expect(writes).not.toContain('PUT par anycast-lab/native-v86/channels/stable/status.json');
  });

  it('treats PAR authorization failures as fatal rather than missing objects', async () => {
    const root = await temporaryDirectory();
    const fixture = await createFixture(root);
    const bin = await createMockCurl(root);
    const env = environment(root, fixture, bin);
    env.MOCK_AUTH_FAILURE_KEY = `anycast-lab/native-v86/objects/sha256/${fixture.manifestDigest}/manifest.json`;

    await expect(execute('bash', [publisher], { env })).rejects.toMatchObject({
      stderr: expect.stringContaining('HTTP 403'),
    });
    const writes = (await readFile(env.MOCK_OCI_LOG, 'utf8'))
      .trim().split('\n').filter((line) => line.startsWith('PUT par '));
    expect(writes).toEqual([]);
  });

  it('refuses to move a channel backward to an older workflow generation', async () => {
    const root = await temporaryDirectory();
    const fixture = await createFixture(root);
    const bin = await createMockCurl(root);
    const env = environment(root, fixture, bin);
    const existingStatus = JSON.parse(await readFile(fixture.statusPath, 'utf8'));
    existingStatus.generation += 1;
    const statusObject = resolve(
      env.MOCK_OCI_DIRECTORY,
      'anycast-lab/native-v86/channels/stable/status.json',
    );
    await mkdir(dirname(statusObject), { recursive: true });
    await writeFile(statusObject, `${JSON.stringify(existingStatus, null, 2)}\n`);

    await expect(execute('bash', [publisher], { env })).rejects.toMatchObject({
      stderr: expect.stringContaining('older generation'),
    });
    const writes = (await readFile(env.MOCK_OCI_LOG, 'utf8'))
      .trim().split('\n').filter((line) => line.startsWith('PUT par '));
    expect(writes).not.toContain('PUT par anycast-lab/native-v86/channels/stable/status.json');
  });

  it('advances a channel from a lower workflow generation', async () => {
    const root = await temporaryDirectory();
    const fixture = await createFixture(root);
    const bin = await createMockCurl(root);
    const env = environment(root, fixture, bin);
    const existingStatus = JSON.parse(await readFile(fixture.statusPath, 'utf8'));
    existingStatus.generation -= 1;
    const statusObject = resolve(
      env.MOCK_OCI_DIRECTORY,
      'anycast-lab/native-v86/channels/stable/status.json',
    );
    await mkdir(dirname(statusObject), { recursive: true });
    await writeFile(statusObject, `${JSON.stringify(existingStatus, null, 2)}\n`);

    await execute('bash', [publisher], { env });

    const publishedStatus = JSON.parse(await readFile(statusObject, 'utf8'));
    expect(publishedStatus.generation).toBe(7);
    const writes = (await readFile(env.MOCK_OCI_LOG, 'utf8'))
      .trim().split('\n').filter((line) => line.startsWith('PUT par '));
    expect(writes.at(-1)).toBe('PUT par anycast-lab/native-v86/channels/stable/status.json');
  });

  it('fails before contacting OCI when publish configuration is missing', async () => {
    const root = await temporaryDirectory();
    const fixture = await createFixture(root);
    const bin = await createMockCurl(root);
    const env = environment(root, fixture, bin);
    delete env.OCI_PAR_BASE_URL;

    await expect(execute('bash', [publisher], { env })).rejects.toMatchObject({
      stderr: expect.stringContaining('Required OCI publish configuration is missing: OCI_PAR_BASE_URL'),
    });
    await expect(readFile(env.MOCK_OCI_LOG, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a path-normalizing OCI prefix before contacting object storage', async () => {
    const root = await temporaryDirectory();
    const fixture = await createFixture(root);
    const bin = await createMockCurl(root);
    const env = environment(root, fixture, bin);
    env.OCI_OBJECT_PREFIX = 'anycast-lab/./native-v86';

    await expect(execute('bash', [publisher], { env })).rejects.toMatchObject({
      stderr: expect.stringContaining('Invalid OCI object prefix'),
    });
    await expect(readFile(env.MOCK_OCI_LOG, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not advance the channel when the public origin lacks browser CORS', async () => {
    const root = await temporaryDirectory();
    const fixture = await createFixture(root);
    const bin = await createMockCurl(root);
    const env = environment(root, fixture, bin);
    env.MOCK_CORS_ORIGIN = 'https://wrong.example';

    await expect(execute('bash', [publisher], { env })).rejects.toMatchObject({
      stderr: expect.stringContaining('does not allow browser requests'),
    });
    const writes = (await readFile(env.MOCK_OCI_LOG, 'utf8'))
      .trim().split('\n').filter((line) => line.startsWith('PUT par '));
    expect(writes).not.toContain('PUT par anycast-lab/native-v86/channels/stable/status.json');
  });

  it('checks CORS on the final response rather than a failed retry response', async () => {
    const root = await temporaryDirectory();
    const fixture = await createFixture(root);
    const bin = await createMockCurl(root);
    const env = environment(root, fixture, bin);
    env.MOCK_CORS_HEADERS = [
      'HTTP/1.1 500',
      'access-control-allow-origin: https://anycast.guide',
      '',
      'HTTP/1.1 200',
      '',
      '',
    ].join('\r\n');

    await expect(execute('bash', [publisher], { env })).rejects.toMatchObject({
      stderr: expect.stringContaining('does not allow browser requests'),
    });
    const writes = (await readFile(env.MOCK_OCI_LOG, 'utf8'))
      .trim().split('\n').filter((line) => line.startsWith('PUT par '));
    expect(writes).not.toContain('PUT par anycast-lab/native-v86/channels/stable/status.json');
  });

  it('does not advance the channel when OCI serves the wrong metadata type', async () => {
    const root = await temporaryDirectory();
    const fixture = await createFixture(root);
    const bin = await createMockCurl(root);
    const env = environment(root, fixture, bin);
    env.MOCK_CORS_HEADERS = [
      'HTTP/1.1 200',
      'access-control-allow-origin: *',
      'content-type: application/octet-stream',
      '',
      '',
    ].join('\r\n');

    await expect(execute('bash', [publisher], { env })).rejects.toMatchObject({
      stderr: expect.stringContaining('unexpected Content-Type'),
    });
    const writes = (await readFile(env.MOCK_OCI_LOG, 'utf8'))
      .trim().split('\n').filter((line) => line.startsWith('PUT par '));
    expect(writes).not.toContain('PUT par anycast-lab/native-v86/channels/stable/status.json');
  });
});
