import { describe, expect, it } from 'vitest';
import { createNdjsonSplitter } from './ndjson';

describe('createNdjsonSplitter', () => {
  it('reassembles values split across arbitrary chunk boundaries', () => {
    const seen: unknown[] = [];
    const feed = createNdjsonSplitter((v) => seen.push(v));
    feed('{"a":');
    feed('1}\n{"b":2}\n{"c"');
    feed(':3}\n');
    expect(seen).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  it('skips malformed lines without dropping the stream', () => {
    const seen: unknown[] = [];
    const feed = createNdjsonSplitter((v) => seen.push(v));
    feed('not json\n{"ok":true}\n');
    expect(seen).toEqual([{ ok: true }]);
  });

  it('ignores blank keepalive lines', () => {
    const seen: unknown[] = [];
    const feed = createNdjsonSplitter((v) => seen.push(v));
    feed('\n\n{"x":1}\n');
    expect(seen).toEqual([{ x: 1 }]);
  });
});
