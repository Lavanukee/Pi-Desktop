/**
 * ATTACHMENT PREFILL for llama-server — the separated, self-contained llama.cpp
 * adapter (sibling to the resume adapter).
 *
 * When the user attaches a large block to the message they're composing (a big
 * paste, a dropped text file), that block sits at the FIXED START of the next
 * user message and is known the moment it's attached — there is nothing to
 * "predict". This primes the model's KV with exactly that prefix
 * (`[system][tools][…history][user: attachment]`) BEFORE the turn is sent, so when
 * it IS sent the prompt reuses the resident KV and only prefills the short typed
 * tail — collapsing send TTFT from seconds to ~instant on a multi-thousand-token
 * paste (MEASURED: a ~5k-token attachment's send 3747ms → ~290ms, and it holds
 * across a multi-second idle while the user finishes typing).
 *
 * ## Why /apply-template + raw /completion (not /chat/completions)
 * The attachment and the typed tail live in the SAME user message. Priming the
 * attachment via /chat/completions would CLOSE that message after it (append the
 * turn-end token), so the primed prompt would DIVERGE from the real turn at the
 * close — the real turn's message continues past the attachment with the tail.
 * That divergence forces the server to fall back to a coarse context checkpoint
 * and re-prefill the tail region (MEASURED: only partial reuse). Instead we render
 * the exact prompt with /apply-template, TRUNCATE it right after the attachment
 * (dropping the message close), and prime that raw string over /completion with
 * `cache_prompt` — a TRUE prefix of the real turn's rendered prompt, so the turn's
 * longest-common-prefix match is the whole thing. This is the same raw-/completion
 * KV-reuse mechanic the resume adapter uses (there for a partial assistant reply;
 * here for a partial user message).
 *
 * `enable_thinking` on the render is irrelevant to the prefix: it only affects the
 * assistant generation framing, which is AFTER the truncation point — so a turn
 * with thinking ON still reuses a prefix rendered with it off (MEASURED).
 *
 * Text only by design: images are NOT primed. On the pinned llama.cpp build the
 * vision (ViT/mmproj) encode re-runs on every request — it is not cached across
 * requests — so priming an image buys no send-latency (MEASURED). Deliberately
 * isolated (only global fetch, no pi runtime, no node built-ins) so it is easy to
 * update as llama.cpp's endpoints evolve. Fire-and-forget: a caller abort (the
 * attachment changed, or the turn was sent) resolves cleanly `{aborted:true}` and
 * NEVER throws.
 */

/** A tool definition in the harness's neutral shape (mapped to OpenAI below). */
export interface PrefillTool {
  readonly name: string;
  readonly description?: string;
  readonly parameters?: unknown;
}

export interface PrefillCompletionOptions {
  /** OpenAI-compat base URL (may end in `/v1`; the raw root is derived from it). */
  readonly baseUrl: string;
  /** `[system, ...history, {role:'user', content: <fixed attachment prefix>}]`,
   * OpenAI-shaped, text only. The LAST message's content is the fixed prefix the
   * render is truncated to (the real turn's user message begins with it). */
  readonly messages: ReadonlyArray<Record<string, unknown>>;
  /** The turn's tools, in the SAME order the turn renders them (chat templates
   * emit tools positionally, so order is part of the prefix identity). */
  readonly tools?: readonly PrefillTool[];
  /** Injected fetch (tests). Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Aborts the request; an abort resolves `{aborted:true}` and never throws. */
  readonly signal?: AbortSignal;
}

export interface PrefillCompletionResult {
  /** True when the caller aborted (attachment changed / turn sent) — a clean,
   * expected outcome, not an error. */
  readonly aborted: boolean;
  /** Prompt tokens the server actually prefilled this call (`/completion`
   * `tokens_evaluated`). Telemetry only; the reuse that matters is the later turn. */
  readonly promptN?: number;
}

/** Map the neutral tool shape to OpenAI `{type:'function',function:{…}}` — the
 * SAME mapping the harness callModel/warm-up uses, so the rendered prefix matches. */
function toOpenAiTools(tools: readonly PrefillTool[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/**
 * Strip a trailing `/v1` (and any trailing slashes) to reach the RAW server root
 * that hosts `/apply-template` and `/completion`. Pure.
 */
function llamaServerRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
}

/**
 * Truncate the rendered prompt to END right after the fixed prefix — the last
 * message's verbatim content — so the primed KV is a true prefix of the real
 * turn's prompt (the message close + assistant framing are dropped). If the
 * marker can't be located (a template that transforms content), fall back to the
 * full render: still primes system+tools+history+the-closed-message, which the
 * turn reuses up to a checkpoint — worse, but never wrong. Pure.
 */
export function truncateToPrefix(
  rendered: string,
  messages: ReadonlyArray<Record<string, unknown>>,
): string {
  const last = messages[messages.length - 1];
  const marker = typeof last?.content === 'string' ? last.content : '';
  if (marker.length === 0) return rendered;
  const idx = rendered.lastIndexOf(marker);
  return idx >= 0 ? rendered.slice(0, idx + marker.length) : rendered;
}

/** True when an error is (or the signal reports) a caller-initiated abort. */
function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted === true) return true;
  return error instanceof Error && (error.name === 'AbortError' || /abort/i.test(error.message));
}

/**
 * Render `[system, tools, …history, {user: attachment}]`, truncate to the raw
 * attachment prefix, and prime it into the slot's KV over `/completion`
 * (`cache_prompt`, one token). Resolves with KV telemetry; a caller abort resolves
 * cleanly (`aborted:true`). Callers should NOT block the UI on this.
 */
export async function prefillCompletion(
  opts: PrefillCompletionOptions,
): Promise<PrefillCompletionResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const root = llamaServerRoot(opts.baseUrl);
  const signalInit = opts.signal !== undefined ? { signal: opts.signal } : {};
  try {
    // 1. Render the EXACT prompt for [system, tools, ...history, {user: attachment}].
    const tmplRes = await doFetch(`${root}/apply-template`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: opts.messages,
        // No generation prompt: we prime up to (and truncate within) the user
        // message; the assistant framing belongs to the real turn.
        add_generation_prompt: false,
        chat_template_kwargs: { enable_thinking: false },
        ...(opts.tools !== undefined && opts.tools.length > 0
          ? { tools: toOpenAiTools(opts.tools) }
          : {}),
      }),
      ...signalInit,
    });
    if (!tmplRes.ok) throw new Error(`prefill apply-template: server returned ${tmplRes.status}`);
    const rendered = (await tmplRes.json()) as { prompt?: unknown };
    if (typeof rendered.prompt !== 'string' || rendered.prompt.length === 0) {
      throw new Error('prefill: empty apply-template prompt');
    }
    const rawPrefix = truncateToPrefix(rendered.prompt, opts.messages);

    // 2. Prime the raw prefix into the slot's KV (one token, discarded).
    const compRes = await doFetch(`${root}/completion`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: rawPrefix, cache_prompt: true, stream: false, n_predict: 1 }),
      ...signalInit,
    });
    if (!compRes.ok) throw new Error(`prefill completion: server returned ${compRes.status}`);
    const j = (await compRes.json()) as { tokens_evaluated?: number };
    return {
      aborted: false,
      ...(typeof j.tokens_evaluated === 'number' ? { promptN: j.tokens_evaluated } : {}),
    };
  } catch (error) {
    if (isAbort(error, opts.signal)) return { aborted: true };
    throw error;
  }
}
