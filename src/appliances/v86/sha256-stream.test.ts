import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { StreamingSha256, sha256Stream } from './sha256-stream';

const encoder = new TextEncoder();

describe('StreamingSha256', () => {
  it.each([
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    [
      'The quick brown fox jumps over the lazy dog',
      'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592',
    ],
  ])('matches the SHA-256 vector for %j', (value, expected) => {
    expect(new StreamingSha256().update(encoder.encode(value)).digestHex()).toBe(expected);
  });

  it('is independent of chunk boundaries across compression blocks', () => {
    const input = new Uint8Array(65_537);
    for (let index = 0; index < input.length; index += 1) input[index] = (index * 31 + 7) & 0xff;
    const expected = createHash('sha256').update(input).digest('hex');
    const hash = new StreamingSha256();
    for (let offset = 0; offset < input.length; offset += 37) {
      hash.update(input.subarray(offset, Math.min(input.length, offset + 37)));
    }
    expect(hash.digestHex()).toBe(expected);
  });

  it.each([55, 56, 63, 64, 65, 119, 120])(
    'matches the reference implementation at the %i-byte padding boundary',
    (length) => {
      const backing = new Uint8Array(length + 11);
      for (let index = 0; index < backing.length; index += 1) backing[index] = (index * 17 + 3) & 0xff;
      const input = backing.subarray(5, 5 + length);
      const expected = createHash('sha256').update(input).digest('hex');
      const hash = new StreamingSha256();
      hash.update(input.subarray(0, Math.floor(length / 3)));
      hash.update(input.subarray(Math.floor(length / 3), Math.floor((length * 2) / 3)));
      hash.update(input.subarray(Math.floor((length * 2) / 3)));
      expect(hash.digestHex()).toBe(expected);
    },
  );

  it('hashes a browser stream without retaining the complete artifact', async () => {
    const chunks = [encoder.encode('large '), encoder.encode('artifact')];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    await expect(sha256Stream(stream)).resolves.toEqual({
      size: 14,
      sha256: createHash('sha256').update('large artifact').digest('hex'),
    });
  });

  it('cannot be updated or finalized twice', () => {
    const hash = new StreamingSha256().update(encoder.encode('once'));
    hash.digestHex();
    expect(() => hash.update(encoder.encode('twice'))).toThrow(/finalized/);
    expect(() => hash.digestHex()).toThrow(/finalized/);
  });
});
