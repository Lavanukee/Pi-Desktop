/**
 * MLX `mlx_lm.server` `streamSimple` for pi.
 *
 * `mlx_lm.server` speaks the SAME OpenAI `/v1/chat/completions` SSE shape
 * @pi-desktop/provider-llamacpp already parses, so this REUSES that package's
 * pure pieces verbatim — the request builder (`buildChatCompletionsRequest`),
 * the SSE line parser (`parseSSE`), and the tool-call repair ladder
 * (`repairToolCallArguments` + `validateAgainstSchema`, rungs 1–2 + the harness's
 * rungs 3–5 via `extraRungs`). The repair ladder matters MORE here: MLX's
 * per-model-family tool-call parsing is weaker than llama.cpp's (e.g. Gemma4
 * leaks calls as raw text — mlx-lm #1096), so a malformed `tool_calls` is more
 * likely and the ladder is the safety net.
 *
 * The ONE real difference from the llamacpp stream: MLX emits **no `timings`
 * block**, so throughput is timed CLIENT-side — first-token wall clock →
 * stream-end over `usage.completion_tokens` — and reported via `onTps`.
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
  type Model,
  type SimpleStreamOptions,
  type ToolCall,
} from '@mariozechner/pi-ai';
import {
  buildChatCompletionsRequest,
  parseSSE,
  type RepairRung,
  repairToolCallArguments,
  type ToolCallFixer,
  type ToolSchemaLike,
  validateAgainstSchema,
} from '@pi-desktop/provider-llamacpp';

export interface MlxStreamDeps {
  /** Injectable fetch (tests / proxies). Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Rung-2 fixer-model call (optional; injected by the harness in prod). */
  readonly fixer?: ToolCallFixer;
  /** The harness's rungs 3–5. */
  readonly extraRungs?: readonly RepairRung[];
  /**
   * Called with CLIENT-side tokens/sec at stream end (MLX emits no `timings`, so
   * this is the only throughput signal). `tokens` = completion tokens; `ms` =
   * first-token → stream-end wall clock.
   */
  readonly onTps?: (info: { tps: number; tokens: number; ms: number }) => void;
  /** Called when a tool call needed repair (observability). */
  readonly onRepair?: (info: { toolName: string; rung: number | undefined; ok: boolean }) => void;
  /**
   * Live repair wiring resolved at stream time (the harness pushes this via the
   * `pi.events` repair bridge). Takes precedence over the static deps above, so
   * effort-slider changes + rungs 3–5 take effect without re-registering.
   */
  readonly repairProvider?: () =>
    | {
        fixer?: ToolCallFixer;
        extraRungs?: readonly RepairRung[];
        onRepair?: (info: { toolName: string; rung: number | undefined; ok: boolean }) => void;
      }
    | undefined;
}

/** streamSimple signature required by pi's ProviderConfig. */
export type MlxStreamFn = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

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
  if (res.body === null) throw new Error('mlx_lm.server returned no response body');
  return res.body as unknown as AsyncIterable<Uint8Array>;
}

/**
 * Create the streamSimple function for an `mlx_lm.server` provider. Mirrors the
 * llamacpp stream's delta→AssistantMessageEventStream translation + repair, but
 * times TPS on the client (MLX sends no `timings`).
 */
export function createMlxStream(deps: MlxStreamDeps = {}): MlxStreamFn {
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
      let finishReason: 'stop' | 'length' | 'toolUse' = 'stop';
      // Client-side TPS timing: first content byte → stream end.
      let firstTokenAt: number | undefined;

      const schemaFor = (name: string): ToolSchemaLike | undefined => {
        const tool = context.tools?.find((t) => t.name === name);
        return tool?.parameters as ToolSchemaLike | undefined;
      };

      try {
        stream.push({ type: 'start', partial: output });

        const body = buildChatCompletionsRequest(model, context, options);
        const res = await doFetch(`${model.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(model.headers ?? {}) },
          body: JSON.stringify(body),
          signal: options?.signal,
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          throw new Error(`mlx_lm.server HTTP ${res.status}: ${detail.slice(0, 500)}`);
        }

        for await (const payload of parseSSE(await readBody(res))) {
          let chunk: OAIChunk;
          try {
            chunk = JSON.parse(payload) as OAIChunk;
          } catch {
            continue; // skip non-JSON keep-alives
          }
          if (chunk.usage != null) {
            output.usage.input = chunk.usage.prompt_tokens ?? output.usage.input;
            output.usage.output = chunk.usage.completion_tokens ?? output.usage.output;
          }

          const choice = chunk.choices?.[0];
          if (choice === undefined) continue;
          const delta = choice.delta;

          if (delta?.reasoning_content != null && delta.reasoning_content.length > 0) {
            if (firstTokenAt === undefined) firstTokenAt = Date.now();
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
            if (firstTokenAt === undefined) firstTokenAt = Date.now();
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
            if (firstTokenAt === undefined) firstTokenAt = Date.now();
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

        for (const state of toolStates.values()) {
          const block = output.content[state.contentIndex];
          if (block?.type !== 'toolCall') continue;
          const schema = schemaFor(state.name);

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
            const live = deps.repairProvider?.();
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

        // Client-side TPS: MLX sends no timings, so time first-token → now over
        // the completion-token count. Guard against a zero/negative window.
        if (firstTokenAt !== undefined && output.usage.output > 0) {
          const ms = Math.max(1, Date.now() - firstTokenAt);
          deps.onTps?.({ tps: (output.usage.output / ms) * 1000, tokens: output.usage.output, ms });
        }

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
