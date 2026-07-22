import { describe, expect, it } from 'vitest';
import { CONTENT_KEYS, PATH_KEYS, partialJsonString } from './partial-json';

describe('partialJsonString', () => {
  it('reads a complete string value', () => {
    const buf = '{"path":"src/a.ts","content":"hello"}';
    expect(partialJsonString(buf, PATH_KEYS)).toEqual({ value: 'src/a.ts', complete: true });
    expect(partialJsonString(buf, CONTENT_KEYS)).toEqual({ value: 'hello', complete: true });
  });

  it('reads a value that has not closed yet (streaming)', () => {
    const buf = '{"path":"src/a.ts","content":"line1\\nline2';
    const c = partialJsonString(buf, CONTENT_KEYS);
    expect(c).toEqual({ value: 'line1\nline2', complete: false });
    // Path is already closed even though content is mid-stream.
    expect(partialJsonString(buf, PATH_KEYS)?.complete).toBe(true);
  });

  it('decodes JSON escapes as they stream', () => {
    const buf = '{"content":"a\\tb\\"c\\\\d\\u0041"}';
    expect(partialJsonString(buf, CONTENT_KEYS)).toEqual({ value: 'a\tb"c\\dA', complete: true });
  });

  it('drops a trailing partial escape at the buffer edge', () => {
    // A lone backslash at the end is an incomplete escape — omit it (completes next delta).
    expect(partialJsonString('{"content":"ok\\', CONTENT_KEYS)).toEqual({
      value: 'ok',
      complete: false,
    });
    // An incomplete \u escape at the edge is likewise dropped.
    expect(partialJsonString('{"content":"ok\\u00', CONTENT_KEYS)).toEqual({
      value: 'ok',
      complete: false,
    });
  });

  it('grows monotonically as more of the buffer arrives', () => {
    const full = '{"path":"a.ts","content":"one\\ntwo\\nthree"}';
    let prev = '';
    for (let n = full.indexOf('"content":"') + 11; n <= full.length; n++) {
      const v = partialJsonString(full.slice(0, n), CONTENT_KEYS)?.value ?? '';
      expect(v.startsWith(prev) || prev.startsWith(v)).toBe(true);
      prev = v;
    }
    expect(prev).toBe('one\ntwo\nthree');
  });

  it('returns undefined when the key is absent', () => {
    expect(partialJsonString('{"other":"x"}', CONTENT_KEYS)).toBeUndefined();
  });

  it('honours key priority order', () => {
    expect(partialJsonString('{"file_text":"body"}', CONTENT_KEYS)).toEqual({
      value: 'body',
      complete: true,
    });
  });
});
