import type { ApplianceFile } from '../abi';

const BLOCK_SIZE = 512;
const USTAR_NAME_LENGTH = 100;
const USTAR_PREFIX_LENGTH = 155;
const decoder = new TextDecoder();
const encoder = new TextEncoder();

interface TarEntry {
  readonly path: string;
  readonly contents: Uint8Array;
  readonly mode: number;
  readonly type: 'file' | 'directory';
}

/** Create a deterministic POSIX ustar archive understood by BusyBox tar. */
export function createUstarArchive(files: readonly ApplianceFile[]): Uint8Array {
  const entries = withParentDirectories(files);
  const blocks: Uint8Array[] = [];
  for (const entry of entries) {
    const payloadLength = entry.type === 'directory' ? 0 : entry.contents.byteLength;
    const header = new Uint8Array(BLOCK_SIZE);
    const { name, prefix } = splitUstarPath(entry.path);
    writeString(header, 0, 100, name);
    writeOctal(header, 100, 8, entry.mode & 0o7777);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, payloadLength);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = entry.type === 'directory' ? 0x35 : 0x30;
    writeString(header, 257, 6, 'ustar\0');
    writeString(header, 263, 2, '00');
    writeString(header, 265, 32, 'root');
    writeString(header, 297, 32, 'root');
    writeString(header, 345, 155, prefix);
    let checksum = 0;
    for (const byte of header) checksum += byte;
    writeChecksum(header, checksum);
    blocks.push(header);
    if (payloadLength > 0) {
      const payload = new Uint8Array(Math.ceil(payloadLength / BLOCK_SIZE) * BLOCK_SIZE);
      payload.set(entry.contents);
      blocks.push(payload);
    }
  }
  blocks.push(new Uint8Array(BLOCK_SIZE * 2));
  return concatenate(blocks);
}

/** Read regular files from the constrained ustar emitted by the guest agent. */
export function readUstarArchive(archive: Uint8Array): ApplianceFile[] {
  const files: ApplianceFile[] = [];
  let offset = 0;
  while (offset + BLOCK_SIZE <= archive.byteLength) {
    const header = archive.subarray(offset, offset + BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) break;
    verifyHeaderChecksum(header);
    const name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const rawPath = prefix.length === 0 ? name : `${prefix}/${name}`;
    const path = normalizeArchivePath(rawPath);
    const size = readOctal(header, 124, 12);
    const mode = readOctal(header, 100, 8);
    const type = header[156];
    offset += BLOCK_SIZE;
    if (offset + size > archive.byteLength) throw new Error(`Truncated tar entry: ${path}`);
    if (type === 0 || type === 0x30) {
      files.push({ path: `/${path}`, contents: archive.slice(offset, offset + size), mode });
    } else if (type !== 0x35) {
      throw new Error(`Unsupported tar entry type ${String.fromCharCode(type ?? 0)} for ${path}`);
    }
    offset += Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
  }
  return files;
}

export function assertNormalizedAbsolutePath(path: string): void {
  if (
    !path.startsWith('/') ||
    path === '/' ||
    path.includes('\0') ||
    path.split('/').some((part) => part === '..' || part === '.')
  ) {
    throw new Error(`Appliance file path must be absolute and normalized: ${path}`);
  }
}

function withParentDirectories(files: readonly ApplianceFile[]): TarEntry[] {
  const directories = new Set<string>();
  const entries: TarEntry[] = [];
  for (const file of files) {
    assertNormalizedAbsolutePath(file.path);
    const path = file.path.slice(1);
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      directories.add(`${parts.slice(0, index).join('/')}/`);
    }
    entries.push({ path, contents: file.contents, mode: file.mode ?? 0o644, type: 'file' });
  }
  const directoryEntries: TarEntry[] = [...directories]
    .sort()
    .map((path) => ({ path, contents: new Uint8Array(), mode: 0o755, type: 'directory' }));
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return [...directoryEntries, ...entries];
}

function splitUstarPath(path: string): { name: string; prefix: string } {
  const bytes = encoder.encode(path);
  if (bytes.byteLength <= USTAR_NAME_LENGTH) return { name: path, prefix: '' };
  for (let slash = path.lastIndexOf('/'); slash > 0; slash = path.lastIndexOf('/', slash - 1)) {
    const prefix = path.slice(0, slash);
    const name = path.slice(slash + 1);
    if (encoder.encode(prefix).byteLength <= USTAR_PREFIX_LENGTH && encoder.encode(name).byteLength <= USTAR_NAME_LENGTH) {
      return { name, prefix };
    }
  }
  throw new Error(`Path does not fit in a POSIX ustar header: /${path}`);
}

function normalizeArchivePath(path: string): string {
  const normalized = path.replace(/^\.\//, '').replace(/\/$/, '');
  assertNormalizedAbsolutePath(`/${normalized}`);
  return normalized;
}

function writeString(target: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = encoder.encode(value);
  if (bytes.byteLength > length) throw new Error(`Tar field is too long: ${value}`);
  target.set(bytes, offset);
}

function writeOctal(target: Uint8Array, offset: number, length: number, value: number): void {
  const encoded = value.toString(8).padStart(length - 1, '0');
  writeString(target, offset, length - 1, encoded);
  target[offset + length - 1] = 0;
}

function writeChecksum(target: Uint8Array, checksum: number): void {
  const encoded = checksum.toString(8).padStart(6, '0');
  writeString(target, 148, 6, encoded);
  target[154] = 0;
  target[155] = 0x20;
}

function readString(source: Uint8Array, offset: number, length: number): string {
  const bytes = source.subarray(offset, offset + length);
  const zero = bytes.indexOf(0);
  return decoder.decode(zero < 0 ? bytes : bytes.subarray(0, zero));
}

function readOctal(source: Uint8Array, offset: number, length: number): number {
  const value = readString(source, offset, length).trim();
  if (!/^[0-7]*$/.test(value)) throw new Error(`Invalid tar octal field: ${value}`);
  return value.length === 0 ? 0 : Number.parseInt(value, 8);
}

function verifyHeaderChecksum(header: Uint8Array): void {
  const expected = readOctal(header, 148, 8);
  let actual = 0;
  for (let index = 0; index < header.byteLength; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index]!;
  }
  if (actual !== expected) throw new Error(`Invalid tar header checksum: expected ${expected}, received ${actual}`);
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}
