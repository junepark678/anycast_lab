import { describe, expect, it } from 'vitest';
import { createUstarArchive, readUstarArchive } from './tar';

describe('v86 ustar channel', () => {
  it('round-trips files, modes, nested paths, and binary contents', () => {
    const archive = createUstarArchive([
      {
        path: '/etc/bird/peers/transit.conf',
        contents: new TextEncoder().encode('protocol bgp transit {}\n'),
        mode: 0o640,
      },
      { path: '/var/lib/anycast/data.bin', contents: new Uint8Array([0, 1, 254, 255]) },
    ]);

    expect(archive.byteLength % 512).toBe(0);
    const decoded = readUstarArchive(archive).map((entry) => ({
      ...entry,
      contents: [...entry.contents],
    }));
    expect(decoded).toEqual([
      {
        path: '/etc/bird/peers/transit.conf',
        contents: [...new TextEncoder().encode('protocol bgp transit {}\n')],
        mode: 0o640,
      },
      { path: '/var/lib/anycast/data.bin', contents: [0, 1, 254, 255], mode: 0o644 },
    ]);
  });

  it('rejects traversal paths and corrupted headers', () => {
    expect(() =>
      createUstarArchive([{ path: '/etc/../shadow', contents: new Uint8Array() }]),
    ).toThrow(/absolute and normalized/);

    const archive = createUstarArchive([{ path: '/etc/hostname', contents: new Uint8Array([1]) }]);
    archive[0] = archive[0]! ^ 1;
    expect(() => readUstarArchive(archive)).toThrow(/checksum/);
  });
});
