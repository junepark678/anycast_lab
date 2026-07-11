const ETHERNET_HEADER_LENGTH = 14;
const VLAN_HEADER_LENGTH = 4;
const VLAN_TPID = 0x8100;

export interface VlanDecodedFrame {
  readonly vlanId: number;
  readonly bytes: Uint8Array;
}

/** Add the private outer 802.1Q tag used to multiplex guest interfaces. */
export function addLabVlanTag(frame: Uint8Array, vlanId: number): Uint8Array {
  assertEthernetFrame(frame);
  assertVlanId(vlanId);
  const tagged = new Uint8Array(frame.byteLength + VLAN_HEADER_LENGTH);
  tagged.set(frame.subarray(0, 12), 0);
  tagged[12] = VLAN_TPID >>> 8;
  tagged[13] = VLAN_TPID & 0xff;
  tagged[14] = (vlanId >>> 8) & 0x0f;
  tagged[15] = vlanId & 0xff;
  tagged.set(frame.subarray(12), 16);
  return tagged;
}

/** Remove the private outer tag; an inner user VLAN tag remains untouched. */
export function removeLabVlanTag(frame: Uint8Array): VlanDecodedFrame | null {
  if (frame.byteLength < ETHERNET_HEADER_LENGTH + VLAN_HEADER_LENGTH) return null;
  const tpid = (frame[12]! << 8) | frame[13]!;
  if (tpid !== VLAN_TPID) return null;
  const tci = (frame[14]! << 8) | frame[15]!;
  const vlanId = tci & 0x0fff;
  if (vlanId === 0 || vlanId === 0x0fff) return null;
  const untagged = new Uint8Array(frame.byteLength - VLAN_HEADER_LENGTH);
  untagged.set(frame.subarray(0, 12), 0);
  untagged.set(frame.subarray(16), 12);
  return { vlanId, bytes: untagged };
}

export function assertEthernetFrame(frame: Uint8Array): void {
  if (frame.byteLength < ETHERNET_HEADER_LENGTH) {
    throw new Error(`Ethernet frame is ${frame.byteLength} bytes; at least ${ETHERNET_HEADER_LENGTH} are required`);
  }
}

export function assertVlanId(vlanId: number): void {
  if (!Number.isSafeInteger(vlanId) || vlanId < 1 || vlanId > 4094) {
    throw new Error(`Invalid lab VLAN id: ${vlanId}`);
  }
}
