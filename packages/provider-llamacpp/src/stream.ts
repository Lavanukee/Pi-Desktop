/**
 * llama-server `streamSimple` for pi's `openai-completions` API surface.
 *
 * Owns the RAW llama-server SSE stream *before* pi's built-in parser sees it, so
 * we can (a) extract llama.cpp `timings` → TPS, and (b) run the tool-call repair
 * ladder (rungs 1–2) on malformed function-call JSON before emitting
 * `toolcall_end`. Translates OpenAI-compat chunks into pi's
 * AssistantMessageEventStream exactly per docs/custom-provider.md.
 *
 * Electron-free; `fetchImpl` is injectable so tests feed fixture SSE without a
 * live server.
 */
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  calculateCost,
  createAssistantMessageEventStream,
  type ImageContent,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
  type ToolCall,
} from '@mariozechner/pi-ai';
import {
  cleanProviderError,
  MAX_OVERFLOW_RETRIES,
  parseContextOverflow,
  REPLY_MARGIN_TOKENS,
  trimContextForOverflow,
} from './context-trim.js';
import {
  fuzzyMatchToolName,
  type RepairRung,
  reconstructToolCallFromContent,
  repairToolCallArguments,
  type ToolCallFixer,
  type ToolSchemaLike,
  validateAgainstSchema,
} from './repair.js';
import { parseSSE } from './sse.js';

/** llama.cpp per-response `timings` block (structurally == inference's). */
export interface LlamaCppTimings {
  readonly prompt_n?: number;
  readonly prompt_ms?: number;
  readonly prompt_per_second?: number;
  readonly predicted_n?: number;
  readonly predicted_ms?: number;
  readonly predicted_per_second?: number;
}

/**
 * llama-server prompt-processing progress frame, emitted on the streaming SSE
 * during PREFILL (before the first token) when the request opts in with
 * `return_progress: true`. Confirmed present in the b9934 server binary
 * (`prompt_progress` / "Include prompt processing progress events in stream
 * mode"). `processed`/`total` are prompt tokens; `cache` is the reused prefix.
 */
export interface LlamaPromptProgress {
  readonly total?: number;
  readonly cache?: number;
  readonly processed?: number;
  readonly time_ms?: number;
}

/** Normalized prefill progress the {@link LlamaCppStreamDeps.onPromptProgress}
 * seam reports. `fraction` is processed/total clamped to 0..1 (0 when the total
 * is not yet known), so the host can render "Processing N%". */
export interface PromptProgress {
  readonly processed: number;
  readonly total: number;
  readonly fraction: number;
}

/** processed/total → a clamped 0..1 fraction (0 when total is unknown/0). Pure. */
export function promptProgressFraction(p: LlamaPromptProgress): number {
  // llama-server's `prompt_progress` reports total / cache / processed, where
  // `processed` runs from `cache` up to `total`. The honest "how much of the work
  // that ACTUALLY has to happen is done" is the timed fraction (processed − cache)
  // / (total − cache) — the cached prefix is instant, so counting it would make a
  // mostly-cached follow-up jump to ~100% immediately. A fully-cached prompt
  // (nothing left to prefill) is done → 1.
  const total = p.total ?? 0;
  if (total <= 0) return 0; // total unknown / not reported yet → 0 (no divide-by-zero)
  const cache = p.cache ?? 0;
  const processed = p.processed ?? 0;
  const remaining = total - cache;
  if (remaining <= 0) return 1; // fully cached → nothing to prefill → done
  return Math.min(1, Math.max(0, (processed - cache) / remaining));
}

export interface LlamaCppStreamDeps {
  /** Injectable fetch (tests / proxies). Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Rung-2 fixer-model call (optional; injected by W5 harness in prod). */
  readonly fixer?: ToolCallFixer;
  /** W5 rungs 3–5. */
  readonly extraRungs?: readonly RepairRung[];
  /** Called with the final `timings` block — bridge to the supervisor's TPS. */
  readonly onTimings?: (t: LlamaCppTimings) => void;
  /**
   * Called for each prefill progress frame (`prompt_progress`) the server emits
   * before the first token — the seam a host lane forwards to the UI's
   * "Processing N%" indicator. Like {@link onTimings}, the provider only
   * OBSERVES it here (it runs inside pi); surfacing it to the renderer is the
   * host's job. Fires only when the request opts in via `return_progress`.
   */
  readonly onPromptProgress?: (p: PromptProgress) => void;
  /** Called when a tool call needed repair (observability / W5 seam). */
  readonly onRepair?: (info: { toolName: string; rung: number | undefined; ok: boolean }) => void;
  /**
   * Live repair wiring resolved at stream time (the harness pushes this via the
   * `pi.events` repair bridge). When present, its `fixer`/`extraRungs`/`onRepair`
   * take precedence over the static ones above, so effort-slider changes and the
   * harness's rungs 3–5 take effect without re-registering the provider. Absent
   * (or returning undefined) → the static deps are used.
   */
  readonly repairProvider?: () =>
    | {
        fixer?: ToolCallFixer;
        extraRungs?: readonly RepairRung[];
        onRepair?: (info: { toolName: string; rung: number | undefined; ok: boolean }) => void;
        /**
         * Per-session RELAXED schema lookup (rung-4 relaxation). When the harness
         * has relaxed a tool's schema this session, it returns the looser schema
         * here; the stream validates that tool's args against it instead of the
         * strict `context.tools` schema, so subsequent calls pass at rung 2 rather
         * than re-escalating. Absent / undefined → the strict schema is used.
         */
        relaxedSchemaFor?: (toolName: string) => ToolSchemaLike | undefined;
        /** Prefill fraction (0..1) sink — the harness publishes it on the live
         * turn's status channel (harness-prefill) for the desktop ring, which the
         * static provider deps can't reach (no per-turn ctx here). */
        onPromptProgress?: (fraction: number) => void;
      }
    | undefined;
}

/** streamSimple signature required by pi's ProviderConfig. */
export type LlamaCppStreamFn = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

// --- request building ------------------------------------------------------

interface OAIMessage {
  role: string;
  content?: string | Array<Record<string, unknown>> | null;
  /**
   * Prior-turn <think> trace, fed back so llama-server's `--reasoning-preserve`
   * can re-render it into the prompt (templates with `supports_preserve_reasoning`).
   * Ignored by templates without support, so it's always safe to send.
   */
  reasoning_content?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

function contentToOAI(
  content: string | (TextContent | ImageContent)[],
): string | Array<Record<string, unknown>> {
  if (typeof content === 'string') return content;
  return content.map((part) =>
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : { type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${part.data}` } },
  );
}

/**
 * Whether a pi request context carries any image input — the provider-layer
 * "vision needed" detector. Mirrors the composer's `messageNeedsVision` but
 * reads the ACTUAL pi {@link Context}, so it also catches images that arrive via
 * non-composer paths (browser / computer-use screenshots, folded attachments).
 *
 * Pure. The lazy-mmproj policy uses this signal: a caller that can reach the
 * supervisor transitions the llama-server into an `--mmproj` launch BEFORE a
 * vision turn is dispatched, while a pure-text context returns `false` — so a
 * text-only session never triggers a projector load.
 */
export function contextHasImage(context: Context): boolean {
  for (const msg of context.messages) {
    if (msg.role !== 'user') continue;
    const content = msg.content;
    if (typeof content === 'string') continue;
    if (content.some((part) => part.type === 'image')) return true;
  }
  return false;
}

/** Build the OpenAI chat/completions request body from pi's Context. Pure. */
export function buildChatCompletionsRequest(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): Record<string, unknown> {
  const messages: OAIMessage[] = [];
  if (context.systemPrompt !== undefined && context.systemPrompt.length > 0) {
    messages.push({ role: 'system', content: context.systemPrompt });
  }
  for (const msg of context.messages) {
    if (msg.role === 'user') {
      messages.push({ role: 'user', content: contentToOAI(msg.content) });
    } else if (msg.role === 'assistant') {
      const text = msg.content
        .filter((c): c is TextContent => c.type === 'text')
        .map((c) => c.text)
        .join('');
      const toolCalls = msg.content.filter((c): c is ToolCall => c.type === 'toolCall');
      // Carry this turn's reasoning back so `--reasoning-preserve` (server) can
      // re-render it into the prompt. Without this the flag has nothing to
      // preserve — llama-server is stateless per request and only sees history
      // we send. No-op for templates that don't support preserved reasoning.
      const reasoning = msg.content
        .filter((c) => c.type === 'thinking')
        .map((c) => (c as { thinking?: string }).thinking ?? '')
        .join('');
      const out: OAIMessage = { role: 'assistant', content: text.length > 0 ? text : null };
      if (reasoning.length > 0) out.reasoning_content = reasoning;
      if (toolCalls.length > 0) {
        out.tool_calls = toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        }));
      }
      messages.push(out);
    } else {
      const text = msg.content
        .filter((c): c is TextContent => c.type === 'text')
        .map((c) => c.text)
        .join('');
      messages.push({
        role: 'tool',
        tool_call_id: msg.toolCallId,
        name: msg.toolName,
        content: text,
      });
    }
  }

  const body: Record<string, unknown> = {
    model: model.id,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    // Opt in to llama-server's prefill progress frames (`prompt_progress`) so the
    // UI can show "Processing N%" while a big prompt is still being ingested,
    // before the first token. Ignored by servers that don't support it.
    return_progress: true,
  };
  if (context.tools !== undefined && context.tools.length > 0) {
    body.tools = context.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
  if (options?.temperature !== undefined) body.temperature = options.temperature;
  if (options?.maxTokens !== undefined) body.max_tokens = options.maxTokens;
  return body;
}

// --- streaming -------------------------------------------------------------

interface OAIToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}
interface OAIDelta {
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: OAIToolCallDelta[];
}
interface OAIChoice {
  delta?: OAIDelta;
  finish_reason?: string | null;
}
interface OAIChunk {
  choices?: OAIChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  timings?: LlamaCppTimings;
  /** Prefill progress (present on `return_progress` prefill frames, which carry
   * an empty `choices` array — handled before the per-choice delta logic). */
  prompt_progress?: LlamaPromptProgress;
}

interface ToolState {
  contentIndex: number;
  id: string;
  name: string;
  argStr: string;
}

function mapFinishReason(reason: string | null | undefined): 'stop' | 'length' | 'toolUse' {
  if (reason === 'length') return 'length';
  if (reason === 'tool_calls' || reason === 'function_call') return 'toolUse';
  return 'stop';
}

async function readBody(res: Response): Promise<AsyncIterable<Uint8Array>> {
  if (res.body === null) throw new Error('llama-server returned no response body');
  return res.body as unknown as AsyncIterable<Uint8Array>;
}

/** Flatten a `Headers` object to a plain record for pi's `onResponse` hook. Best-
 * effort: a mock/non-standard headers object degrades to an empty record. */
function headersToRecord(headers: Headers | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers === undefined || typeof headers.forEach !== 'function') return out;
  try {
    headers.forEach((value, key) => {
      out[key] = value;
    });
  } catch {
    // non-standard headers object — best-effort empty record
  }
  return out;
}

/**
 * Create the streamSimple function for a llama-server provider.
 * `deps.fixer` / `deps.onTimings` are the seams W5 and the supervisor wire.
 */
export function createLlamaCppStream(deps: LlamaCppStreamDeps = {}): LlamaCppStreamFn {
  const doFetch = deps.fetchImpl ?? fetch;

  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();

    const output: AssistantMessage = {
      role: 'assistant',
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: Date.now(),
    };

    void (async () => {
      let textIndex: number | undefined;
      let thinkingIndex: number | undefined;
      const toolStates = new Map<number, ToolState>();
      let lastTimings: LlamaCppTimings | undefined;
      let finishReason: 'stop' | 'length' | 'toolUse' = 'stop';

      // Resolve the live harness repair wiring once for this stream (fixer, rungs
      // 3–5, telemetry, per-session relaxed schemas). Falls back to static deps.
      const live = deps.repairProvider?.();
      const registeredNames = context.tools?.map((t) => t.name) ?? [];

      const schemaFor = (name: string): ToolSchemaLike | undefined => {
        // A per-session RELAXED schema (rung-4) wins over the strict one so a tool
        // the harness relaxed this session validates cleanly on subsequent calls.
        const relaxed = live?.relaxedSchemaFor?.(name);
        if (relaxed !== undefined) return relaxed;
        const tool = context.tools?.find((t) => t.name === name);
        return tool?.parameters as ToolSchemaLike | undefined;
      };

      try {
        stream.push({ type: 'start', partial: output });

        // Build the request body, then give the host a chance to inspect/replace it
        // via pi's `onPayload` (the `before_provider_request` hook) — the SAME seam
        // the built-in providers honor. The corp coordination harness relies on this
        // to (a) merge its owner-tuned qwen sampling (temperature/top_p/top_k/min_p/
        // penalties + max_tokens) onto the outgoing body and (b) ARM its per-call
        // hang watchdog. `onPayload` returns the (possibly new) payload, or a value
        // we ignore unless it is a fresh object; absent (normal chat) → unchanged.
        // Context-overflow recovery loop. llama-server rejects a prompt bigger
        // than its `n_ctx` with HTTP 400 `exceed_context_size_error`. Instead of
        // throwing that raw blob into the chat (or letting pi's compaction hard-
        // fail), we TRIM the oldest/largest tool results out of the request and
        // retry — re-reading the fresh token counts the server reports on each
        // pass — until the prompt fits or nothing is left to trim. This keeps the
        // turn going transparently; pi never sees the overflow. See context-trim.ts.
        let sendContext = context;
        let res: Response;
        for (let attempt = 0; ; attempt++) {
          let body = buildChatCompletionsRequest(model, sendContext, options);
          const replaced = await options?.onPayload?.(body, model);
          if (replaced !== null && typeof replaced === 'object') {
            body = replaced as Record<string, unknown>;
          }
          res = await doFetch(`${model.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(model.headers ?? {}) },
            body: JSON.stringify(body),
            signal: options?.signal,
          });
          // A response arrived (headers received, before the body is consumed) → notify
          // the host via pi's `onResponse` (`after_provider_response`), mirroring the
          // built-in openai-completions handler. The corp uses this to DISARM its
          // per-call watchdog: the server responded, so this request is not a hung
          // socket and the (legitimately long) stream may run unbounded. No-op in
          // normal chat (no handler). Fired on ANY status so an error response also
          // clears the watchdog rather than tripping it. Re-fired on each retry so a
          // recovered request re-arms/re-disarms the watchdog like a fresh call.
          await options?.onResponse?.(
            { status: res.status, headers: headersToRecord(res.headers) },
            model,
          );
          if (res.ok) break;

          const detail = await res.text().catch(() => '');
          const overflow = parseContextOverflow(detail);
          if (overflow !== undefined && attempt < MAX_OVERFLOW_RETRIES) {
            // Free the overshoot plus a reply margin, shedding stale tool results.
            const target = overflow.nPromptTokens - overflow.nCtx + REPLY_MARGIN_TOKENS;
            const trim = trimContextForOverflow(sendContext, target);
            if (trim.trimmedCount > 0) {
              sendContext = trim.context;
              // eslint-disable-next-line no-console
              console.log(
                `[pi-ctx] overflow ${overflow.nPromptTokens}/${overflow.nCtx} tok — trimmed ~${trim.removedTokens} tok from ${trim.trimmedCount} tool result(s), retrying (attempt ${attempt + 1}/${MAX_OVERFLOW_RETRIES})`,
              );
              continue;
            }
          }
          // Unrecoverable: a non-overflow error, retries exhausted, or nothing
          // left to trim (pathological). Surface a CLEAN short message — never the
          // raw HTTP/JSON blob (log the detail for debugging only).
          if (detail.length > 0) {
            // eslint-disable-next-line no-console
            console.error(`[pi-ctx] llama-server HTTP ${res.status}: ${detail.slice(0, 500)}`);
          }
          throw new Error(cleanProviderError(res.status, overflow));
        }

        // KV-reuse visibility (jedd): log ONCE per turn from the first prefill
        // frame — the whole context length, how much of it the server reused from
        // the KV cache (the stable prefix), and how many NEW tokens it had to
        // prefill (the latest message). A big `reused` + small `new` on a
        // follow-up means the cache is working and we're not re-prefilling.
        let kvLogged = false;
        for await (const payload of parseSSE(await readBody(res))) {
          let chunk: OAIChunk;
          try {
            chunk = JSON.parse(payload) as OAIChunk;
          } catch {
            continue; // skip non-JSON keep-alives
          }
          if (chunk.timings !== undefined) lastTimings = chunk.timings;
          if (chunk.usage != null) {
            output.usage.input = chunk.usage.prompt_tokens ?? output.usage.input;
            output.usage.output = chunk.usage.completion_tokens ?? output.usage.output;
          }

          // Prefill progress: emitted during prompt ingestion (before the first
          // token), typically on a frame with an empty `choices` array. Observe
          // it here — ahead of the per-choice delta logic below, which `continue`s
          // past choice-less frames — and hand it to the host's "Processing N%"
          // seam.
          if (chunk.prompt_progress !== undefined) {
            const pp = chunk.prompt_progress;
            if (!kvLogged && (pp.total ?? 0) > 0) {
              kvLogged = true;
              const total = pp.total ?? 0;
              const reused = pp.cache ?? 0;
              const pctReused = total > 0 ? Math.round((reused / total) * 100) : 0;
              // Fingerprint the cached PREFIX so a churn is visible: the tool count
              // + system-prompt length are what the chat template renders BEFORE the
              // messages. A follow-up with the SAME fingerprint but LOW reuse means
              // the prefix moved for another reason; a CHANGED fingerprint (tools/
              // sys grew or shrank) is the churn itself. Healthy follow-up = high
              // reuse% + unchanged fingerprint (jedd: "view actual context changes").
              const nTools = context.tools?.length ?? 0;
              const sysLen = context.systemPrompt?.length ?? 0;
              // eslint-disable-next-line no-console
              console.log(
                `[pi-kv] context=${total} tok · reused=${reused} (${pctReused}%) · new=${Math.max(0, total - reused)} · prefix{tools=${nTools} sys=${sysLen}ch}`,
              );
            }
            const fraction = promptProgressFraction(pp);
            deps.onPromptProgress?.({
              processed: pp.processed ?? 0,
              total: pp.total ?? 0,
              fraction,
            });
            // The LIVE (harness-provided) sink — the harness has the per-turn ctx
            // to publish `harness-prefill` for the desktop ring, which the static
            // provider deps can't reach. Best-effort; absent off-harness.
            deps.repairProvider?.()?.onPromptProgress?.(fraction);
          }

          const choice = chunk.choices?.[0];
          if (choice === undefined) continue;
          const delta = choice.delta;

          if (delta?.reasoning_content != null && delta.reasoning_content.length > 0) {
            if (thinkingIndex === undefined) {
              output.content.push({ type: 'thinking', thinking: '' });
              thinkingIndex = output.content.length - 1;
              stream.push({ type: 'thinking_start', contentIndex: thinkingIndex, partial: output });
            }
            const block = output.content[thinkingIndex];
            if (block?.type === 'thinking') block.thinking += delta.reasoning_content;
            stream.push({
              type: 'thinking_delta',
              contentIndex: thinkingIndex,
              delta: delta.reasoning_content,
              partial: output,
            });
          }

          if (delta?.content != null && delta.content.length > 0) {
            if (textIndex === undefined) {
              output.content.push({ type: 'text', text: '' });
              textIndex = output.content.length - 1;
              stream.push({ type: 'text_start', contentIndex: textIndex, partial: output });
            }
            const block = output.content[textIndex];
            if (block?.type === 'text') block.text += delta.content;
            stream.push({
              type: 'text_delta',
              contentIndex: textIndex,
              delta: delta.content,
              partial: output,
            });
          }

          for (const tc of delta?.tool_calls ?? []) {
            const key = tc.index ?? toolStates.size;
            let state = toolStates.get(key);
            if (state === undefined) {
              const block: ToolCall = {
                type: 'toolCall',
                id: tc.id ?? `call_${key}`,
                name: tc.function?.name ?? '',
                arguments: {},
              };
              output.content.push(block);
              state = {
                contentIndex: output.content.length - 1,
                id: block.id,
                name: block.name,
                argStr: '',
              };
              toolStates.set(key, state);
              stream.push({
                type: 'toolcall_start',
                contentIndex: state.contentIndex,
                partial: output,
              });
            }
            if (tc.function?.name !== undefined && state.name.length === 0) {
              state.name = tc.function.name;
              const block = output.content[state.contentIndex];
              if (block?.type === 'toolCall') block.name = state.name;
            }
            const argDelta = tc.function?.arguments;
            if (argDelta !== undefined && argDelta.length > 0) {
              state.argStr += argDelta;
              const block = output.content[state.contentIndex];
              if (block?.type === 'toolCall') {
                try {
                  block.arguments = JSON.parse(state.argStr) as Record<string, unknown>;
                } catch {
                  // partial JSON; finalized at toolcall_end
                }
              }
              stream.push({
                type: 'toolcall_delta',
                contentIndex: state.contentIndex,
                delta: argDelta,
                partial: output,
              });
            }
          }

          if (choice.finish_reason != null) finishReason = mapFinishReason(choice.finish_reason);
        }

        // --- finalize blocks ------------------------------------------------
        if (thinkingIndex !== undefined) {
          const block = output.content[thinkingIndex];
          stream.push({
            type: 'thinking_end',
            contentIndex: thinkingIndex,
            content: block?.type === 'thinking' ? block.thinking : '',
            partial: output,
          });
        }
        if (textIndex !== undefined) {
          const block = output.content[textIndex];
          stream.push({
            type: 'text_end',
            contentIndex: textIndex,
            content: block?.type === 'text' ? block.text : '',
            partial: output,
          });
        }

        // --- RUNG 0: reconstruct a tool call written into the CONTENT ---------
        // If the model emitted NO structured tool_calls frame but wrote a call as
        // prose/markdown (a fenced JSON envelope, an XML/paren call, or "… call
        // web_search with {…}"), reconstruct it into the SAME structured path the
        // ladder consumes. Pure heuristics — guarded to a registered tool name +
        // parseable args (see reconstructToolCallFromContent) so it never fires on
        // prose that merely mentions a tool. The synthesized state then flows
        // through the arg loop below (validate → fixer → rungs 3–5) unchanged.
        if (toolStates.size === 0 && registeredNames.length > 0 && textIndex !== undefined) {
          const textBlock = output.content[textIndex];
          const assistantText = textBlock?.type === 'text' ? textBlock.text : '';
          const reconstructed = reconstructToolCallFromContent(assistantText, registeredNames);
          if (reconstructed !== undefined) {
            const block: ToolCall = {
              type: 'toolCall',
              id: `call_rung0_${output.content.length}`,
              name: reconstructed.toolName,
              arguments: {},
            };
            output.content.push(block);
            const contentIndex = output.content.length - 1;
            toolStates.set(toolStates.size, {
              contentIndex,
              id: block.id,
              name: reconstructed.toolName,
              argStr: reconstructed.argsText,
            });
            stream.push({ type: 'toolcall_start', contentIndex, partial: output });
            // Record the pre-ladder structural repair (rung 0).
            (live?.onRepair ?? deps.onRepair)?.({
              toolName: reconstructed.toolName,
              rung: 0,
              ok: true,
            });
          }
        }

        for (const state of toolStates.values()) {
          const block = output.content[state.contentIndex];
          if (block?.type !== 'toolCall') continue;

          // Fuzzy tool-name correction: an unknown/misspelled structured tool name
          // maps to the nearest REGISTERED tool above the confidence threshold, so
          // the correct schema resolves and the call executes; below the threshold
          // the name is left for pi's existing "tool not found" path.
          if (
            state.name.length > 0 &&
            registeredNames.length > 0 &&
            !registeredNames.includes(state.name)
          ) {
            const match = fuzzyMatchToolName(state.name, registeredNames);
            if (match !== undefined) {
              state.name = match.name;
              block.name = match.name;
              (live?.onRepair ?? deps.onRepair)?.({ toolName: match.name, rung: 0, ok: true });
            }
          }

          const schema = schemaFor(state.name);

          // Parse first; a parse failure OR a syntactically-valid but
          // SCHEMA-invalid call both enter the repair ladder (rung 1 normalize →
          // rung 2 fixer → rungs 3–5). A schema-clean parse skips repair entirely.
          let parsed: Record<string, unknown> | undefined;
          let parseOk = true;
          try {
            parsed =
              state.argStr.length > 0 ? (JSON.parse(state.argStr) as Record<string, unknown>) : {};
          } catch {
            parseOk = false;
          }
          const schemaInvalid =
            parseOk && parsed !== undefined && schema !== undefined
              ? !validateAgainstSchema(parsed, schema).valid
              : false;

          let finalArgs: Record<string, unknown>;
          if (!parseOk || schemaInvalid) {
            // Use the live harness wiring (fixer + rungs 3–5 + telemetry) resolved
            // once at stream start, falling back to any static deps.
            const result = await repairToolCallArguments(state.argStr, {
              toolName: state.name,
              schema,
              fixer: live?.fixer ?? deps.fixer,
              extraRungs: live?.extraRungs ?? deps.extraRungs,
            });
            (live?.onRepair ?? deps.onRepair)?.({
              toolName: state.name,
              rung: result.rung,
              ok: result.ok,
            });
            finalArgs = result.value ?? parsed ?? {};
          } else {
            finalArgs = parsed ?? {};
          }
          block.arguments = finalArgs;
          if (finishReason === 'stop') finishReason = 'toolUse';
          stream.push({
            type: 'toolcall_end',
            contentIndex: state.contentIndex,
            toolCall: { type: 'toolCall', id: state.id, name: state.name, arguments: finalArgs },
            partial: output,
          });
        }

        output.usage.totalTokens = output.usage.input + output.usage.output;
        calculateCost(model, output.usage);
        if (lastTimings !== undefined) deps.onTimings?.(lastTimings);

        output.stopReason = finishReason;
        stream.push({ type: 'done', reason: finishReason, message: output });
        stream.end();
      } catch (error) {
        const aborted = options?.signal?.aborted === true;
        output.stopReason = aborted ? 'aborted' : 'error';
        output.errorMessage = error instanceof Error ? error.message : String(error);
        stream.push({ type: 'error', reason: output.stopReason, error: output });
        stream.end();
      }
    })();

    return stream;
  };
}
