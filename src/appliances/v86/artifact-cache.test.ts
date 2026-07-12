import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MemoryV86ArtifactCache, OpfsV86ArtifactCache } from './artifact-cache';

function identity(contents: Uint8Array) {
  return {
    size: contents.byteLength,
    sha256: createHash('sha256').update(contents).digest('hex'),
  };
}

function chunks(...values: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const value of values) controller.enqueue(value);
      controller.close();
    },
  });
}

describe('V86 artifact cache', () => {
  it('stores and reopens a verified content-addressed artifact', async () => {
    const first = new Uint8Array([1, 2, 3]);
    const second = new Uint8Array([4, 5]);
    const contents = new Uint8Array([...first, ...second]);
    const expected = identity(contents);
    const cache = new MemoryV86ArtifactCache();

    const stored = await cache.store(expected, chunks(first, second));
    expect(stored.cacheHit).toBe(false);
    expect(await blobBytes(stored.blob)).toEqual(contents);

    const reopened = await cache.get(expected);
    expect(reopened?.cacheHit).toBe(true);
    expect(await blobBytes(reopened!.blob)).toEqual(contents);
  });

  it('does not retain a truncated or oversized artifact', async () => {
    const expectedBytes = new Uint8Array([1, 2, 3]);
    const expected = identity(expectedBytes);
    const cache = new MemoryV86ArtifactCache();
    await expect(cache.store(expected, chunks(expectedBytes.subarray(0, 2)))).rejects.toThrow(/size 2/);
    await expect(cache.store(expected, chunks(new Uint8Array([1, 2, 3, 4])))).rejects.toThrow(/declared size/);
    await expect(cache.get(expected)).resolves.toBeNull();
  });

  it('does not retain bytes with the expected size but the wrong digest', async () => {
    const expected = identity(new Uint8Array([1, 2, 3]));
    const cache = new MemoryV86ArtifactCache();
    await expect(cache.store(expected, chunks(new Uint8Array([3, 2, 1])))).rejects.toThrow(/digest mismatch/);
    await expect(cache.get(expected)).resolves.toBeNull();
  });

  it('keeps a previously verified entry when a replacement download fails', async () => {
    const contents = new Uint8Array([4, 2, 4, 2]);
    const expected = identity(contents);
    const cache = new MemoryV86ArtifactCache();
    await cache.store(expected, chunks(contents));

    await expect(cache.store(expected, chunks(contents.subarray(0, 2))))
      .rejects.toThrow(/size 2/);
    await expect(cache.get(expected)).resolves.toMatchObject({ cacheHit: true });
  });

  it('validates identities before touching storage', async () => {
    const cache = new MemoryV86ArtifactCache();
    await expect(cache.get({ size: 1, sha256: '../escape' })).rejects.toThrow(/SHA-256/);
    await expect(cache.get({ size: 0, sha256: 'a'.repeat(64) })).rejects.toThrow(/positive/);
  });
});

describe('OPFS V86 artifact cache', () => {
  it('atomically promotes a verified partial file with the OPFS move extension', async () => {
    const root = new FakeDirectory(true);
    const cache = new OpfsV86ArtifactCache(root.handle());
    const contents = new Uint8Array([1, 2, 3, 4, 5]);
    const expected = identity(contents);

    const stored = await cache.store(expected, chunks(contents.subarray(0, 2), contents.subarray(2)));
    expect(stored.cacheHit).toBe(false);
    expect(await blobBytes(stored.blob)).toEqual(contents);
    const directory = root.descendant('anycast-lab', 'native-artifacts', 'v1');
    expect(directory.fileNames()).toEqual([`${expected.sha256}.bin`]);
    await expect(cache.get(expected)).resolves.toMatchObject({ cacheHit: true });
  });

  it('uses the portable copy promotion and evicts a same-size corrupt file on reopen', async () => {
    const root = new FakeDirectory(false);
    const contents = new Uint8Array([9, 8, 7, 6]);
    const expected = identity(contents);
    const cache = new OpfsV86ArtifactCache(root.handle());
    await cache.store(expected, chunks(contents));
    const directory = root.descendant('anycast-lab', 'native-artifacts', 'v1');
    const filename = `${expected.sha256}.bin`;
    expect(directory.fileNames()).toEqual([filename]);

    directory.replace(filename, new Uint8Array([6, 7, 8, 9]));
    const reopened = new OpfsV86ArtifactCache(root.handle());
    await expect(reopened.get(expected)).resolves.toBeNull();
    expect(directory.fileNames()).toEqual([]);
  });

  it('removes partial and destination files when verification fails', async () => {
    const root = new FakeDirectory(false);
    const cache = new OpfsV86ArtifactCache(root.handle());
    const expected = identity(new Uint8Array([1, 2, 3]));

    await expect(cache.store(expected, chunks(new Uint8Array([3, 2, 1])))).rejects.toThrow(/digest mismatch/);
    expect(root.descendant('anycast-lab', 'native-artifacts', 'v1').fileNames()).toEqual([]);
  });

  it('coalesces concurrent stores and treats cancellation of the losing body as best effort', async () => {
    const root = new FakeDirectory(true);
    const cache = new OpfsV86ArtifactCache(root.handle());
    const contents = new Uint8Array([1, 3, 3, 7]);
    const expected = identity(contents);
    let finish!: () => void;
    const first = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(contents.subarray(0, 2));
        finish = () => {
          controller.enqueue(contents.subarray(2));
          controller.close();
        };
      },
    });
    let cancelled = false;
    const duplicate = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
        throw new Error('synthetic cancellation failure');
      },
    });

    const winner = cache.store(expected, first);
    const follower = cache.store(expected, duplicate);
    finish();
    const [stored, reused] = await Promise.all([winner, follower]);
    expect(cancelled).toBe(true);
    expect(stored.cacheHit).toBe(false);
    expect(reused.cacheHit).toBe(true);
    expect(await blobBytes(reused.blob)).toEqual(contents);
    expect(root.descendant('anycast-lab', 'native-artifacts', 'v1').fileNames()).toEqual([
      `${expected.sha256}.bin`,
    ]);
  });

  it('cleans up an interrupted body and permits a clean retry for the same digest', async () => {
    const root = new FakeDirectory(false);
    const cache = new OpfsV86ArtifactCache(root.handle());
    const contents = new Uint8Array([8, 6, 7, 5, 3, 0, 9]);
    const expected = identity(contents);
    let cancelled = false;
    const interrupted = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(contents.subarray(0, 3));
        controller.error(new Error('connection reset'));
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(cache.store(expected, interrupted)).rejects.toThrow(/connection reset/);
    expect(root.descendant('anycast-lab', 'native-artifacts', 'v1').fileNames()).toEqual([]);
    // An errored stream may already be closed before cancellation is attempted. The
    // important contract is that the original error wins and no partial is promoted.
    expect(cancelled).toBe(false);

    await expect(cache.store(expected, chunks(contents))).resolves.toMatchObject({ cacheHit: false });
    await expect(cache.get(expected)).resolves.toMatchObject({ cacheHit: true });
  });

  it('removes both partial and destination files when portable promotion fails', async () => {
    const root = new FakeDirectory(false);
    const cache = new OpfsV86ArtifactCache(root.handle());
    const contents = new Uint8Array([1, 4, 1, 4, 2, 1]);
    const expected = identity(contents);
    const directoryName = `${expected.sha256}.bin`;
    root.failNextWriteTo(directoryName);

    await expect(cache.store(expected, chunks(contents))).rejects.toThrow(/synthetic OPFS write failure/);
    expect(root.descendant('anycast-lab', 'native-artifacts', 'v1').fileNames()).toEqual([]);

    await expect(cache.store(expected, chunks(contents))).resolves.toMatchObject({ cacheHit: false });
    expect(root.descendant('anycast-lab', 'native-artifacts', 'v1').fileNames()).toEqual([directoryName]);
  });

  it('waits for an in-flight store before deleting its final object', async () => {
    const root = new FakeDirectory(true);
    const cache = new OpfsV86ArtifactCache(root.handle());
    const contents = new Uint8Array([2, 7, 1, 8]);
    const expected = identity(contents);
    let finish!: () => void;
    const delayed = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(contents.subarray(0, 2));
        finish = () => {
          controller.enqueue(contents.subarray(2));
          controller.close();
        };
      },
    });

    const store = cache.store(expected, delayed);
    const deletion = cache.delete(expected.sha256);
    finish();
    await store;
    await deletion;

    await expect(cache.get(expected)).resolves.toBeNull();
    expect(root.descendant('anycast-lab', 'native-artifacts', 'v1').fileNames()).toEqual([]);
  });

  it('clears a rejected coalesced operation so a later request can become the winner', async () => {
    const root = new FakeDirectory(true);
    const cache = new OpfsV86ArtifactCache(root.handle());
    const contents = new Uint8Array([9, 9, 7]);
    const expected = identity(contents);
    let duplicateCancelled = false;
    const duplicate = new ReadableStream<Uint8Array>({
      cancel() {
        duplicateCancelled = true;
      },
    });

    const winner = cache.store(expected, chunks(contents.subarray(0, 2)));
    const follower = cache.store(expected, duplicate);
    await expect(winner).rejects.toThrow(/size 2/);
    await expect(follower).rejects.toThrow(/size 2/);
    expect(duplicateCancelled).toBe(true);
    expect(root.descendant('anycast-lab', 'native-artifacts', 'v1').fileNames()).toEqual([]);

    await expect(cache.store(expected, chunks(contents))).resolves.toMatchObject({ cacheHit: false });
  });
});

function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Blob read failed'));
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.readAsArrayBuffer(blob);
  });
}

class FakeDirectory {
  readonly #directories = new Map<string, FakeDirectory>();
  readonly #files = new Map<string, FakeFile>();
  readonly #writeFailures: Map<string, number>;

  constructor(
    readonly moveSupported: boolean,
    writeFailures = new Map<string, number>(),
  ) {
    this.#writeFailures = writeFailures;
  }

  handle(): FileSystemDirectoryHandle {
    return {
      getDirectoryHandle: async (name: string, options?: FileSystemGetDirectoryOptions) => {
        let directory = this.#directories.get(name);
        if (directory === undefined && options?.create) {
          directory = new FakeDirectory(this.moveSupported, this.#writeFailures);
          this.#directories.set(name, directory);
        }
        if (directory === undefined) throw notFound();
        return directory.handle();
      },
      getFileHandle: async (name: string, options?: FileSystemGetFileOptions) => {
        let file = this.#files.get(name);
        if (file === undefined && options?.create) {
          file = new FakeFile(this, name, this.moveSupported);
          this.#files.set(name, file);
        }
        if (file === undefined) throw notFound();
        return file.handle();
      },
      removeEntry: async (name: string) => {
        if (!this.#files.delete(name) && !this.#directories.delete(name)) throw notFound();
      },
    } as FileSystemDirectoryHandle;
  }

  descendant(...names: string[]): FakeDirectory {
    return names.reduce<FakeDirectory>((directory, name) => {
      const child = directory.#directories.get(name);
      if (child === undefined) throw new Error(`Missing fake OPFS directory ${name}`);
      return child;
    }, this);
  }

  fileNames(): string[] {
    return [...this.#files.keys()].sort();
  }

  replace(name: string, contents: Uint8Array): void {
    const file = this.#files.get(name);
    if (file === undefined) throw new Error(`Missing fake OPFS file ${name}`);
    file.contents = contents.slice();
  }

  failNextWriteTo(name: string): void {
    this.#writeFailures.set(name, (this.#writeFailures.get(name) ?? 0) + 1);
  }

  consumeWriteFailure(name: string): boolean {
    const remaining = this.#writeFailures.get(name) ?? 0;
    if (remaining === 0) return false;
    if (remaining === 1) this.#writeFailures.delete(name);
    else this.#writeFailures.set(name, remaining - 1);
    return true;
  }

  move(file: FakeFile, name: string): void {
    this.#files.delete(file.name);
    this.#files.delete(name);
    file.name = name;
    this.#files.set(name, file);
  }
}

class FakeFile {
  contents = new Uint8Array();
  readonly move?: (name: string) => Promise<void>;

  constructor(
    readonly directory: FakeDirectory,
    public name: string,
    moveSupported: boolean,
  ) {
    if (moveSupported) {
      this.move = async (name) => this.directory.move(this, name);
    }
  }

  handle(): FileSystemFileHandle {
    const result = {
      getFile: async () => new File([this.contents.slice()], this.name),
      createWritable: async () => this.writer(),
      ...(this.move === undefined ? {} : { move: this.move }),
    };
    return result as unknown as FileSystemFileHandle;
  }

  private writer(): FileSystemWritableFileStream {
    const parts: Uint8Array[] = [];
    let aborted = false;
    return {
      write: async (value: FileSystemWriteChunkType) => {
        if (aborted || !(value instanceof Uint8Array)) throw new Error('Unsupported fake OPFS write');
        if (this.directory.consumeWriteFailure(this.name)) {
          throw new Error('synthetic OPFS write failure');
        }
        parts.push(value.slice());
      },
      close: async () => {
        if (aborted) throw new Error('Fake OPFS writer was aborted');
        const length = parts.reduce((total, part) => total + part.byteLength, 0);
        const contents = new Uint8Array(length);
        let offset = 0;
        for (const part of parts) {
          contents.set(part, offset);
          offset += part.byteLength;
        }
        this.contents = contents;
      },
      abort: async () => { aborted = true; },
    } as unknown as FileSystemWritableFileStream;
  }
}

function notFound(): DOMException {
  return new DOMException('Missing fake OPFS entry', 'NotFoundError');
}
