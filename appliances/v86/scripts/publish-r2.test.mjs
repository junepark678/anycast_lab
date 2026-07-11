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
const publisher = resolve(import.meta.dirname, 'publish-r2.sh');
const temporaryDirectories = [];

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function temporaryDirectory() {
  const directory = await mkdtemp(resolve(tmpdir(), 'anycast-r2-publish-'));
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
    manifestUrl: `https://assets.example/anycast-lab/native-v86/objects/sha256/${manifestDigest}/manifest.json`,
    channel: 'stable',
    sourceRevision: 'a'.repeat(40),
    publishedAt: '2026-07-11T00:00:00.000Z',
  });
  await writeFile(statusPath, `${JSON.stringify(status, null, 2)}\n`);
  return { artifactDirectory, manifestDigest, statusPath };
}

async function createMockAws(root) {
  const executable = resolve(root, 'bin/aws');
  const curlExecutable = resolve(root, 'bin/curl');
  await mkdir(dirname(executable), { recursive: true });
  await writeFile(executable, `#!/usr/bin/env node
import { appendFile, copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const args = process.argv.slice(2);
const operation = ['head-object', 'get-object', 'put-object'].find((candidate) => args.includes(candidate));
const option = (name) => args[args.indexOf(name) + 1];
const key = option('--key');
const objectPath = resolve(process.env.MOCK_R2_DIRECTORY, key);
await appendFile(process.env.MOCK_R2_LOG, operation + ' ' + key + '\\n');
if (operation === 'head-object') {
  try {
    await import('node:fs/promises').then(({ access }) => access(objectPath));
  } catch {
    console.error('An error occurred (404) when calling the HeadObject operation: Not Found');
    process.exit(254);
  }
} else if (operation === 'get-object') {
  await copyFile(objectPath, args.at(-1));
} else if (operation === 'put-object') {
  await mkdir(dirname(objectPath), { recursive: true });
  await copyFile(option('--body'), objectPath);
} else {
  throw new Error('Unexpected mock AWS command: ' + args.join(' '));
}
`);
  await writeFile(curlExecutable, `#!/usr/bin/env node
import { appendFile, copyFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
const url = new URL(args.at(-1));
const key = url.pathname.replace(/^\\//, '');
const originHeader = option('--header');
const requestedOrigin = originHeader.replace(/^Origin: /, '');
const allowedOrigin = process.env.MOCK_CORS_ORIGIN ?? requestedOrigin;
await copyFile(resolve(process.env.MOCK_R2_DIRECTORY, key), option('--output'));
await writeFile(
  option('--dump-header'),
  process.env.MOCK_CORS_HEADERS ??
    ('HTTP/2 200\\r\\naccess-control-allow-origin: ' + allowedOrigin + '\\r\\n\\r\\n'),
);
await appendFile(process.env.MOCK_R2_LOG, 'public-get ' + key + '\\n');
`);
  await chmod(executable, 0o755);
  await chmod(curlExecutable, 0o755);
  return resolve(root, 'bin');
}

function environment(root, fixture, bin) {
  return {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    AWS_ACCESS_KEY_ID: 'test-key',
    AWS_SECRET_ACCESS_KEY: 'test-secret',
    R2_ACCOUNT_ID: 'test-account',
    R2_BUCKET: 'test-bucket',
    R2_PUBLIC_BASE_URL: 'https://assets.example',
    R2_PREFIX: 'anycast-lab/native-v86',
    RELEASE_CHANNEL: 'stable',
    RELEASE_STATUS_PATH: fixture.statusPath,
    SOURCE_REVISION: 'a'.repeat(40),
    ARTIFACT_DIR: fixture.artifactDirectory,
    MOCK_R2_DIRECTORY: resolve(root, 'r2'),
    MOCK_R2_LOG: resolve(root, 'aws.log'),
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('publish-r2.sh', () => {
  it('publishes verified immutable objects and writes the channel status last', async () => {
    const root = await temporaryDirectory();
    const fixture = await createFixture(root);
    const bin = await createMockAws(root);
    const env = environment(root, fixture, bin);
    await execute('bash', [publisher], { env });

    const writes = (await readFile(env.MOCK_R2_LOG, 'utf8'))
      .trim().split('\n').filter((line) => line.startsWith('put-object '));
    expect(writes).toHaveLength(7);
    expect(writes.at(-1)).toBe('put-object anycast-lab/native-v86/channels/stable/status.json');
    for (const file of ['manifest.json', 'manifest.sha256', 'router-bzimage.bin', 'seabios.bin', 'vgabios.bin', 'v86.wasm']) {
      expect(writes).toContain(
        `put-object anycast-lab/native-v86/objects/sha256/${fixture.manifestDigest}/${file}`,
      );
    }
  });

  it('reuses identical immutable objects without rewriting them', async () => {
    const root = await temporaryDirectory();
    const fixture = await createFixture(root);
    const bin = await createMockAws(root);
    const env = environment(root, fixture, bin);
    await execute('bash', [publisher], { env });
    await writeFile(env.MOCK_R2_LOG, '');
    await execute('bash', [publisher], { env });

    const writes = (await readFile(env.MOCK_R2_LOG, 'utf8'))
      .trim().split('\n').filter((line) => line.startsWith('put-object '));
    expect(writes).toEqual(['put-object anycast-lab/native-v86/channels/stable/status.json']);
  });

  it('refuses to replace a digest-addressed object containing different bytes', async () => {
    const root = await temporaryDirectory();
    const fixture = await createFixture(root);
    const bin = await createMockAws(root);
    const env = environment(root, fixture, bin);
    await execute('bash', [publisher], { env });
    await writeFile(env.MOCK_R2_LOG, '');
    await writeFile(
      resolve(env.MOCK_R2_DIRECTORY, `anycast-lab/native-v86/objects/sha256/${fixture.manifestDigest}/manifest.json`),
      'different',
    );

    await expect(execute('bash', [publisher], { env })).rejects.toMatchObject({
      stderr: expect.stringContaining('Refusing to replace immutable R2 object'),
    });
    const writes = (await readFile(env.MOCK_R2_LOG, 'utf8'))
      .trim().split('\n').filter((line) => line.startsWith('put-object '));
    expect(writes).not.toContain('put-object anycast-lab/native-v86/channels/stable/status.json');
  });

  it('fails before contacting R2 when publish configuration is missing', async () => {
    const root = await temporaryDirectory();
    const fixture = await createFixture(root);
    const bin = await createMockAws(root);
    const env = environment(root, fixture, bin);
    delete env.R2_BUCKET;

    await expect(execute('bash', [publisher], { env })).rejects.toMatchObject({
      stderr: expect.stringContaining('Required R2 publish configuration is missing: R2_BUCKET'),
    });
    await expect(readFile(env.MOCK_R2_LOG, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a path-normalizing R2 prefix before contacting object storage', async () => {
    const root = await temporaryDirectory();
    const fixture = await createFixture(root);
    const bin = await createMockAws(root);
    const env = environment(root, fixture, bin);
    env.R2_PREFIX = 'anycast-lab/./native-v86';

    await expect(execute('bash', [publisher], { env })).rejects.toMatchObject({
      stderr: expect.stringContaining('Invalid R2 object prefix'),
    });
    await expect(readFile(env.MOCK_R2_LOG, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not advance the channel when the public origin lacks browser CORS', async () => {
    const root = await temporaryDirectory();
    const fixture = await createFixture(root);
    const bin = await createMockAws(root);
    const env = environment(root, fixture, bin);
    env.MOCK_CORS_ORIGIN = 'https://wrong.example';

    await expect(execute('bash', [publisher], { env })).rejects.toMatchObject({
      stderr: expect.stringContaining('does not allow browser requests'),
    });
    const writes = (await readFile(env.MOCK_R2_LOG, 'utf8'))
      .trim().split('\n').filter((line) => line.startsWith('put-object '));
    expect(writes).not.toContain('put-object anycast-lab/native-v86/channels/stable/status.json');
  });

  it('checks CORS on the final response rather than a failed retry response', async () => {
    const root = await temporaryDirectory();
    const fixture = await createFixture(root);
    const bin = await createMockAws(root);
    const env = environment(root, fixture, bin);
    env.MOCK_CORS_HEADERS = [
      'HTTP/2 500',
      'access-control-allow-origin: https://anycast.guide',
      '',
      'HTTP/2 200',
      '',
      '',
    ].join('\r\n');

    await expect(execute('bash', [publisher], { env })).rejects.toMatchObject({
      stderr: expect.stringContaining('does not allow browser requests'),
    });
    const writes = (await readFile(env.MOCK_R2_LOG, 'utf8'))
      .trim().split('\n').filter((line) => line.startsWith('put-object '));
    expect(writes).not.toContain('put-object anycast-lab/native-v86/channels/stable/status.json');
  });
});
