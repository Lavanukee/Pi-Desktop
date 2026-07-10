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
  type RepairRung,
  repairToolCallArguments,
  type ToolCallFixer,
  type ToolSchemaLike,
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

export interface LlamaCppStreamDeps {
  /** Injectable fetch (tests / proxies). Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Rung-2 fixer-model call (optional; injected by W5 harness in prod). */
  readonly fixer?: ToolCallFixer;
  /** W5 rungs 3–5. */
  readonly extraRungs?: readonly RepairRung[];
  /** Called with the final `timings` block — bridge to the supervisor's TPS. */
  readonly onTimings?: (t: LlamaCppTimings) => void;
  /** Called when a tool call needed repair (observability / W5 seam). */
  readonly onRepair?: (info: { toolName: string; rung: number | undefined; ok: boolean }) => void;
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
      const out: OAIMessage = { role: 'assistant', content: text.length > 0 ? text : null };
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
          throw new Error(`llama-server HTTP ${res.status}: ${detail.slice(0, 500)}`);
        }

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

        for (const state of toolStates.values()) {
          const block = output.content[state.contentIndex];
          if (block?.type !== 'toolCall') continue;
          let finalArgs: Record<string, unknown> | undefined;
          try {
            finalArgs =
              state.argStr.length > 0 ? (JSON.parse(state.argStr) as Record<string, unknown>) : {};
          } catch {
            // RUNG 1–2 repair.
            const result = await repairToolCallArguments(state.argStr, {
              toolName: state.name,
              schema: schemaFor(state.name),
              fixer: deps.fixer,
              extraRungs: deps.extraRungs,
            });
            deps.onRepair?.({ toolName: state.name, rung: result.rung, ok: result.ok });
            finalArgs = result.value ?? {};
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
