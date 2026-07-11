import { describe, expect, it } from 'vitest';
import { createEmptyProject, type LabProject } from '../core/types';
import { exportNativePcapng } from './pcapng';
import type { NativePacketCapture } from './types';

describe('native PCAPNG export', () => {
  it('writes a valid little-endian section, interface descriptions, nanosecond packets, and block trailers', () => {
    const project = captureProject();
    const bytes = exportNativePcapng(project, capture(project.id));
    const blocks = parseBlocks(bytes);

    expect(blocks.map((block) => block.type)).toEqual([
      0x0a0d0d0a,
      0x00000001,
      0x00000001,
      0x00000006,
      0x00000006,
    ]);
    const section = new DataView(blocks[0]!.body.buffer, blocks[0]!.body.byteOffset, blocks[0]!.body.byteLength);
    expect(section.getUint32(0, true)).toBe(0x1a2b3c4d);
    expect(section.getUint16(4, true)).toBe(1);

    const firstInterfaceOptions = parseOptions(blocks[1]!.body.slice(8));
    expect(new TextDecoder().decode(firstInterfaceOptions.get(2))).toBe('Router A:eth0');
    expect(firstInterfaceOptions.get(9)).toEqual(new Uint8Array([9]));

    const firstPacket = new DataView(
      blocks[3]!.body.buffer,
      blocks[3]!.body.byteOffset,
      blocks[3]!.body.byteLength,
    );
    expect(firstPacket.getUint32(0, true)).toBe(0);
    const timestamp =
      (BigInt(firstPacket.getUint32(4, true)) << 32n) | BigInt(firstPacket.getUint32(8, true));
    expect(timestamp).toBe(123_456_789n);
    expect(firstPacket.getUint32(12, true)).toBe(15);
    expect([...blocks[3]!.body.slice(20, 35)]).toEqual([...capture(project.id).frames[0]!.bytes]);
    expect(blocks.every((block) => block.headerLength === block.trailerLength)).toBe(true);
  });

  it('sorts packets by simulated timestamp and then capture sequence', () => {
    const project = captureProject();
    const value = capture(project.id);
    const reversed: NativePacketCapture = { ...value, frames: [...value.frames].reverse() };
    const packetBlocks = parseBlocks(exportNativePcapng(project, reversed)).filter((block) => block.type === 6);
    const interfaceIds = packetBlocks.map((block) =>
      new DataView(block.body.buffer, block.body.byteOffset, block.body.byteLength).getUint32(0, true),
    );

    expect(interfaceIds).toEqual([0, 1]);
  });

  it('rejects capture data belonging to another project', () => {
    const project = captureProject();
    expect(() => exportNativePcapng(project, capture('someone-else'))).toThrow(/belongs to project/);
  });
});

function captureProject(): LabProject {
  return {
    ...createEmptyProject({ id: 'capture-project', name: 'Capture project' }),
    nodes: [
      {
        id: 'a',
        name: 'Router A',
        kind: 'router',
        appliance: { kind: 'bird', runtime: 'wasm' },
        interfaces: [{ id: 'a-eth0', name: 'eth0', addresses: [], state: 'up' }],
        files: [],
        state: 'up',
      },
      {
        id: 'b',
        name: 'Router B',
        kind: 'router',
        appliance: { kind: 'bird', runtime: 'wasm' },
        interfaces: [{ id: 'b-eth0', name: 'eth0', addresses: [], state: 'up' }],
        files: [],
        state: 'up',
      },
    ],
  };
}

function capture(projectId: string): NativePacketCapture {
  const packet = new Uint8Array([255, 255, 255, 255, 255, 255, 2, 0, 0, 0, 0, 1, 8, 0, 1]);
  return {
    format: 'anycast-lab-ethernet-capture-v1',
    projectId,
    generatedAtNs: 123_456_790n,
    captureLimit: 100,
    events: [],
    frames: [
      {
        sequence: 1,
        frameId: 7,
        atNs: 123_456_789n,
        direction: 'egress',
        nodeId: 'a',
        interfaceId: 'a-eth0',
        bytes: packet,
      },
      {
        sequence: 2,
        frameId: 7,
        atNs: 123_456_790n,
        direction: 'ingress',
        nodeId: 'b',
        interfaceId: 'b-eth0',
        bytes: packet,
      },
    ],
  };
}

interface ParsedBlock {
  readonly type: number;
  readonly headerLength: number;
  readonly trailerLength: number;
  readonly body: Uint8Array;
}

function parseBlocks(bytes: Uint8Array): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset);
    const type = view.getUint32(0, true);
    const headerLength = view.getUint32(4, true);
    if (headerLength < 12 || headerLength % 4 !== 0 || offset + headerLength > bytes.byteLength) {
      throw new Error(`Invalid block length ${headerLength} at ${offset}`);
    }
    const trailerLength = view.getUint32(headerLength - 4, true);
    blocks.push({
      type,
      headerLength,
      trailerLength,
      body: bytes.slice(offset + 8, offset + headerLength - 4),
    });
    offset += headerLength;
  }
  return blocks;
}

function parseOptions(bytes: Uint8Array): Map<number, Uint8Array> {
  const options = new Map<number, Uint8Array>();
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset);
    const code = view.getUint16(0, true);
    const length = view.getUint16(2, true);
    if (code === 0) break;
    options.set(code, bytes.slice(offset + 4, offset + 4 + length));
    offset += 4 + ((length + 3) & ~3);
  }
  return options;
}
