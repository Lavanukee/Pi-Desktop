/**
 * Canvas-awareness — inject "what is on the canvas RIGHT NOW" into the model's
 * context before every LLM call (jedd's gotcha: the model must always know what
 * the user is looking at).
 *
 * pi's `context` hook (`ContextEvent { messages }` → `{ messages? }`) fires
 * before each LLM call and returns a NON-destructive replacement message list —
 * the persisted session is untouched (same seam the web-tools image sanitizer
 * uses). On each call we fetch the compact {@link CanvasState} MAIN caches (over
 * the existing browser-agent socket) and append a small `<canvas_state>` block
 * as the LAST message, STRIPPING any prior block first so it never accumulates.
 *
 * Why APPEND (not prepend): llama-server keys its prompt KV cache on the longest
 * common prefix. Keeping the volatile canvas text at the TAIL means the stable
 * prefix (system + history) is reused turn-to-turn; only the short tail is
 * recomputed (round-10 #8).
 *
 * `Message` has no `system` role (system is a separate `systemPrompt`), so the
 * block rides in a trailing `user`-role message — the "ephemeral trailing block"
 * the design calls for.
 *
 * Kept structural (no pi imports beyond the event type) so it unit-tests in
 * plain Node.
 */
import type { ContextEvent, ExtensionAPI } from '@mariozechner/pi-coding-agent';
import type { CanvasState, CanvasSurfaceState } from './protocol.js';

/** The message shape pi's `context` hook operates on. Derived from the exported
 * {@link ContextEvent} so we don't take a direct dep on `@mariozechner/pi-agent-core`. */
export type CanvasContextMessage = ContextEvent['messages'][number];

/** The narrow surface the context hook depends on (a `BrowserAgentClient`, or a
 * fake in tests). Separate from `BrowserBridge` so adding it never disturbs the
 * tool bridges. */
export interface CanvasStateSource {
  getCanvasState(): Promise<CanvasState | null>;
}

/** Sentinel wrapping the injected block, so a prior copy is found + stripped. */
export const CANVAS_STATE_OPEN = '<canvas_state>';
export const CANVAS_STATE_CLOSE = '</canvas_state>';

/** Excerpts injected for an open file are capped so the block stays cache-cheap. */
const EXCERPT_MAX_CHARS = 240;

/** A one-liner describing a single surface (e.g. `Browser — "Sandboxels"
 * (https://neal.fun/sandboxels/)`). Terser when a field is absent. */
function describeSurface(s: CanvasSurfaceState): string {
  const title = s.title?.trim();
  switch (s.kind) {
    case 'browser': {
      const url = s.url?.trim();
      const named = title && title.length > 0 && title !== 'New tab' ? `"${title}"` : null;
      if (named && url) return `Browser — ${named} (${url})`;
      if (url) return `Browser (${url})`;
      if (named) return `Browser — ${named}`;
      return 'Browser (blank tab)';
    }
    case 'file':
    case 'code': {
      const label = s.filePath?.trim() || title || 'a file';
      return `File ${label}${s.dirty === true ? ' (unsaved)' : ''}`;
    }
    case 'terminal': {
      const parts: string[] = [];
      if (s.cwd) parts.push(`cwd ${s.cwd}`);
      if (s.lastCommand) parts.push(`last: \`${s.lastCommand}\``);
      return parts.length > 0 ? `Terminal (${parts.join(', ')})` : 'Terminal';
    }
    case 'image':
      return `Image${title ? ` "${title}"` : ''}`;
    case 'pdf':
      return `PDF${title ? ` "${title}"` : ''}`;
    case 'filetree':
      return 'File tree';
    case 'subagent':
      return 'Subagents panel';
    case 'html':
    case 'svg':
    case 'markdown':
      return `${s.kind.toUpperCase()} preview${title ? ` "${title}"` : ''}`;
    default:
      return `${s.kind}${title ? ` "${title}"` : ''}`;
  }
}

/**
 * Render the canvas snapshot as the compact `<canvas_state>` block. Returns
 * `null` when there is genuinely nothing on the canvas (so the hook can skip
 * injecting an empty block).
 */
export function formatCanvasSummary(state: CanvasState): string | null {
  const active = state.active;
  const others = state.others ?? [];
  if (active === null && others.length === 0) return null;

  const lines: string[] = [];
  lines.push(
    active !== null
      ? `The user is looking at: ${describeSurface(active)}`
      : 'The canvas is open (no surface focused).',
  );
  if (others.length > 0) {
    lines.push(`Also open: ${others.map(describeSurface).join(' · ')}`);
  }
  const excerpt = active?.excerpt?.trim();
  if (excerpt) {
    const clipped =
      excerpt.length > EXCERPT_MAX_CHARS ? `${excerpt.slice(0, EXCERPT_MAX_CHARS)}…` : excerpt;
    lines.push(`Excerpt:\n${clipped}`);
  }
  return `${CANVAS_STATE_OPEN}\n${lines.join('\n')}\n${CANVAS_STATE_CLOSE}`;
}

/** The plain text of a message (string content or joined text blocks). */
function messageText(msg: CanvasContextMessage): string {
  const content = (msg as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) =>
      b !== null && typeof b === 'object' && (b as { type?: unknown }).type === 'text'
        ? String((b as { text?: unknown }).text ?? '')
        : '',
    )
    .join('');
}

/** Matches an injected block (with any leading blank line from a merge). */
const CANVAS_BLOCK_RE = /\n{0,2}<canvas_state>[\s\S]*?<\/canvas_state>[ \t]*/g;

/** A message's content (string OR text-block array) with any injected block
 * span removed; empty text blocks are dropped. */
function contentWithoutBlock(content: unknown): unknown {
  if (typeof content === 'string') return content.replace(CANVAS_BLOCK_RE, '');
  if (!Array.isArray(content)) return content;
  return content
    .map((b) =>
      b !== null && typeof b === 'object' && (b as { type?: unknown }).type === 'text'
        ? {
            ...(b as object),
            text: String((b as { text?: unknown }).text ?? '').replace(CANVAS_BLOCK_RE, ''),
          }
        : b,
    )
    .filter(
      (b) =>
        !(
          b !== null &&
          typeof b === 'object' &&
          (b as { type?: unknown }).type === 'text' &&
          String((b as { text?: unknown }).text ?? '').length === 0
        ),
    );
}

/** True for a USER message still carrying an injected `<canvas_state>` block.
 * Role-guarded so an assistant turn that merely mentions the tag is left alone
 * (we only ever inject into the user's own turn). */
export function isCanvasStateMessage(msg: CanvasContextMessage): boolean {
  if ((msg as { role?: unknown }).role !== 'user') return false;
  return messageText(msg).includes(CANVAS_STATE_OPEN);
}

/** Append the block into a message's content (string or text-block array). */
function appendBlock(msg: CanvasContextMessage, block: string): CanvasContextMessage {
  const content = (msg as { content?: unknown }).content;
  if (typeof content === 'string') {
    return { ...(msg as object), content: `${content}\n\n${block}` } as CanvasContextMessage;
  }
  if (Array.isArray(content)) {
    return {
      ...(msg as object),
      content: [...content, { type: 'text', text: `\n\n${block}` }],
    } as CanvasContextMessage;
  }
  return { ...(msg as object), content: block } as CanvasContextMessage;
}

/**
 * Return `messages` with any prior injected block STRIPPED, then the fresh
 * `block` MERGED INTO the current (last) user turn — NOT added as a separate
 * message. The provider sends messages verbatim to llama-server's
 * `/chat/completions`, where Gemma's `--jinja` template requires strict
 * user/model alternation; a second trailing `user` message would break it. If
 * the last message somehow isn't a user turn, we fall back to a new user
 * message. Either way the volatile block sits at the very tail, so the stable
 * prefix (system + history + the user's prompt) is preserved for the KV cache.
 */
export function withCanvasBlock(
  messages: readonly CanvasContextMessage[],
  block: string,
): CanvasContextMessage[] {
  const kept = stripCanvasBlock(messages);
  const last = kept[kept.length - 1];
  if (last !== undefined && (last as { role?: unknown }).role === 'user') {
    return [...kept.slice(0, -1), appendBlock(last, block)];
  }
  return [...kept, { role: 'user', content: block, timestamp: Date.now() } as CanvasContextMessage];
}

/** Strip any injected block without appending a new one (canvas went empty).
 * Removes the block SPAN from message content and drops a message that becomes
 * empty (an older separate-message injection). */
export function stripCanvasBlock(
  messages: readonly CanvasContextMessage[],
): CanvasContextMessage[] {
  const out: CanvasContextMessage[] = [];
  for (const msg of messages) {
    if (!isCanvasStateMessage(msg)) {
      out.push(msg);
      continue;
    }
    const content = contentWithoutBlock((msg as { content?: unknown }).content);
    const emptied =
      (typeof content === 'string' && content.trim().length === 0) ||
      (Array.isArray(content) && content.length === 0);
    if (!emptied) out.push({ ...(msg as object), content } as CanvasContextMessage);
  }
  return out;
}

/**
 * Compute the context-hook result for one LLM call: fetch the canvas state and
 * return the message list to use, or `undefined` for "no change" (so pi keeps
 * the original array and the KV cache is untouched). Pure + injectable for tests.
 */
export async function buildCanvasContext(
  source: CanvasStateSource,
  messages: readonly CanvasContextMessage[],
): Promise<{ messages: CanvasContextMessage[] } | undefined> {
  let state: CanvasState | null;
  try {
    state = await source.getCanvasState();
  } catch {
    state = null;
  }
  const block = state !== null ? formatCanvasSummary(state) : null;
  if (block === null) {
    // Nothing (new) to say. Only touch the list if a stale block lingers.
    return messages.some(isCanvasStateMessage)
      ? { messages: stripCanvasBlock(messages) }
      : undefined;
  }
  return { messages: withCanvasBlock(messages, block) };
}

/**
 * Register the canvas-awareness `context` hook. Safe to call only when a bridge
 * exists (inside Pi Desktop); outside it there is nothing to report.
 */
export function registerCanvasContext(pi: ExtensionAPI, source: CanvasStateSource): void {
  pi.on('context', (event) => buildCanvasContext(source, event.messages));
}
