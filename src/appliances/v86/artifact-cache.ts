import { StreamingSha256, sha256Stream } from './sha256-stream';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CACHE_ROOT = ['anycast-lab', 'native-artifacts', 'v1'] as const;

export interface V86ArtifactIdentity {
  readonly sha256: string;
  readonly size: number;
}

export interface CachedV86Artifact extends V86ArtifactIdentity {
  readonly blob: Blob;
  readonly cacheHit: boolean;
}

export interface V86ArtifactCache {
  get(identity: V86ArtifactIdentity): Promise<CachedV86Artifact | null>;
  store(
    identity: V86ArtifactIdentity,
    contents: ReadableStream<Uint8Array>,
  ): Promise<CachedV86Artifact>;
  delete(sha256: string): Promise<void>;
}

/** In-memory fallback used when OPFS is unavailable and by deterministic tests. */
export class MemoryV86ArtifactCache implements V86ArtifactCache {
  readonly #entries = new Map<string, Blob>();

  async get(identity: V86ArtifactIdentity): Promise<CachedV86Artifact | null> {
    assertIdentity(identity);
    const blob = this.#entries.get(identity.sha256);
    if (blob === undefined || blob.size !== identity.size) return null;
    const actual = await sha256Stream(blobReadableStream(blob));
    if (actual.sha256 !== identity.sha256 || actual.size !== identity.size) {
      this.#entries.delete(identity.sha256);
      return null;
    }
    return { ...identity, blob, cacheHit: true };
  }

  async store(
    identity: V86ArtifactIdentity,
    contents: ReadableStream<Uint8Array>,
  ): Promise<CachedV86Artifact> {
    assertIdentity(identity);
    const chunks: ArrayBuffer[] = [];
    const result = await consumeVerifiedStream(identity, contents, async (chunk) => {
      chunks.push(chunk.slice().buffer as ArrayBuffer);
    });
    const blob = new Blob(chunks, { type: 'application/octet-stream' });
    if (blob.size !== result.size) throw new Error('Artifact cache assembled an invalid Blob');
    this.#entries.set(identity.sha256, blob);
    return { ...identity, blob, cacheHit: false };
  }

  async delete(sha256: string): Promise<void> {
    assertSha256(sha256);
    this.#entries.delete(sha256);
  }
}

/**
 * Content-addressed OPFS cache. Downloads are streamed to a temporary file,
 * verified incrementally, and only then promoted to the digest filename.
 */
export class OpfsV86ArtifactCache implements V86ArtifactCache {
  readonly #root: FileSystemDirectoryHandle;
  readonly #verified = new Set<string>();
  readonly #stores = new Map<string, Promise<CachedV86Artifact>>();
  #directory: Promise<FileSystemDirectoryHandle> | null = null;

  constructor(root: FileSystemDirectoryHandle) {
    this.#root = root;
  }

  async get(identity: V86ArtifactIdentity): Promise<CachedV86Artifact | null> {
    assertIdentity(identity);
    const pending = this.#stores.get(identity.sha256);
    if (pending !== undefined) {
      const artifact = await pending;
      return artifact.size === identity.size ? { ...artifact, cacheHit: true } : null;
    }
    const directory = await this.#artifactDirectory();
    const name = artifactFileName(identity.sha256);
    let handle: FileSystemFileHandle;
    try {
      handle = await directory.getFileHandle(name);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
    const file = await handle.getFile();
    if (file.size !== identity.size) {
      await removeEntryIfPresent(directory, name);
      this.#verified.delete(identity.sha256);
      return null;
    }
    if (!this.#verified.has(identity.sha256)) {
      const actual = await sha256Stream(blobReadableStream(file));
      if (actual.sha256 !== identity.sha256 || actual.size !== identity.size) {
        await removeEntryIfPresent(directory, name);
        return null;
      }
      this.#verified.add(identity.sha256);
    }
    return { ...identity, blob: file, cacheHit: true };
  }

  async store(
    identity: V86ArtifactIdentity,
    contents: ReadableStream<Uint8Array>,
  ): Promise<CachedV86Artifact> {
    assertIdentity(identity);
    const existing = this.#stores.get(identity.sha256);
    if (existing !== undefined) {
      await cancelReadable(contents, 'A concurrent artifact download already owns this cache key');
      const artifact = await existing;
      if (artifact.size !== identity.size) {
        throw new Error('Concurrent artifact cache requests disagree about content size');
      }
      return { ...artifact, cacheHit: true };
    }
    const operation = this.#storeExclusive(identity, contents);
    this.#stores.set(identity.sha256, operation);
    try {
      return await operation;
    } finally {
      if (this.#stores.get(identity.sha256) === operation) this.#stores.delete(identity.sha256);
    }
  }

  async delete(sha256: string): Promise<void> {
    assertSha256(sha256);
    const pending = this.#stores.get(sha256);
    if (pending !== undefined) await pending.catch(() => undefined);
    const directory = await this.#artifactDirectory();
    await removeEntryIfPresent(directory, artifactFileName(sha256));
    this.#verified.delete(sha256);
  }

  async #storeExclusive(
    identity: V86ArtifactIdentity,
    contents: ReadableStream<Uint8Array>,
  ): Promise<CachedV86Artifact> {
    const directory = await this.#artifactDirectory();
    const nonce = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    const temporaryName = `.${identity.sha256}.${nonce}.partial`;
    const temporaryHandle = await directory.getFileHandle(temporaryName, { create: true });
    const temporaryWriter = await temporaryHandle.createWritable({ keepExistingData: false });
    try {
      await consumeVerifiedStream(identity, contents, async (chunk) => {
        await temporaryWriter.write(chunk.slice());
      });
      await temporaryWriter.close();
      const temporaryFile = await temporaryHandle.getFile();
      await this.#promote(directory, temporaryHandle, temporaryFile, identity.sha256);
      const finalHandle = await directory.getFileHandle(artifactFileName(identity.sha256));
      const file = await finalHandle.getFile();
      if (file.size !== identity.size) throw new Error('OPFS artifact promotion changed its size');
      this.#verified.add(identity.sha256);
      return { ...identity, blob: file, cacheHit: false };
    } catch (error) {
      await abortWriter(temporaryWriter, error);
      throw error;
    } finally {
      await removeEntryIfPresent(directory, temporaryName);
    }
  }

  async #promote(
    directory: FileSystemDirectoryHandle,
    temporaryHandle: FileSystemFileHandle,
    temporaryFile: File,
    sha256: string,
  ): Promise<void> {
    const finalName = artifactFileName(sha256);
    const movable = temporaryHandle as FileSystemFileHandle & {
      move?: (name: string) => Promise<void>;
    };
    if (typeof movable.move === 'function') {
      await removeEntryIfPresent(directory, finalName);
      await movable.move(finalName);
      return;
    }

    const finalHandle = await directory.getFileHandle(finalName, { create: true });
    const finalWriter = await finalHandle.createWritable({ keepExistingData: false });
    try {
      const reader = blobReadableStream(temporaryFile).getReader();
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) break;
          await finalWriter.write(result.value.slice());
        }
      } finally {
        reader.releaseLock();
      }
      await finalWriter.close();
    } catch (error) {
      await abortWriter(finalWriter, error);
      await removeEntryIfPresent(directory, finalName);
      throw error;
    }
  }

  #artifactDirectory(): Promise<FileSystemDirectoryHandle> {
    this.#directory ??= nestedDirectory(this.#root, CACHE_ROOT);
    return this.#directory;
  }
}

export async function openBrowserV86ArtifactCache(): Promise<OpfsV86ArtifactCache | null> {
  const storage = globalThis.navigator?.storage as StorageManager & {
    getDirectory?: () => Promise<FileSystemDirectoryHandle>;
  } | undefined;
  if (storage?.getDirectory === undefined) return null;
  try {
    return new OpfsV86ArtifactCache(await storage.getDirectory());
  } catch {
    return null;
  }
}

async function consumeVerifiedStream(
  identity: V86ArtifactIdentity,
  contents: ReadableStream<Uint8Array>,
  consume: (chunk: Uint8Array) => Promise<void>,
): Promise<{ readonly sha256: string; readonly size: number }> {
  const hasher = new StreamingSha256();
  const reader = contents.getReader();
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (!Number.isSafeInteger(size) || size > identity.size) {
        throw new Error(`Artifact exceeds its declared size of ${identity.size} bytes`);
      }
      hasher.update(result.value);
      await consume(result.value);
    }
  } catch (error) {
    await cancelReader(reader, error);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const sha256 = hasher.digestHex();
  if (size !== identity.size) {
    throw new Error(`Artifact has size ${size}; expected ${identity.size}`);
  }
  if (sha256 !== identity.sha256) {
    throw new Error(`Artifact digest mismatch: expected ${identity.sha256}, received ${sha256}`);
  }
  return { sha256, size };
}

async function cancelReadable(stream: ReadableStream<Uint8Array>, reason: unknown): Promise<void> {
  try {
    await stream.cancel(reason);
  } catch {
    // Cancellation is best-effort; the winning content-addressed store still owns the result.
  }
}

async function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason: unknown,
): Promise<void> {
  try {
    await reader.cancel(reason);
  } catch {
    // Preserve the verification or storage error that caused cancellation.
  }
}

async function nestedDirectory(
  root: FileSystemDirectoryHandle,
  names: readonly string[],
): Promise<FileSystemDirectoryHandle> {
  let directory = root;
  for (const name of names) directory = await directory.getDirectoryHandle(name, { create: true });
  return directory;
}

async function abortWriter(writer: FileSystemWritableFileStream, reason: unknown): Promise<void> {
  try {
    await writer.abort(reason);
  } catch {
    // A successful close or an implementation-specific write failure can make abort reject.
  }
}

async function removeEntryIfPresent(
  directory: FileSystemDirectoryHandle,
  name: string,
): Promise<void> {
  try {
    await directory.removeEntry(name);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

function artifactFileName(sha256: string): string {
  return `${sha256}.bin`;
}

function assertIdentity(identity: V86ArtifactIdentity): void {
  assertSha256(identity.sha256);
  if (!Number.isSafeInteger(identity.size) || identity.size <= 0) {
    throw new Error('Artifact size must be a positive safe integer');
  }
}

function assertSha256(value: string): void {
  if (!SHA256_PATTERN.test(value)) throw new Error('Artifact cache key must be a lowercase SHA-256 digest');
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    'name' in error && error.name === 'NotFoundError';
}

function blobReadableStream(blob: Blob): ReadableStream<Uint8Array> {
  if (typeof blob.stream === 'function') return blob.stream();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const reader = new FileReader();
      reader.onerror = () => controller.error(reader.error ?? new Error('Blob read failed'));
      reader.onload = () => {
        controller.enqueue(new Uint8Array(reader.result as ArrayBuffer));
        controller.close();
      };
      reader.readAsArrayBuffer(blob);
    },
  });
}
