/**
 * Malformed-image-block sanitizer (ported from RemotePi's web-tools.ts).
 *
 * LOAD-BEARING: local models (via llama-server) reject a request outright with a
 * 400 when the message history contains an image content block whose base64
 * `data` is missing/empty/truncated. One bad block bricks the whole session —
 * every subsequent turn 400s. This strips such blocks from the outgoing context
 * on each LLM call (pi's `context` hook), non-destructively: the persisted
 * session is untouched; only the copy sent to the model is cleaned.
 *
 * Kept structural (no `any`, no pi imports beyond the event type) so it
 * unit-tests in plain Node.
 */
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';

/**
 * Minimum plausible length of a base64 image payload. RemotePi's threshold —
 * anything shorter cannot be a real image and is treated as malformed.
 */
export const MIN_IMAGE_DATA_LENGTH = 100;

function isMalformedImageBlock(block: unknown): boolean {
  if (typeof block !== 'object' || block === null) return false;
  const b = block as { type?: unknown; data?: unknown };
  if (b.type !== 'image') return false;
  return typeof b.data !== 'string' || b.data.length < MIN_IMAGE_DATA_LENGTH;
}

/**
 * Return a cleaned copy of `messages` with malformed image blocks removed.
 * `changed` is false (and `messages` is the original array) when nothing was
 * stripped, so callers can skip returning a modification.
 */
export function sanitizeImageBlocks<M>(messages: readonly M[]): {
  messages: M[];
  changed: boolean;
} {
  let changed = false;
  const cleaned = messages.map((msg) => {
    const content = (msg as { content?: unknown }).content;
    if (!Array.isArray(content)) return msg;
    const blocks = content as unknown[];
    const filtered = blocks.filter((block) => !isMalformedImageBlock(block));
    if (filtered.length === blocks.length) return msg;
    changed = true;
    return { ...msg, content: filtered } as M;
  });
  return { messages: changed ? cleaned : [...messages], changed };
}

/** Wire the sanitizer onto pi's `context` hook (runs before each LLM call). */
export function installImageSanitizer(pi: ExtensionAPI): void {
  pi.on('context', (event) => {
    const { messages, changed } = sanitizeImageBlocks(event.messages);
    return changed ? { messages } : undefined;
  });
}
