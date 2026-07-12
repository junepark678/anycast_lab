import { SHARED_GUEST_LIMITS } from './shared-guest-contract';

export const SHARED_GUEST_PROTOCOL = 'ANYCASTLAB/2' as const;
export const MAX_SHARED_CONTROL_LINE_BYTES = SHARED_GUEST_LIMITS.controlLineBytes;
export const MAX_SHARED_TERMINAL_CHUNK_BYTES = SHARED_GUEST_LIMITS.terminalChunkBytes;

export type SharedGuestCommandName =
  | 'NODE_START'
  | 'NODE_STOP'
  | 'NODE_DELETE'
  | 'APPLY'
  | 'READ'
  | 'LINK'
  | 'TERM_OPEN'
  | 'TERM_WRITE'
  | 'TERM_RESIZE'
  | 'TERM_CLOSE'
  | 'COLLECT_PGO'
  | 'PING';

export interface SharedGuestCommand {
  readonly command: SharedGuestCommandName;
  readonly requestId: number;
  readonly nodeSlot: number;
  readonly arguments: readonly string[];
}

export type SharedGuestMessage =
  | { readonly type: 'machine-ready' }
  | { readonly type: 'node-ready'; readonly nodeSlot: number }
  | { readonly type: 'node-exit'; readonly nodeSlot: number; readonly reason: string }
  | { readonly type: 'response'; readonly ok: true; readonly requestId: number; readonly detail: readonly string[] }
  | { readonly type: 'response'; readonly ok: false; readonly requestId: number; readonly code: string; readonly detail: readonly string[] }
  | { readonly type: 'terminal-data'; readonly nodeSlot: number; readonly sessionId: number; readonly data: Uint8Array }
  | { readonly type: 'log'; readonly nodeSlot: number; readonly level: 'info' | 'warning' | 'error'; readonly message: string };

const COMMANDS: ReadonlySet<string> = new Set<SharedGuestCommandName>([
  'NODE_START',
  'NODE_STOP',
  'NODE_DELETE',
  'APPLY',
  'READ',
  'LINK',
  'TERM_OPEN',
  'TERM_WRITE',
  'TERM_RESIZE',
  'TERM_CLOSE',
  'COLLECT_PGO',
  'PING',
]);

export function encodeSharedGuestCommand(command: SharedGuestCommand): Uint8Array {
  if (!COMMANDS.has(command.command)) throw new Error(`Unknown shared guest command: ${command.command}`);
  assertPositiveInteger(command.requestId, 'requestId');
  assertPositiveInteger(command.nodeSlot, 'nodeSlot');
  for (const argument of command.arguments) assertToken(argument, 'command argument');
  const line = [
    SHARED_GUEST_PROTOCOL,
    command.command,
    String(command.requestId),
    String(command.nodeSlot),
    ...command.arguments,
  ].join(' ') + '\n';
  const encoded = new TextEncoder().encode(line);
  if (encoded.byteLength > MAX_SHARED_CONTROL_LINE_BYTES) {
    throw new Error(`Shared guest command exceeds ${MAX_SHARED_CONTROL_LINE_BYTES} bytes`);
  }
  return encoded;
}

export function parseSharedGuestMessage(line: string): SharedGuestMessage | null {
  if (new TextEncoder().encode(line).byteLength > MAX_SHARED_CONTROL_LINE_BYTES) {
    throw new Error(`Shared guest message exceeds ${MAX_SHARED_CONTROL_LINE_BYTES} bytes`);
  }
  const tokens = line.replace(/\r$/, '').split(' ');
  if (tokens[0] !== SHARED_GUEST_PROTOCOL) return null;
  if (tokens.some((token) => token.length === 0)) throw new Error('Shared guest message contains an empty token');
  const type = tokens[1];
  switch (type) {
    case 'READY':
      requireLength(tokens, 2, type);
      return { type: 'machine-ready' };
    case 'NODE_READY':
      requireLength(tokens, 3, type);
      return { type: 'node-ready', nodeSlot: parsePositiveInteger(tokens[2], 'nodeSlot') };
    case 'NODE_EXIT':
      if (tokens.length !== 4) throw new Error('NODE_EXIT requires a node slot and encoded reason');
      return {
        type: 'node-exit',
        nodeSlot: parsePositiveInteger(tokens[2], 'nodeSlot'),
        reason: decodeSharedText(tokens[3]!),
      };
    case 'OK':
      if (tokens.length < 3) throw new Error('OK requires a request ID');
      return {
        type: 'response',
        ok: true,
        requestId: parsePositiveInteger(tokens[2], 'requestId'),
        detail: tokens.slice(3),
      };
    case 'ERR':
      if (tokens.length < 4) throw new Error('ERR requires a request ID and error code');
      assertToken(tokens[3]!, 'error code');
      return {
        type: 'response',
        ok: false,
        requestId: parsePositiveInteger(tokens[2], 'requestId'),
        code: tokens[3]!,
        detail: tokens.slice(4),
      };
    case 'TERM_DATA': {
      requireLength(tokens, 5, type);
      const data = decodeSharedBytes(tokens[4]!);
      if (data.byteLength > MAX_SHARED_TERMINAL_CHUNK_BYTES) {
        throw new Error(`Terminal data exceeds ${MAX_SHARED_TERMINAL_CHUNK_BYTES} bytes`);
      }
      return {
        type: 'terminal-data',
        nodeSlot: parsePositiveInteger(tokens[2], 'nodeSlot'),
        sessionId: parsePositiveInteger(tokens[3], 'sessionId'),
        data,
      };
    }
    case 'LOG': {
      requireLength(tokens, 5, type);
      const level = tokens[3];
      if (level !== 'info' && level !== 'warning' && level !== 'error') {
        throw new Error(`Invalid shared guest log level: ${String(level)}`);
      }
      return {
        type: 'log',
        nodeSlot: parsePositiveInteger(tokens[2], 'nodeSlot'),
        level,
        message: decodeSharedText(tokens[4]!),
      };
    }
    default:
      throw new Error(`Unknown shared guest message: ${String(type)}`);
  }
}

export function encodeSharedBytes(bytes: Uint8Array): string {
  let result = '';
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const combined = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    result += alphabet[(combined >>> 18) & 63];
    result += alphabet[(combined >>> 12) & 63];
    result += second === undefined ? '=' : alphabet[(combined >>> 6) & 63];
    result += third === undefined ? '=' : alphabet[combined & 63];
  }
  return result;
}

export function decodeSharedBytes(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('Invalid canonical base64 payload');
  }
  if (value.length === 0) return new Uint8Array();
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const output = new Uint8Array((value.length / 4) * 3 - padding);
  let outputOffset = 0;
  for (let offset = 0; offset < value.length; offset += 4) {
    const a = alphabet.indexOf(value[offset]!);
    const b = alphabet.indexOf(value[offset + 1]!);
    const c = value[offset + 2] === '=' ? 0 : alphabet.indexOf(value[offset + 2]!);
    const d = value[offset + 3] === '=' ? 0 : alphabet.indexOf(value[offset + 3]!);
    const combined = (a << 18) | (b << 12) | (c << 6) | d;
    if (outputOffset < output.length) output[outputOffset++] = combined >>> 16;
    if (outputOffset < output.length) output[outputOffset++] = combined >>> 8;
    if (outputOffset < output.length) output[outputOffset++] = combined;
  }
  // Reject non-zero pad bits, which otherwise admit multiple cache/protocol encodings.
  if (encodeSharedBytes(output) !== value) throw new Error('Invalid canonical base64 payload');
  return output;
}

export function encodeSharedText(value: string): string {
  return encodeSharedBytes(new TextEncoder().encode(value));
}

export function decodeSharedText(value: string): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(decodeSharedBytes(value));
}

function parsePositiveInteger(value: string | undefined, label: string): number {
  if (value === undefined || !/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${label} must be a positive canonical integer`);
  }
  const parsed = Number(value);
  assertPositiveInteger(parsed, label);
  return parsed;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`);
}

function assertToken(value: string, label: string): void {
  if (value.length === 0 || /[\s\0]/.test(value)) throw new Error(`${label} must be a non-empty protocol token`);
}

function requireLength(tokens: readonly string[], length: number, type: string): void {
  if (tokens.length !== length) throw new Error(`${type} has an invalid field count`);
}
