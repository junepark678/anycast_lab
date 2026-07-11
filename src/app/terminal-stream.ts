export interface ConsumedTerminalChunk {
  readonly complete: string;
  readonly pending: string;
}

/**
 * Coalesce arbitrary serial byte chunks into complete lines before the UI
 * adds node metadata. This prevents prefixes from being inserted in the
 * middle of daemon output (for example, `Estab[node]lished`).
 */
export function consumeTerminalChunk(pending: string, chunk: string): ConsumedTerminalChunk {
  const combined = pending + chunk;
  const boundary = combined.lastIndexOf('\n');
  if (boundary < 0) return { complete: '', pending: combined };
  return {
    complete: cleanTerminalOutput(combined.slice(0, boundary + 1)),
    pending: combined.slice(boundary + 1),
  };
}

export function cleanTerminalOutput(value: string): string {
  return value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '');
}
