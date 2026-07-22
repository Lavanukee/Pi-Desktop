/**
 * Pull string fields out of a possibly-INCOMPLETE JSON buffer — a tool call's
 * streamed `argsText`, before it parses into `arguments`. Used so a whole-file
 * write can DRAW into the canvas and tick its +N line count up as it streams,
 * instead of popping in whole at completion.
 *
 * Pure + dependency-free (shared by file-writes.ts and activity-mapping.ts, which
 * already form an import pair — keeping this here avoids a cycle).
 */

const JSON_ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  b: '\b',
  f: '\f',
  '"': '"',
  '\\': '\\',
  '/': '/',
};

/** Candidate keys for a written file's path / whole-file content, in priority order. */
export const PATH_KEYS = ['path', 'file_path', 'filename', 'file', 'target_file'] as const;
export const CONTENT_KEYS = ['content', 'file_text', 'contents'] as const;

/**
 * Locate `"key": "` in `buf` and decode the JSON string that follows up to its
 * closing quote — or, if the buffer ends first, up to the end. Returns the
 * decoded text so far and whether the value closed. A trailing partial escape at
 * the buffer edge is dropped (it completes on the next delta). Keys are simple
 * identifiers, so they're safe to embed in the search pattern.
 */
export function partialJsonString(
  buf: string,
  keys: readonly string[],
): { value: string; complete: boolean } | undefined {
  for (const key of keys) {
    const at = buf.search(new RegExp(`"${key}"\\s*:\\s*"`));
    if (at === -1) continue;
    const start = buf.indexOf('"', buf.indexOf(':', at) + 1) + 1;
    let out = '';
    let i = start;
    let complete = false;
    while (i < buf.length) {
      const c = buf[i];
      if (c === '"') {
        complete = true;
        break;
      }
      if (c === '\\') {
        const n = buf[i + 1];
        if (n === undefined) break; // partial escape at the buffer edge
        if (n === 'u') {
          const hex = buf.slice(i + 2, i + 6);
          if (hex.length < 4) break; // incomplete \uXXXX at the edge
          out += String.fromCharCode(Number.parseInt(hex, 16));
          i += 6;
          continue;
        }
        out += JSON_ESCAPES[n] ?? n;
        i += 2;
        continue;
      }
      out += c;
      i += 1;
    }
    return { value: out, complete };
  }
  return undefined;
}
