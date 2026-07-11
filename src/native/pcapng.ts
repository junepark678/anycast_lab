import type { LabProject } from '../core/types';
import type { NativeCapturedFrame, NativePacketCapture } from './types';

const PCAPNG_SECTION_HEADER = 0x0a0d0d0a;
const PCAPNG_INTERFACE_DESCRIPTION = 0x00000001;
const PCAPNG_ENHANCED_PACKET = 0x00000006;
const PCAPNG_BYTE_ORDER_MAGIC = 0x1a2b3c4d;
const LINKTYPE_ETHERNET = 1;
const OPTION_END = 0;
const OPTION_COMMENT = 1;
const OPTION_INTERFACE_NAME = 2;
const OPTION_TIMESTAMP_RESOLUTION = 9;
const encoder = new TextEncoder();

/** Export a byte-exact multi-interface Ethernet capture as PCAPNG. */
export function exportNativePcapng(
  project: LabProject,
  capture: NativePacketCapture,
): Uint8Array {
  if (capture.projectId !== project.id) {
    throw new Error(`Capture belongs to project ${capture.projectId}, not ${project.id}`);
  }

  const interfaceKeys = new Map<string, number>();
  const blocks: Uint8Array[] = [sectionHeaderBlock()];
  for (const node of project.nodes) {
    for (const networkInterface of node.interfaces) {
      const key = endpointKey(node.id, networkInterface.id);
      interfaceKeys.set(key, interfaceKeys.size);
      blocks.push(interfaceDescriptionBlock(`${node.name}:${networkInterface.name}`));
    }
  }

  const orderedFrames = [...capture.frames].sort(
    (left, right) =>
      left.atNs < right.atNs ? -1 : left.atNs > right.atNs ? 1 : left.sequence - right.sequence,
  );
  for (const frame of orderedFrames) {
    const interfaceId = interfaceKeys.get(endpointKey(frame.nodeId, frame.interfaceId));
    if (interfaceId === undefined) continue;
    blocks.push(enhancedPacketBlock(interfaceId, frame));
  }

  return concatenate(blocks);
}

function sectionHeaderBlock(): Uint8Array {
  const body = new Uint8Array(16);
  const view = new DataView(body.buffer);
  view.setUint32(0, PCAPNG_BYTE_ORDER_MAGIC, true);
  view.setUint16(4, 1, true);
  view.setUint16(6, 0, true);
  view.setUint32(8, 0xffffffff, true);
  view.setUint32(12, 0xffffffff, true);
  return block(PCAPNG_SECTION_HEADER, body);
}

function interfaceDescriptionBlock(name: string): Uint8Array {
  const fixed = new Uint8Array(8);
  const view = new DataView(fixed.buffer);
  view.setUint16(0, LINKTYPE_ETHERNET, true);
  view.setUint16(2, 0, true);
  view.setUint32(4, 65_535, true);
  return block(
    PCAPNG_INTERFACE_DESCRIPTION,
    concatenate([
      fixed,
      option(OPTION_INTERFACE_NAME, encoder.encode(name)),
      // Bit 7 clear means a negative power of ten; 9 selects nanoseconds.
      option(OPTION_TIMESTAMP_RESOLUTION, new Uint8Array([9])),
      option(OPTION_END, new Uint8Array()),
    ]),
  );
}

function enhancedPacketBlock(interfaceId: number, frame: NativeCapturedFrame): Uint8Array {
  const fixed = new Uint8Array(20);
  const view = new DataView(fixed.buffer);
  const timestamp = BigInt.asUintN(64, frame.atNs);
  view.setUint32(0, interfaceId, true);
  view.setUint32(4, Number((timestamp >> 32n) & 0xffffffffn), true);
  view.setUint32(8, Number(timestamp & 0xffffffffn), true);
  view.setUint32(12, frame.bytes.byteLength, true);
  view.setUint32(16, frame.bytes.byteLength, true);
  const packet = padded(frame.bytes);
  const detail = `${frame.direction}${frame.dropReason === undefined ? '' : `: ${frame.dropReason}`}`;
  return block(
    PCAPNG_ENHANCED_PACKET,
    concatenate([
      fixed,
      packet,
      option(OPTION_COMMENT, encoder.encode(`Anycast Lab frame ${frame.frameId} ${detail}`)),
      option(OPTION_END, new Uint8Array()),
    ]),
  );
}

function option(code: number, value: Uint8Array): Uint8Array {
  const output = new Uint8Array(4 + align4(value.byteLength));
  const view = new DataView(output.buffer);
  view.setUint16(0, code, true);
  view.setUint16(2, value.byteLength, true);
  output.set(value, 4);
  return output;
}

function block(type: number, body: Uint8Array): Uint8Array {
  const length = 12 + body.byteLength;
  if (length % 4 !== 0) throw new Error('PCAPNG block bodies must be 32-bit aligned');
  const output = new Uint8Array(length);
  const view = new DataView(output.buffer);
  view.setUint32(0, type, true);
  view.setUint32(4, length, true);
  output.set(body, 8);
  view.setUint32(length - 4, length, true);
  return output;
}

function padded(value: Uint8Array): Uint8Array {
  const output = new Uint8Array(align4(value.byteLength));
  output.set(value);
  return output;
}

function align4(value: number): number {
  return (value + 3) & ~3;
}

function concatenate(values: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(values.reduce((total, value) => total + value.byteLength, 0));
  let offset = 0;
  for (const value of values) {
    output.set(value, offset);
    offset += value.byteLength;
  }
  return output;
}

function endpointKey(nodeId: string, interfaceId: string): string {
  return `${nodeId}\u0000${interfaceId}`;
}
