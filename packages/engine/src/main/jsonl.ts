/**
 * Strict JSONL framing for the pi RPC protocol.
 *
 * The protocol mandates LF (`\n`) as the ONLY record delimiter. Generic line
 * readers (e.g. node:readline) are non-compliant because they also split on
 * U+2028 / U+2029, which are valid inside JSON strings. This splitter:
 * - splits on `\n` only,
 * - strips one optional trailing `\r` (accepts CRLF input),
 * - buffers partial lines across chunk boundaries,
 * - skips blank lines.
 */
export interface JsonlSplitter {
  /** Feed a decoded chunk (the caller owns byte→string decoding). */
  push(chunk: string): void;
  /** Flush a trailing unterminated line (call on stream end). */
  flush(): void;
}

export function createJsonlSplitter(onLine: (line: string) => void): JsonlSplitter {
  let buffer = '';
  const emit = (rawLine: string): void => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.trim().length > 0) onLine(line);
  };
  return {
    push(chunk) {
      buffer += chunk;
      let idx = buffer.indexOf('\n');
      while (idx >= 0) {
        emit(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
        idx = buffer.indexOf('\n');
      }
    },
    flush() {
      if (buffer.length > 0) {
        emit(buffer);
        buffer = '';
      }
    },
  };
}

/** Serialize one JSONL record. JSON.stringify escapes all control chars, so the
 * only `\n` in the output is the record delimiter appended here. */
export function serializeJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
