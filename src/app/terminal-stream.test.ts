import { describe, expect, it } from 'vitest';
import { consumeTerminalChunk } from './terminal-stream';

describe('consumeTerminalChunk', () => {
  it('never inserts a rendering boundary inside a split daemon word', () => {
    const first = consumeTerminalChunk('', 'BGP state: Estab');
    expect(first).toEqual({ complete: '', pending: 'BGP state: Estab' });

    const second = consumeTerminalChunk(first.pending, 'lished\r\nrouter# ');
    expect(second).toEqual({ complete: 'BGP state: Established\n', pending: 'router# ' });
  });

  it('strips ANSI sequences even when the sequence arrived across chunks', () => {
    const first = consumeTerminalChunk('', '\u001b[3');
    const second = consumeTerminalChunk(first.pending, '1mready\u001b[0m\r\n');
    expect(second).toEqual({ complete: 'ready\n', pending: '' });
  });

  it('emits all complete lines and retains only the unfinished suffix', () => {
    expect(consumeTerminalChunk('old ', 'line\nnext\npartial')).toEqual({
      complete: 'old line\nnext\n',
      pending: 'partial',
    });
  });
});
