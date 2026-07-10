/**
 * Minimal OpenAI-compatible SSE parser.
 *
 * llama-server's `/v1/chat/completions?stream=true` emits `data: {json}\n\n`
 * frames terminated by `data: [DONE]`. This yields each JSON payload string
 * (already stripped of the `data:` prefix, `[DONE]` excluded), buffering across
 * chunk boundaries. Accepts any async iterable of bytes/strings so it drives
 * from a `fetch` body or a test fixture equally.
 */

/** Yield raw JSON payload strings from an SSE byte/string stream. */
export async function* parseSSE(
  source: AsyncIterable<Uint8Array | string>,
): AsyncGenerator<string, void, unknown> {
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines: string[] = [];

  const flush = (): string | undefined => {
    if (dataLines.length === 0) return undefined;
    const payload = dataLines.join('\n');
    dataLines = [];
    return payload;
  };

  // Consume one field line; returns a completed payload at an event boundary.
  const takeLine = (rawLine: string): string | undefined => {
    if (rawLine === '') return flush(); // event boundary
    if (rawLine.startsWith(':')) return undefined; // comment / keep-alive
    if (rawLine.startsWith('data:')) {
      // "data:" optionally followed by a single leading space.
      dataLines.push(rawLine.slice(5).replace(/^ /, ''));
    }
    // Other SSE fields (event:, id:, retry:) are irrelevant here.
    return undefined;
  };

  for await (const chunk of source) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });

    // Normalise CRLF then split on LF; recompute the boundary each pass.
    for (let nl = buffer.indexOf('\n'); nl !== -1; nl = buffer.indexOf('\n')) {
      const rawLine = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      const payload = takeLine(rawLine);
      if (payload !== undefined && payload !== '[DONE]') yield payload;
    }
  }

  // Trailing line + event with no final blank line (e.g. "data: {…}" at EOF).
  const leftover = buffer.replace(/\r$/, '');
  if (leftover.length > 0) takeLine(leftover);
  const tail = flush();
  if (tail !== undefined && tail !== '[DONE]') yield tail;
}
