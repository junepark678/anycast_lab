import { access, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const source = resolve(root, 'appliances/v86/dist');
const destination = resolve(root, 'public/runtime/v86');
const statusPath = resolve(root, 'public/runtime/status.json');

await rm(resolve(root, 'public/runtime'), { recursive: true, force: true });
await mkdir(resolve(root, 'public/runtime'), { recursive: true });

let nativeAvailable = false;
let nativeMetadata = {};
try {
  await access(resolve(source, 'manifest.json'), constants.R_OK);
  await access(resolve(source, 'manifest.sha256'), constants.R_OK);
  const digestLine = await readFile(resolve(source, 'manifest.sha256'), 'utf8');
  const digest = digestLine.trim().split(/\s+/)[0] ?? '';
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('v86 manifest.sha256 is invalid');
  const manifest = JSON.parse(await readFile(resolve(source, 'manifest.json'), 'utf8'));
  if (
    typeof manifest !== 'object' || manifest === null ||
    typeof manifest.buildId !== 'string' ||
    typeof manifest.machine !== 'object' || manifest.machine === null ||
    !Number.isSafeInteger(manifest.machine.memoryBytes) || manifest.machine.memoryBytes <= 0
  ) {
    throw new Error('v86 manifest deployment metadata is invalid');
  }
  await mkdir(destination, { recursive: true });
  await cp(source, destination, { recursive: true });
  nativeAvailable = true;
  nativeMetadata = {
    manifestSha256: digest,
    buildId: manifest.buildId,
    memoryBytes: manifest.machine.memoryBytes,
  };
} catch (error) {
  if (error instanceof Error && !('code' in error && error.code === 'ENOENT')) throw error;
}

await writeFile(
  statusPath,
  `${JSON.stringify({ schemaVersion: 1, nativeV86: nativeAvailable, ...nativeMetadata }, null, 2)}\n`,
);
