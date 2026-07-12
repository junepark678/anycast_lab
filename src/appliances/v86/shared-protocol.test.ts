import { describe, expect, it } from 'vitest';
import {
  MAX_SHARED_CONTROL_LINE_BYTES,
  decodeSharedBytes,
  encodeSharedBytes,
  encodeSharedGuestCommand,
  encodeSharedText,
  parseSharedGuestMessage,
} from './shared-protocol';

describe('shared v86 guest protocol', () => {
  it('encodes node-scoped commands without ambiguous tokens', () => {
    expect(new TextDecoder().decode(encodeSharedGuestCommand({
      command: 'LINK',
      requestId: 7,
      nodeSlot: 3,
      arguments: [encodeSharedText('eth0'), 'down'],
    }))).toBe('ANYCASTLAB/2 LINK 7 3 ZXRoMA== down\n');
    expect(() => encodeSharedGuestCommand({
      command: 'PING', requestId: 1, nodeSlot: 1, arguments: ['line\nbreak'],
    })).toThrow(/protocol token/);
  });

  it('parses lifecycle, response, terminal, and log messages', () => {
    expect(parseSharedGuestMessage('ANYCASTLAB/2 READY')).toEqual({ type: 'machine-ready' });
    expect(parseSharedGuestMessage('ANYCASTLAB/2 NODE_READY 9')).toEqual({ type: 'node-ready', nodeSlot: 9 });
    expect(parseSharedGuestMessage(`ANYCASTLAB/2 NODE_EXIT 9 ${encodeSharedText('bgpd exited')}`)).toEqual({
      type: 'node-exit', nodeSlot: 9, reason: 'bgpd exited',
    });
    expect(parseSharedGuestMessage('ANYCASTLAB/2 OK 4 terminal-1')).toEqual({
      type: 'response', ok: true, requestId: 4, detail: ['terminal-1'],
    });
    expect(parseSharedGuestMessage('ANYCASTLAB/2 ERR 4 ENOENT path')).toEqual({
      type: 'response', ok: false, requestId: 4, code: 'ENOENT', detail: ['path'],
    });
    expect(parseSharedGuestMessage(`ANYCASTLAB/2 TERM_DATA 2 8 ${encodeSharedBytes(new Uint8Array([0, 255]))}`)).toEqual({
      type: 'terminal-data', nodeSlot: 2, sessionId: 8, data: new Uint8Array([0, 255]),
    });
    expect(parseSharedGuestMessage(`ANYCASTLAB/2 LOG 2 warning ${encodeSharedText('route rejected')}`)).toEqual({
      type: 'log', nodeSlot: 2, level: 'warning', message: 'route rejected',
    });
  });

  it('rejects non-canonical integers, base64, field counts, and oversized messages', () => {
    expect(() => parseSharedGuestMessage('ANYCASTLAB/2 NODE_READY 01')).toThrow(/canonical integer/);
    expect(() => parseSharedGuestMessage('ANYCASTLAB/2 READY extra')).toThrow(/field count/);
    expect(() => decodeSharedBytes('Zh==')).toThrow(/canonical base64/);
    expect(() => parseSharedGuestMessage(`ANYCASTLAB/2 LOG 1 debug ${encodeSharedText('x')}`)).toThrow(/log level/);
    expect(() => parseSharedGuestMessage('x'.repeat(MAX_SHARED_CONTROL_LINE_BYTES + 1))).toThrow(/exceeds/);
  });

  it('ignores unrelated console output', () => {
    expect(parseSharedGuestMessage('Linux version 6.18')).toBeNull();
  });
});
