import type { ApplianceBootRequest, ApplianceFile, ApplianceInterfaceSpec } from '../abi';
import type { V86ApplianceKind } from './runtime';
import {
  SHARED_GUEST_LIMITS,
  inspectSharedGuestBootRequest,
  validateSharedBootstrapArchive,
  validateSharedBootstrapMetrics,
  validateV86BootRequest,
} from './shared-guest-contract';
import { encodeSharedText } from './shared-protocol';
import { createUstarArchive } from './tar';

export const SHARED_LAB_VLAN_BASE = 100;
export const SHARED_LAB_VLAN_MAX = 4094;
export const SHARED_LAB_MAX_NODES = SHARED_GUEST_LIMITS.nodes;
export const SHARED_BOOTSTRAP_ROOT = '/run/anycastlab/bootstrap';

export interface SharedNodeInterface extends ApplianceInterfaceSpec {
  readonly vlanId: number;
}

export interface SharedNodeBootstrap {
  readonly slot: number;
  readonly kind: V86ApplianceKind;
  readonly request: ApplianceBootRequest;
  readonly interfaces: readonly SharedNodeInterface[];
}

/** Deterministically assigns one private trunk VLAN to every interface in a shared VM. */
export class SharedV86BootstrapBuilder {
  readonly #nodes: SharedNodeBootstrap[] = [];
  #nextVlan = SHARED_LAB_VLAN_BASE;
  #sealed = false;

  register(kind: V86ApplianceKind, request: ApplianceBootRequest): SharedNodeBootstrap {
    if (this.#sealed) throw new Error('Shared v86 bootstrap is already sealed');
    validateV86BootRequest(request);
    if (this.#nodes.length >= SHARED_LAB_MAX_NODES) {
      throw new Error(`Shared v86 machine supports at most ${SHARED_LAB_MAX_NODES} nodes`);
    }
    if (request.interfaces.length > SHARED_LAB_VLAN_MAX - this.#nextVlan + 1) {
      throw new Error(`Shared v86 machine supports at most ${SHARED_LAB_VLAN_MAX - SHARED_LAB_VLAN_BASE + 1} interfaces`);
    }
    const slot = this.#nodes.length + 1;
    const interfaces = request.interfaces.map((networkInterface): SharedNodeInterface => ({
      ...copyInterface(networkInterface),
      vlanId: this.#nextVlan++,
    }));
    const node: SharedNodeBootstrap = {
      slot,
      kind,
      request: copyBootRequest(request),
      interfaces,
    };
    this.#nodes.push(node);
    return copyNode(node);
  }

  nodes(): readonly SharedNodeBootstrap[] {
    return this.#nodes.map(copyNode);
  }

  seal(): Uint8Array {
    if (this.#sealed) throw new Error('Shared v86 bootstrap is already sealed');
    if (this.#nodes.length === 0) throw new Error('Shared v86 bootstrap requires at least one node');
    this.#sealed = true;
    validateSharedBootstrapMetrics(this.#nodes.map((node) => inspectSharedGuestBootRequest(
      node.request,
      {
        slot: node.slot,
        kind: node.kind,
        vlanIds: node.interfaces.map((networkInterface) => networkInterface.vlanId),
      },
    ).metrics));
    const files: ApplianceFile[] = [];
    for (const node of this.#nodes) {
      const directory = `${SHARED_BOOTSTRAP_ROOT}/nodes/${node.slot}`;
      files.push({
        path: `${directory}/node.conf`,
        contents: new TextEncoder().encode(serializeNode(node)),
        mode: 0o400,
      });
      files.push({
        path: `${directory}/root.tar`,
        contents: createUstarArchive(node.request.files),
        mode: 0o400,
      });
    }
    files.push({
      path: `${SHARED_BOOTSTRAP_ROOT}/node-count`,
      contents: new TextEncoder().encode(`${this.#nodes.length}\n`),
      mode: 0o400,
    });
    validateSharedBootstrapArchive(files);
    return createUstarArchive(files);
  }
}

export function serializeNode(node: SharedNodeBootstrap): string {
  const request = node.request;
  const lines = [
    'ANYCASTLAB_NODE/1',
    `node ${node.slot} ${node.kind} ${encodeBootstrapText(request.nodeId)} ${encodeBootstrapText(request.hostname)}`,
    `entrypoint ${encodeBootstrapText(request.entrypoint)}`,
  ];
  for (const argument of request.argv) lines.push(`arg ${encodeBootstrapText(argument)}`);
  for (const [name, value] of Object.entries(request.environment).sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`env ${name} ${encodeBootstrapText(value)}`);
  }
  for (const networkInterface of node.interfaces) {
    lines.push([
      'interface',
      String(networkInterface.vlanId),
      encodeBootstrapText(networkInterface.id),
      encodeBootstrapText(networkInterface.name),
      networkInterface.mac.toLowerCase(),
      String(networkInterface.mtu),
      networkInterface.up ? 'up' : 'down',
    ].join(' '));
    for (const address of networkInterface.addresses) {
      lines.push(`address ${encodeBootstrapText(networkInterface.id)} ${address.address} ${address.prefixLength}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** `-` is the only non-base64 token and canonically represents empty text. */
export function encodeBootstrapText(value: string): string {
  return value.length === 0 ? '-' : encodeSharedText(value);
}

function copyNode(node: SharedNodeBootstrap): SharedNodeBootstrap {
  return {
    slot: node.slot,
    kind: node.kind,
    request: copyBootRequest(node.request),
    interfaces: node.interfaces.map((networkInterface) => ({
      ...copyInterface(networkInterface),
      vlanId: networkInterface.vlanId,
    })),
  };
}

function copyBootRequest(request: ApplianceBootRequest): ApplianceBootRequest {
  return {
    ...request,
    argv: [...request.argv],
    environment: { ...request.environment },
    files: request.files.map((file) => ({
      ...file,
      contents: file.contents.slice(),
    })),
    interfaces: request.interfaces.map(copyInterface),
  };
}

function copyInterface(networkInterface: ApplianceInterfaceSpec): ApplianceInterfaceSpec {
  return {
    ...networkInterface,
    addresses: networkInterface.addresses.map((address) => ({ ...address })),
  };
}
