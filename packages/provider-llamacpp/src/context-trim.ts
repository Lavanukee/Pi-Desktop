/**
 * Context-overflow recovery (jedd, 2026-07-24): llama-server rejects a prompt
 * that exceeds its `n_ctx` with an HTTP 400 `exceed_context_size_error`, e.g.
 *
 *   {"error":{"code":400,"message":"request (32978 tokens) exceeds the available
 *    context size (32768 tokens), try increasing it","type":
 *    "exceed_context_size_error","n_prompt_tokens":32978,"n_ctx":32768}}
 *
 * Two things must NEVER happen when this fires:
 *   1. the raw JSON blob must not reach the chat (see stream.ts / cleanProviderError);
 *   2. the turn must not hard-fail — we recover by TRIMMING context and retrying.
 *
 * Recovery lives in the PROVIDER (the layer we own, closest to the error) rather
 * than in pi's compaction: the provider holds the full {@link Context} and can
 * re-issue the request transparently, so pi never sees the overflow and its
 * "compaction failed" path is bypassed entirely.
 *
 * The bulk of an overflowing prompt is almost always accumulated TOOL RESULTS —
 * a session that ran a stack of `find` / `grep` / `read` calls and dumped their
 * output into the history. So we drop the OLDEST tool results first (they're the
 * stalest, and typically the biggest exploration dumps), replacing each with a
 * short placeholder, while preserving every user message and the most recent
 * turns. The caller loops, re-reading the fresh token counts the server reports
 * on each retry, until the request fits or nothing is left to trim.
 *
 * All functions here are PURE (the {@link Context} is copied, never mutated) so
 * they unit-test without a live server.
 */
import type { Context, Message, TextContent, ToolResultMessage } from '@mariozechner/pi-ai';

/** Conservative chars-per-token for mixed code/CLI output — matches the harness
 * tool-output truncator. A low ratio over-counts tokens, so we trim a touch more
 * than strictly needed (safe: overshooting the trim just leaves more headroom). */
const CHARS_PER_TOKEN = 4;

/** Extra tokens to free BEYOND the raw overshoot, so the trimmed prompt leaves
 * room for the model's reply (and absorbs our char-estimate slop). */
export const REPLY_MARGIN_TOKENS = 2_048;

/** Hard cap on trim→retry passes, so a pathological prompt can't loop forever.
 * Each pass strips more tool results; in practice one or two passes suffice. */
export const MAX_OVERFLOW_RETRIES = 6;

/** Replacement text for a dropped tool result. Kept tiny + recognizable so a
 * later pass skips an already-trimmed result (idempotent) and the model still
 * sees that a tool ran here. */
export const OVERFLOW_TRIM_PLACEHOLDER = '[earlier tool output trimmed to fit context]';

/** Parsed shape of a llama-server context-overflow error. */
export interface ContextOverflow {
  /** The server's configured context window (`n_ctx`). */
  readonly nCtx: number;
  /** How many tokens the rejected prompt was (`n_prompt_tokens`). */
  readonly nPromptTokens: number;
}

/** ~token count of a string (chars / {@link CHARS_PER_TOKEN}, rounded up). Pure. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Detect + parse a llama-server context-overflow error from an HTTP error body.
 * Reads the structured `exceed_context_size_error` fields first (robust to key
 * order), then falls back to the human message's token counts. Returns
 * `undefined` for any other error, so the caller only enters recovery for a real
 * overflow. Pure.
 */
export function parseContextOverflow(body: string): ContextOverflow | undefined {
  // Structured form: {"error":{"type":"exceed_context_size_error","n_ctx":…,
  // "n_prompt_tokens":…}} (the error object may also be at the top level).
  try {
    const parsed = JSON.parse(body) as {
      error?: Record<string, unknown>;
      type?: unknown;
      n_ctx?: unknown;
      n_prompt_tokens?: unknown;
    };
    const err = (parsed.error ?? parsed) as Record<string, unknown>;
    const looksOverflow =
      err.type === 'exceed_context_size_error' ||
      (typeof err.n_ctx === 'number' && typeof err.n_prompt_tokens === 'number');
    if (looksOverflow) {
      const nCtx = Number(err.n_ctx);
      const nPromptTokens = Number(err.n_prompt_tokens);
      if (nCtx > 0 && nPromptTokens > 0) return { nCtx, nPromptTokens };
    }
  } catch {
    // not JSON — fall through to the message-text regex
  }
  // Message-text fallback: "request (32978 tokens) exceeds the available context
  // size (32768 tokens)". Guards against a future server that drops the fields.
  const m = body.match(
    /\((\d+)\s*tokens?\)\s*exceeds the available context size\s*\((\d+)\s*tokens?\)/i,
  );
  if (m?.[1] !== undefined && m[2] !== undefined) {
    const nPromptTokens = Number(m[1]);
    const nCtx = Number(m[2]);
    if (nCtx > 0 && nPromptTokens > 0) return { nCtx, nPromptTokens };
  }
  return undefined;
}

/** Concatenated text of a tool-result message's text parts. Pure. */
function toolResultText(msg: ToolResultMessage): string {
  return msg.content
    .filter((c): c is TextContent => c.type === 'text')
    .map((c) => c.text)
    .join('');
}

/** A tool-result message with its text replaced by `text` (other fields kept).
 * Drops any image parts too — a tool result big enough to trim is text, and an
 * inline image is exactly the kind of bulk an overflowing prompt can't afford. */
function replaceToolResultText(msg: ToolResultMessage, text: string): ToolResultMessage {
  return { ...msg, content: [{ type: 'text', text }] };
}

/** Result of one {@link trimContextForOverflow} pass. */
export interface TrimResult {
  /** A new context with oldest tool results replaced by the placeholder (the
   * input is returned unchanged when nothing was trimmable). */
  readonly context: Context;
  /** Estimated tokens freed this pass. */
  readonly removedTokens: number;
  /** How many tool results were replaced. */
  readonly trimmedCount: number;
}

/**
 * Free ~`tokensToRemove` tokens from `context` by replacing the OLDEST not-yet-
 * trimmed tool results with {@link OVERFLOW_TRIM_PLACEHOLDER}, stopping as soon
 * as the target is met. User + assistant messages are never touched, so the
 * conversation's intent and the model's own reasoning survive; only stale tool
 * output (the bulk) is shed. Pure — returns a fresh context, never mutates.
 *
 * Idempotent across passes: an already-placeholdered result is skipped, so a
 * caller can loop (trim → retry → trim more) and each pass makes real progress
 * until every trimmable tool result is gone.
 */
export function trimContextForOverflow(context: Context, tokensToRemove: number): TrimResult {
  if (tokensToRemove <= 0) return { context, removedTokens: 0, trimmedCount: 0 };

  const placeholderTokens = estimateTokens(OVERFLOW_TRIM_PLACEHOLDER);
  const out: Message[] = context.messages.slice();
  let removed = 0;
  let trimmedCount = 0;

  // Oldest-first: index 0 is the start of the conversation. Preserving recent
  // turns means we shed from the front and stop the moment we've freed enough.
  for (let i = 0; i < out.length && removed < tokensToRemove; i++) {
    const msg = out[i];
    if (msg === undefined || msg.role !== 'toolResult') continue;
    const text = toolResultText(msg);
    if (text === OVERFLOW_TRIM_PLACEHOLDER) continue; // already trimmed on a prior pass
    const cost = estimateTokens(text);
    if (cost <= placeholderTokens) continue; // nothing meaningful to reclaim
    out[i] = replaceToolResultText(msg, OVERFLOW_TRIM_PLACEHOLDER);
    removed += cost - placeholderTokens;
    trimmedCount++;
  }

  if (trimmedCount === 0) return { context, removedTokens: 0, trimmedCount: 0 };
  return { context: { ...context, messages: out }, removedTokens: removed, trimmedCount };
}

/**
 * A short, human, NON-RAW message for a provider error that reached the chat.
 * We never surface the HTTP status + JSON body verbatim — that blob is log-only.
 * An overflow that survived recovery (retries exhausted / nothing left to trim)
 * gets its own guidance; anything else gets a generic retry nudge. Pure.
 */
export function cleanProviderError(status: number, overflow: ContextOverflow | undefined): string {
  if (overflow !== undefined) {
    return "This conversation is too long for the model's context window, even after trimming older tool output. Start a new chat or switch to a larger-context model.";
  }
  return `The local model server returned an error (HTTP ${status}). Please try again.`;
}
