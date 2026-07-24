/**
 * PREDICTIVE PREFILL for llama-server — the separated, self-contained llama.cpp
 * adapter (sibling to the resume adapter).
 *
 * As the user composes a message (types, or pastes/drops a large block), the app
 * fires this to prime the server's KV cache with the deterministic prefix the
 * REAL turn will process — `[system][tools][…history][draft]` — BEFORE Enter is
 * pressed. It is exactly the WARM-UP request (`/v1/chat/completions`, one token,
 * `enable_thinking:false`) the harness already uses on model-load, but carrying
 * the in-progress conversation instead of just the system prompt. llama.cpp
 * reuses the longest-common-prefix per slot by default, so when the turn is sent
 * its prompt (identical up to the last few typed tokens) reuses this resident KV
 * and first-token latency collapses toward a warm follow-up's — the win is
 * largest for a big pasted block or attached text file, where the prefill moves
 * seconds of prefill off the send path.
 *
 * Text only by design: images are NOT included. On the pinned llama.cpp build the
 * vision (ViT/mmproj) encode is re-run on every request — it is not cached across
 * requests — so prefilling an image would burn the encode for no send-latency
 * gain (measured). This module deals purely in text messages + tool defs.
 *
 * Deliberately isolated (only global fetch, no pi runtime, no node built-ins) so
 * it is easy to update as llama.cpp's endpoints evolve — same contract as
 * resume-completion.ts. Fire-and-forget by nature: a caller abort (the draft
 * changed, or the turn was sent) resolves cleanly as `{aborted:true}` and NEVER
 * throws.
 */

/** A tool definition in the harness's neutral shape (mapped to OpenAI below). */
export interface PrefillTool {
  readonly name: string;
  readonly description?: string;
  readonly parameters?: unknown;
}

export interface PrefillCompletionOptions {
  /** OpenAI-compat base URL (ends in `/v1`), i.e. the running llama-server. */
  readonly baseUrl: string;
  /** Served model id (llama-server ignores it, but the field is well-formed). */
  readonly model?: string;
  /** `[system, ...history, {role:'user', content: draft}]` — OpenAI-shaped, text
   * only. Byte-identical to what the real turn renders so the KV prefix matches. */
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
  /** True when the caller aborted (draft changed / turn sent) — a clean, expected
   * outcome, not an error. */
  readonly aborted: boolean;
  /** Prompt tokens the server actually prefilled this call (from `usage`). Useful
   * only as telemetry; the reuse that matters happens on the SUBSEQUENT real turn. */
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

/** True when an error is (or the signal reports) a caller-initiated abort. */
function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted === true) return true;
  return error instanceof Error && (error.name === 'AbortError' || /abort/i.test(error.message));
}

/**
 * Fire a one-token, non-thinking completion of `[system, tools, …history, draft]`
 * to prime the slot's KV. Resolves with KV telemetry; a caller abort resolves
 * cleanly (`aborted:true`) so superseding an in-flight prefill (the user kept
 * typing) is never an error. Callers should NOT block the UI on this.
 */
export async function prefillCompletion(
  opts: PrefillCompletionOptions,
): Promise<PrefillCompletionResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, '');
  const signalInit = opts.signal !== undefined ? { signal: opts.signal } : {};
  try {
    const res = await doFetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: opts.model ?? 'utility',
        messages: opts.messages,
        stream: false,
        temperature: 0,
        max_tokens: 1,
        // Never let a reasoning model "think" during a prefill — we only want the
        // prompt resident in the KV, not a token budget spent on hidden reasoning.
        chat_template_kwargs: { enable_thinking: false },
        ...(opts.tools !== undefined && opts.tools.length > 0
          ? { tools: toOpenAiTools(opts.tools) }
          : {}),
      }),
      ...signalInit,
    });
    if (!res.ok) throw new Error(`prefill: server returned ${res.status} ${res.statusText}`);
    const json = (await res.json()) as { usage?: { prompt_tokens?: number } };
    const promptN = json.usage?.prompt_tokens;
    return { aborted: false, ...(typeof promptN === 'number' ? { promptN } : {}) };
  } catch (error) {
    if (isAbort(error, opts.signal)) return { aborted: true };
    throw error;
  }
}
