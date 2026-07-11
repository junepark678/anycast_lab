// @vitest-environment node
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { readUstarArchive } from '../../../src/appliances/v86/tar';

const agent = resolve(
  import.meta.dirname,
  '../buildroot/board/rootfs-overlay/usr/libexec/anycastlab-agent',
);
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

it.each([
  { expected: false, output: 'ANYCASTLAB/1 EXIT appliance-process-exited\n' },
  { expected: true, output: '' },
])('reports only unexpected daemon exits (expected=$expected)', async ({ expected, output }) => {
  const runtimeDirectory = await mkdtemp(resolve(tmpdir(), 'anycast-agent-monitor-'));
  temporaryDirectories.push(runtimeDirectory);
  await chmod(agent, 0o755);

  const appliance = spawn('sleep', ['30'], { stdio: 'ignore' });
  if (appliance.pid === undefined) throw new Error('Failed to start the fake appliance process');
  await writeFile(resolve(runtimeDirectory, 'appliance.pid'), `${appliance.pid}\n`);
  if (expected) await writeFile(resolve(runtimeDirectory, 'appliance.expected-exit'), 'pgo\n');

  const monitor = spawn(agent, [], {
    env: {
      PATH: process.env.PATH,
      ANYCASTLAB_AGENT_MONITOR_ONLY: '1',
      ANYCASTLAB_MONITOR_INTERVAL: '0.01',
      ANYCASTLAB_RUNTIME_DIR: runtimeDirectory,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  monitor.stdout.on('data', (chunk) => stdout.push(chunk));
  monitor.stderr.on('data', (chunk) => stderr.push(chunk));
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
  appliance.kill('SIGTERM');
  await once(appliance, 'exit');
  const [exitCode] = await once(monitor, 'exit');

  expect(exitCode).toBe(0);
  expect(Buffer.concat(stderr).toString()).toBe('');
  expect(Buffer.concat(stdout).toString()).toBe(output);
});

it('gracefully stops an instrumented appliance and exports its flushed profile', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'anycast-agent-collect-'));
  temporaryDirectories.push(root);
  const runtimeDirectory = resolve(root, 'run');
  const hostMount = resolve(root, 'host');
  const profileDirectory = resolve(root, 'profiles');
  const marker = resolve(root, 'pgo-generate');
  await Promise.all([
    mkdir(runtimeDirectory),
    mkdir(hostMount),
    mkdir(profileDirectory),
    writeFile(marker, 'clang-ir-pgo\n'),
  ]);

  const appliance = spawn('sh', [
    '-c',
    "trap 'printf ignored-cli-data >\"$1/default_cli.profraw\"; printf profile-data >\"$1/daemon-bird_test_1.profraw\"; exit 0' TERM; while :; do sleep 1; done",
    'fake-appliance',
    profileDirectory,
  ], { stdio: 'ignore' });
  if (appliance.pid === undefined) throw new Error('Failed to start the fake instrumented appliance');
  const applianceExit = once(appliance, 'exit');
  await writeFile(resolve(runtimeDirectory, 'appliance.pid'), `${appliance.pid}\n`);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));

  const guestAgent = spawn(agent, [], {
    env: {
      PATH: process.env.PATH,
      ANYCASTLAB_HOST_MOUNT: hostMount,
      ANYCASTLAB_MONITOR_INTERVAL: '0.01',
      ANYCASTLAB_PGO_DIR: profileDirectory,
      ANYCASTLAB_PGO_MARKER: marker,
      ANYCASTLAB_PGO_STOP_ATTEMPTS: '40',
      ANYCASTLAB_RUNTIME_DIR: runtimeDirectory,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  guestAgent.stdout.on('data', (chunk) => stdout.push(chunk));
  guestAgent.stderr.on('data', (chunk) => stderr.push(chunk));
  guestAgent.stdin.end('ANYCASTLAB/1 COLLECT_PGO collect-1\n');
  const [exitCode] = await once(guestAgent, 'exit');
  await applianceExit;

  expect(exitCode).toBe(0);
  expect(Buffer.concat(stderr).toString()).toBe('');
  expect(Buffer.concat(stdout).toString()).toContain('ANYCASTLAB/1 READY\n');
  expect(Buffer.concat(stdout).toString()).toContain('ANYCASTLAB/1 OK collect-1\n');
  const files = readUstarArchive(new Uint8Array(await readFile(resolve(hostMount, 'anycastlab-out.tar'))));
  expect(files).toHaveLength(1);
  expect(files[0]?.path).toBe('/daemon-bird_test_1.profraw');
  expect(new TextDecoder().decode(files[0]?.contents)).toBe('profile-data');
  expect(await readFile(resolve(runtimeDirectory, 'appliance.expected-exit'), 'utf8')).toBe('');
});

it('rejects a guest export containing more than 128 raw profile files', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'anycast-agent-profile-cap-'));
  temporaryDirectories.push(root);
  const runtimeDirectory = resolve(root, 'run');
  const hostMount = resolve(root, 'host');
  const profileDirectory = resolve(root, 'profiles');
  const marker = resolve(root, 'pgo-generate');
  await Promise.all([
    mkdir(runtimeDirectory),
    mkdir(hostMount),
    mkdir(profileDirectory),
    writeFile(marker, 'clang-ir-pgo\n'),
  ]);
  await Promise.all(Array.from({ length: 129 }, (_, index) => (
    writeFile(resolve(profileDirectory, `daemon-frr_${index.toString().padStart(3, '0')}_1.profraw`), 'x')
  )));

  const appliance = spawn('sleep', ['30'], { stdio: 'ignore' });
  if (appliance.pid === undefined) throw new Error('Failed to start the fake instrumented appliance');
  const applianceExit = once(appliance, 'exit');
  await writeFile(resolve(runtimeDirectory, 'appliance.pid'), `${appliance.pid}\n`);

  const guestAgent = spawn(agent, [], {
    env: {
      PATH: process.env.PATH,
      ANYCASTLAB_HOST_MOUNT: hostMount,
      ANYCASTLAB_MONITOR_INTERVAL: '0.01',
      ANYCASTLAB_PGO_DIR: profileDirectory,
      ANYCASTLAB_PGO_MARKER: marker,
      ANYCASTLAB_PGO_STOP_ATTEMPTS: '40',
      ANYCASTLAB_RUNTIME_DIR: runtimeDirectory,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  guestAgent.stdout.on('data', (chunk) => stdout.push(chunk));
  guestAgent.stderr.on('data', (chunk) => stderr.push(chunk));
  guestAgent.stdin.end('ANYCASTLAB/1 COLLECT_PGO collect-too-many\n');
  const [exitCode] = await once(guestAgent, 'exit');
  await applianceExit;

  expect(exitCode).toBe(0);
  expect(Buffer.concat(stderr).toString()).toBe('');
  expect(Buffer.concat(stdout).toString()).toContain(
    'ANYCASTLAB/1 ERR collect-too-many INVALID_PGO_PROFILES_15\n',
  );
  await expect(readFile(resolve(hostMount, 'anycastlab-out.tar'))).rejects.toMatchObject({ code: 'ENOENT' });
});
