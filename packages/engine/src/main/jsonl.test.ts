import { describe, expect, it } from 'vitest';
import { createJsonlSplitter, serializeJsonLine } from './jsonl';

function collect(): { lines: string[]; split: ReturnType<typeof createJsonlSplitter> } {
  const lines: string[] = [];
  const split = createJsonlSplitter((line) => lines.push(line));
  return { lines, split };
}

describe('createJsonlSplitter', () => {
  it('emits complete lines and buffers a trailing partial across chunks', () => {
    const { lines, split } = collect();
    split.push('{"a":1}\n{"b"');
    expect(lines).toEqual(['{"a":1}']);
    split.push(':2}\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('handles many lines per chunk and chunks split mid-line', () => {
    const { lines, split } = collect();
    split.push('{"a":1}\n{"b":2}\n{"c"');
    split.push(':3}\n{"d":4}\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}', '{"d":4}']);
  });

  it('does NOT split on U+2028/U+2029 inside JSON strings (readline is non-compliant)', () => {
    const { lines, split } = collect();
    const record = JSON.stringify({ text: 'a\u2028b\u2029c' });
    // V8 emits the separators raw, so they really appear mid-record on the wire.
    expect(record).toContain('\u2028');
    split.push(`${record}\n`);
    expect(lines).toEqual([record]);
    expect(JSON.parse(lines[0] ?? '')).toEqual({ text: 'a\u2028b\u2029c' });
  });

  it('accepts CRLF by stripping the trailing carriage return', () => {
    const { lines, split } = collect();
    split.push('{"a":1}\r\n{"b":2}\r\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('keeps interior carriage returns intact', () => {
    const { lines, split } = collect();
    const record = JSON.stringify({ text: 'a\rb' });
    split.push(`${record}\n`);
    expect(JSON.parse(lines[0] ?? '')).toEqual({ text: 'a\rb' });
  });

  it('skips blank and whitespace-only lines', () => {
    const { lines, split } = collect();
    split.push('\n   \n{"a":1}\n\r\n');
    expect(lines).toEqual(['{"a":1}']);
  });

  it('flush() emits an unterminated trailing line once', () => {
    const { lines, split } = collect();
    split.push('{"a":1}');
    expect(lines).toEqual([]);
    split.flush();
    split.flush();
    expect(lines).toEqual(['{"a":1}']);
  });

  it('handles a single record arriving one character at a time', () => {
    const { lines, split } = collect();
    for (const ch of '{"x":"y"}\n') split.push(ch);
    expect(lines).toEqual(['{"x":"y"}']);
  });
});

describe('serializeJsonLine', () => {
  it('appends exactly one LF and never embeds raw newlines', () => {
    const line = serializeJsonLine({ text: 'a\nb\r\nc' });
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1)).not.toContain('\n');
  });
});
