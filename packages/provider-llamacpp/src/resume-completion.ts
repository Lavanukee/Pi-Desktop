/**
 * TOKEN-EXACT pause/resume for llama-server — the separated, self-contained
 * llama.cpp adapter.
 *
 * Pausing a chat aborts the in-flight generation but leaves the slot's KV cache
 * (system + history + user + the partial reply) RESIDENT. Resuming continues
 * that exact reply rather than regenerating it, using two llama.cpp-SPECIFIC
 * server endpoints pi's OpenAI-compat surface does NOT expose:
 *
 *   1. `POST /apply-template` — renders the EXACT prompt string for a message
 *      list under the server's active chat template (the same jinja template
 *      `--chat-template-file` installs). We pass `add_generation_prompt:true`
 *      so the assistant turn's opening framing is included, and
 *      `chat_template_kwargs.enable_thinking` matching the paused turn.
 *   2. `POST /completion` — the RAW (non-chat) completion endpoint. Feeding it
 *      `renderedPrompt + partialAssistantText` with `cache_prompt:true`
 *      CONTINUES the interrupted reply: the paused generation left
 *      system+history+user+partial in the slot's KV, so the server re-uses it
 *      (measured `prompt_n ≈ 1`, i.e. ~0 re-prefill) and generates EXACTLY where
 *      it stopped — partial + continuation is byte-for-byte the never-paused
 *      one-shot. If the KV was evicted (another request hit the single slot),
 *      `cache_prompt` still yields the CORRECT output — it just re-prefills the
 *      prompt first (slower, still correct).
 *
 * This module is deliberately isolated (only `./sse` for SSE framing, no pi
 * runtime, no node built-ins) so it is easy to update as llama.cpp's endpoints
 * evolve. The request-shaping + partial-serialization helpers are pure and
 * unit-tested; `resumeCompletion` is the one impure (fetch) entry point.
 */
import { parseSSE } from './sse.js';

/** llama.cpp `/completion` final-frame timings (subset we read). */
export interface ResumeCompletionTimings {
  /** Prompt tokens the server actually had to prefill. ~1 ⇒ the KV was resident
   * (token-exact continuation); large ⇒ it re-prefilled (KV was evicted). */
  readonly prompt_n?: number;
  readonly predicted_n?: number;
  readonly predicted_per_second?: number;
}

/**
 * A block of the frozen partial assistant reply, in the renderer's shape
 * (thinking vs text), the input to {@link serializePartialAssistant}. Tool-call
 * blocks are intentionally excluded — a partial paused mid-tool-call is not
 * continued through this path.
 */
export type PartialBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'thinking'; readonly thinking: string };

/**
 * Strip a trailing `/v1` (and any trailing slashes) to reach the RAW server
 * root that hosts `/apply-template` and `/completion`, e.g.
 * `http://127.0.0.1:8080/v1` → `http://127.0.0.1:8080`. Idempotent for a root
 * that already lacks `/v1`. Pure.
 */
export function llamaServerRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
}

/** The `/apply-template` request body. */
export interface ApplyTemplateBody {
  readonly messages: ReadonlyArray<Record<string, unknown>>;
  readonly add_generation_prompt: true;
  readonly chat_template_kwargs: { readonly enable_thinking: boolean };
}

/**
 * Build the `/apply-template` body for `[system, ...history, user]`.
 * `add_generation_prompt:true` includes the assistant turn's opening framing;
 * `enable_thinking` must match the paused turn so the reasoning framing lines up
 * with the partial we then append. Pure.
 */
export function buildApplyTemplateBody(
  messages: ReadonlyArray<Record<string, unknown>>,
  enableThinking: boolean,
): ApplyTemplateBody {
  return {
    messages,
    add_generation_prompt: true,
    chat_template_kwargs: { enable_thinking: enableThinking },
  };
}

/** The `/completion` request body for a token-exact continuation. */
export interface CompletionBody {
  /** renderedPrompt + the raw partial reply — continuing exactly where it stopped. */
  readonly prompt: string;
  /** Reuse the resident KV (or re-prefill on a longest-common-prefix match). */
  readonly cache_prompt: true;
  readonly stream: true;
  /** -1 = generate until a stop token (the server default cap still applies). */
  readonly n_predict: number;
  readonly temperature?: number;
}

/**
 * Build the `/completion` body that continues the partial. The prompt is the
 * rendered `[system, ...history, user]` (from `/apply-template`) with the raw
 * partial assistant text appended, so the server continues from that exact byte
 * offset over the resident KV. Pure.
 */
export function buildCompletionBody(opts: {
  readonly renderedPrompt: string;
  readonly partialText: string;
  readonly temperature?: number;
  readonly nPredict?: number;
}): CompletionBody {
  return {
    prompt: opts.renderedPrompt + opts.partialText,
    cache_prompt: true,
    stream: true,
    n_predict: opts.nPredict ?? -1,
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
  };
}

/**
 * Re-serialize the frozen partial assistant reply into the RAW string the model
 * had generated, so `/completion` continues from the exact offset it stopped at.
 *
 * llama-server's OpenAI layer SPLITS a reasoning model's output into a
 * `reasoning_content` channel (the `<think>…</think>` span) and a `content`
 * channel (the answer), which the renderer stores as separate thinking/text
 * blocks. At the RAW token level the model emitted `<think>…</think>` inline
 * BEFORE the answer, so a thinking block is re-wrapped in the tags. A thinking
 * block that is the LAST block was still open when the reply was paused (no
 * answer had started), so its `</think>` is left OFF.
 *
 * This is the TEMPLATE-SPECIFIC seam (the qwen/gemma reasoning convention) most
 * likely to need updating as templates change — hence its own pure, tested
 * helper. The common case (thinking off, or a pause during the visible answer)
 * is exact; the whitespace around `</think>` follows the qwen convention. Pure.
 */
export function serializePartialAssistant(blocks: readonly PartialBlock[]): string {
  let out = '';
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block === undefined) continue;
    if (block.type === 'text') {
      out += block.text;
    } else {
      const isLast = i === blocks.length - 1;
      out += isLast ? `<think>\n${block.thinking}` : `<think>\n${block.thinking}\n</think>\n\n`;
    }
  }
  return out;
}

export interface ResumeCompletionOptions {
  /** OpenAI-compat base URL (may end in `/v1`; the raw root is derived from it). */
  readonly baseUrl: string;
  /** The EXACT `[system, ...history, user]` the paused turn was sent (OpenAI shape). */
  readonly messages: ReadonlyArray<Record<string, unknown>>;
  /** The raw partial assistant text already generated (see
   * {@link serializePartialAssistant}). */
  readonly partialText: string;
  /** enable_thinking for the paused turn (matches the template render). */
  readonly enableThinking: boolean;
  readonly temperature?: number;
  /** -1 (default) generates until a stop token. */
  readonly nPredict?: number;
  /** Injected fetch (tests / proxies). Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Aborts both fetches; an abort resolves as `{ aborted: true }`, never throws. */
  readonly signal?: AbortSignal;
  /** Called with each streamed continuation token (the delta text). */
  readonly onToken?: (delta: string) => void;
}

export interface ResumeCompletionResult {
  /** The continuation text (does NOT include the partial that was fed in). */
  readonly text: string;
  /** True when generation ended on a stop token / natural end (not aborted). */
  readonly stopped: boolean;
  /** True when the caller's AbortSignal ended the stream (a clean pause/stop). */
  readonly aborted: boolean;
  /** Prompt tokens the server had to prefill — ~1 ⇒ resident KV (token-exact),
   * large ⇒ re-prefilled. Surfaced for KV-reuse visibility. */
  readonly promptN?: number;
  readonly timings?: ResumeCompletionTimings;
}

/** One streamed `/completion` frame (the fields we read). */
interface CompletionFrame {
  content?: unknown;
  stop?: unknown;
  timings?: ResumeCompletionTimings;
  tokens_evaluated?: unknown;
}

/** True when an error is (or the signal reports) a caller-initiated abort. */
function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted === true) return true;
  return error instanceof Error && (error.name === 'AbortError' || /abort/i.test(error.message));
}

/**
 * Render the exact prompt then stream a token-exact continuation of the partial
 * reply. Resolves with the accumulated continuation (and KV-reuse telemetry). A
 * caller abort resolves cleanly with `aborted:true` (NEVER throws), so a
 * user-initiated pause/stop of the resume surfaces no error.
 */
export async function resumeCompletion(
  opts: ResumeCompletionOptions,
): Promise<ResumeCompletionResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const root = llamaServerRoot(opts.baseUrl);
  const signalInit = opts.signal !== undefined ? { signal: opts.signal } : {};

  let text = '';
  let stopped = false;
  let promptN: number | undefined;
  let timings: ResumeCompletionTimings | undefined;

  // A caller abort at ANY point — either fetch or mid-stream — is a clean
  // pause/stop, not an error: resolve with `aborted:true` and whatever streamed.
  try {
    // 1. Render the EXACT prompt for [system, ...history, user].
    const tmplRes = await doFetch(`${root}/apply-template`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildApplyTemplateBody(opts.messages, opts.enableThinking)),
      ...signalInit,
    });
    if (!tmplRes.ok) {
      throw new Error(`apply-template: server returned ${tmplRes.status} ${tmplRes.statusText}`);
    }
    const rendered = (await tmplRes.json()) as { prompt?: unknown };
    const renderedPrompt = typeof rendered.prompt === 'string' ? rendered.prompt : '';
    if (renderedPrompt.length === 0) throw new Error('apply-template: empty prompt');

    // 2. Continue the reply from the resident KV (raw /completion, cache_prompt).
    const res = await doFetch(`${root}/completion`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(
        buildCompletionBody({
          renderedPrompt,
          partialText: opts.partialText,
          ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
          ...(opts.nPredict !== undefined ? { nPredict: opts.nPredict } : {}),
        }),
      ),
      ...signalInit,
    });
    if (!res.ok || res.body === null) {
      throw new Error(`completion: server returned ${res.status} ${res.statusText}`);
    }

    for await (const payload of parseSSE(res.body as unknown as AsyncIterable<Uint8Array>)) {
      let frame: CompletionFrame;
      try {
        frame = JSON.parse(payload) as CompletionFrame;
      } catch {
        continue; // a malformed frame is skipped, never fatal
      }
      if (typeof frame.content === 'string' && frame.content.length > 0) {
        text += frame.content;
        opts.onToken?.(frame.content);
      }
      if (frame.timings !== undefined) {
        timings = frame.timings;
        if (typeof frame.timings.prompt_n === 'number') promptN = frame.timings.prompt_n;
      }
      if (promptN === undefined && typeof frame.tokens_evaluated === 'number') {
        promptN = frame.tokens_evaluated;
      }
      if (frame.stop === true) stopped = true;
    }
  } catch (error) {
    if (!isAbort(error, opts.signal)) throw error;
    return {
      text,
      stopped,
      aborted: true,
      ...(promptN !== undefined ? { promptN } : {}),
      ...(timings !== undefined ? { timings } : {}),
    };
  }
  return {
    text,
    stopped,
    aborted: false,
    ...(promptN !== undefined ? { promptN } : {}),
    ...(timings !== undefined ? { timings } : {}),
  };
}
