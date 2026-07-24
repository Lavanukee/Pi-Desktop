/**
 * Preemptive model warm-up (jedd: "if possible preemptively prefill the system
 * prompt before the user even sends the first message upon their model
 * selection").
 *
 * The first completion a freshly-loaded llama-server serves pays one-time costs
 * the user shouldn't have to wait through on their first message: Metal kernel
 * compilation, KV-slot allocation, and prefilling the whole (unchanging) system
 * prompt. So the moment a model is selected we fire ONE tiny (1-token) completion
 * carrying just the system prompt down the SAME local endpoint the chat uses
 * (the utility base URL = the local llama-server). That primes the server and
 * seeds its KV cache with the system-prompt prefix, so the real turn-1 prefill
 * reuses it and first-token latency drops toward a warm follow-up's.
 *
 * Fire-and-forget by contract: it NEVER throws and NEVER blocks a turn. If the
 * server isn't up yet (or the request aborts) it simply returns false — the
 * existing turn-1 classify+title piggyback, which shares the same prefix, warms
 * the cache on the first real message regardless. Pure enough to unit-test with an
 * injected {@link CallModel}.
 */
import type { CallModel, CallModelRequest } from './call-model.js';

export interface WarmupOptions {
  readonly signal?: AbortSignal;
  /**
   * Tool defs to include so the warmed prefix matches a REAL turn's. CRITICAL:
   * chat templates render tools at the START of the prompt, so a system-only
   * warm-up reuses NOTHING once the real turn carries tools (measured: cache_n=0,
   * a full cold re-prefill — the "first message takes 4-5s" jedd hit). Passing
   * the initial tool set makes the whole deterministic prefix (system + tools)
   * resident, so the first message only prefills its own few tokens.
   */
  readonly tools?: CallModelRequest['tools'];
}

/**
 * Warm the local model with a 1-token completion of `systemPrompt` (+ `tools`).
 * Returns true if the warm-up call completed, false if it was skipped (empty
 * prompt) or failed (swallowed). Callers should NOT await this on the critical
 * path — fire it and move on.
 */
export async function warmSystemPrompt(
  callModel: CallModel,
  systemPrompt: string,
  opts: WarmupOptions = {},
): Promise<boolean> {
  const sys = systemPrompt.trim();
  if (sys.length === 0) return false;
  try {
    await callModel({
      system: sys,
      // A minimal user turn so the request is well-formed; the SYSTEM (+ tools)
      // prefix is what we want resident in the KV cache (it precedes the message).
      prompt: '.',
      ...(opts.tools !== undefined && opts.tools.length > 0 ? { tools: opts.tools } : {}),
      maxTokens: 1,
      temperature: 0,
      // Never let a reasoning model "think" during a warm-up — we only want the
      // prefill, not a token budget burned on hidden reasoning.
      extraBody: { chat_template_kwargs: { enable_thinking: false } },
      signal: opts.signal,
    });
    return true;
  } catch {
    // Server not ready / aborted / endpoint hiccup — non-fatal by design.
    return false;
  }
}
