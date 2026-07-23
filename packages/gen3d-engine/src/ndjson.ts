/**
 * NDJSON plumbing for the sidecar's /events stream: a pure chunk→line splitter
 * (unit-tested) and a fetch-based stream consumer with auto-reconnect.
 */

/** Feed arbitrary string chunks; complete `\n`-terminated JSON lines invoke
 * `onValue`. Malformed lines are skipped (never throw on stream garbage). */
export function createNdjsonSplitter(onValue: (value: unknown) => void): (chunk: string) => void {
  let buffer = '';
  return (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line.length === 0) continue;
      try {
        onValue(JSON.parse(line));
      } catch {
        // skip malformed line
      }
    }
  };
}

/**
 * Consume an NDJSON endpoint until aborted. Reconnects after `retryMs` on
 * stream end/error (the sidecar restarts under its supervisor; the event
 * stream should self-heal without the caller doing anything).
 */
export async function consumeNdjsonStream(opts: {
  readonly url: string;
  readonly signal: AbortSignal;
  readonly onValue: (value: unknown) => void;
  readonly fetchImpl?: typeof fetch;
  readonly retryMs?: number;
}): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const retryMs = opts.retryMs ?? 1_000;
  while (!opts.signal.aborted) {
    try {
      const res = await fetchImpl(opts.url, { signal: opts.signal });
      if (res.ok && res.body !== null) {
        const splitter = createNdjsonSplitter(opts.onValue);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          splitter(decoder.decode(value, { stream: true }));
        }
      }
    } catch {
      // fall through to retry
    }
    if (opts.signal.aborted) return;
    await new Promise((r) => setTimeout(r, retryMs));
  }
}
