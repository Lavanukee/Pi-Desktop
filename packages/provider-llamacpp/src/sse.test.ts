import { describe, expect, it } from 'vitest';
import { parseSSE } from './sse.js';

async function collect(source: AsyncIterable<Uint8Array | string>): Promise<string[]> {
  const out: string[] = [];
  for await (const payload of parseSSE(source)) out.push(payload);
  return out;
}

async function* fromStrings(...chunks: string[]): AsyncGenerator<string> {
  for (const c of chunks) yield c;
}

describe('parseSSE', () => {
  it('parses well-formed data frames and excludes [DONE]', async () => {
    const out = await collect(
      fromStrings('data: {"a":1}\n\n', 'data: {"b":2}\n\n', 'data: [DONE]\n\n'),
    );
    expect(out).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('reassembles frames split across chunk boundaries', async () => {
    const out = await collect(fromStrings('data: {"hel', 'lo":"wor', 'ld"}\n\n'));
    expect(out).toEqual(['{"hello":"world"}']);
  });

  it('handles CRLF line endings and comment/keep-alive lines', async () => {
    const out = await collect(fromStrings(': keep-alive\r\n', 'data: {"x":true}\r\n\r\n'));
    expect(out).toEqual(['{"x":true}']);
  });

  it('decodes byte chunks (Uint8Array) too', async () => {
    const enc = new TextEncoder();
    async function* bytes(): AsyncGenerator<Uint8Array> {
      yield enc.encode('data: {"n":');
      yield enc.encode('42}\n\n');
    }
    expect(await collect(bytes())).toEqual(['{"n":42}']);
  });

  it('flushes a trailing frame with no final blank line', async () => {
    expect(await collect(fromStrings('data: {"tail":1}'))).toEqual(['{"tail":1}']);
  });
});
