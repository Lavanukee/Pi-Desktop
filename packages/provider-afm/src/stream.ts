/**
 * Apple Foundation Models `streamSimple` for pi's custom `afm-stream` API.
 *
 * Bridges @pi-desktop/afm's `streamAfm` (which spawns the Swift `pi-afm` helper
 * and streams NDJSON deltas from the on-device model) into pi's
 * AssistantMessageEventStream, exactly per docs/custom-provider.md — mirroring
 * @pi-desktop/provider-llamacpp's stream handler but far simpler: the on-device
 * base model is a text streamer with limited tool use, so we translate pi's
 * Context into a single {@link AfmRequest} (instructions + prior turns + the live
 * user prompt) and emit ONE streamed text block. No tool-call parsing/repair.
 *
 * Electron-free; `streamAfmImpl` is injectable so the translation + event mapping
 * unit-test with a fake stream, no real `pi-afm` binary required.
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
} from '@mariozechner/pi-ai';
import {
  AfmAbortError,
  type AfmMessage,
  type AfmRequest,
  type AfmStreamResult,
  streamAfm as realStreamAfm,
  type StreamAfmOptions,
} from '@pi-desktop/afm';

/** The streamAfm surface this module depends on (injectable for tests). */
export type StreamAfmFn = (
  request: AfmRequest,
  options?: StreamAfmOptions,
) => Promise<AfmStreamResult>;

export interface AfmStreamDeps {
  /** Injectable streamAfm (tests). Defaults to the real @pi-desktop/afm one. */
  readonly streamAfmImpl?: StreamAfmFn;
  /**
   * Explicit `pi-afm` helper binary path. The desktop app injects the resolved
   * bundle path here; when undefined, streamAfm falls back to
   * `PI_AFM_HELPER_PATH` / the dev build (see @pi-desktop/afm helper-path).
   */
  readonly helperPath?: string;
}

/** streamSimple signature required by pi's ProviderConfig. */
export type AfmStreamFn = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

// --- request building ------------------------------------------------------

/** Flatten a message's content down to its plain text (images/thinking/tool
 * blocks are dropped — the on-device model is text-only). */
function textOf(content: string | readonly (TextContent | ImageContent)[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((c): c is TextContent => c.type === 'text')
    .map((c) => c.text)
    .join('');
}

/**
 * Translate pi's Context into an {@link AfmRequest}. The system prompt becomes
 * the session `instructions`, the FINAL user turn becomes the live `prompt`, and
 * every user/assistant turn before it becomes the `messages` transcript preamble
 * the helper folds in. toolResult turns are skipped (no tool loop on-device).
 *
 * Pure + exported so the translation is unit-tested directly.
 */
export function buildAfmRequest(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AfmRequest {
  // Index of the last user message — its text is the live prompt.
  let lastUserIndex = -1;
  for (let i = context.messages.length - 1; i >= 0; i--) {
    if (context.messages[i]?.role === 'user') {
      lastUserIndex = i;
      break;
    }
  }

  const history: AfmMessage[] = [];
  for (let i = 0; i < context.messages.length; i++) {
    if (i === lastUserIndex) continue;
    const msg = context.messages[i];
    if (msg === undefined) continue;
    if (msg.role === 'user') {
      history.push({ role: 'user', content: textOf(msg.content) });
    } else if (msg.role === 'assistant') {
      const text = msg.content
        .filter((c): c is TextContent => c.type === 'text')
        .map((c) => c.text)
        .join('');
      if (text.length > 0) history.push({ role: 'assistant', content: text });
    }
    // toolResult turns are intentionally dropped.
  }

  const liveUser = lastUserIndex >= 0 ? context.messages[lastUserIndex] : undefined;
  const prompt = liveUser !== undefined && liveUser.role === 'user' ? textOf(liveUser.content) : '';

  const request: AfmRequest = {
    prompt,
    ...(context.systemPrompt !== undefined && context.systemPrompt.length > 0
      ? { instructions: context.systemPrompt }
      : {}),
    ...(history.length > 0 ? { messages: history } : {}),
    ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options?.maxTokens !== undefined
      ? { maxTokens: options.maxTokens }
      : model.maxTokens > 0
        ? { maxTokens: model.maxTokens }
        : {}),
  };
  return request;
}

// --- streaming -------------------------------------------------------------

/**
 * Create the streamSimple function for the Apple Foundation Models provider.
 * `deps.streamAfmImpl` / `deps.helperPath` are the seams the desktop app and
 * tests wire.
 */
export function createAfmStream(deps: AfmStreamDeps = {}): AfmStreamFn {
  const stream = deps.streamAfmImpl ?? realStreamAfm;

  return (model, context, options) => {
    const events = createAssistantMessageEventStream();

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

      const ensureTextBlock = (): number => {
        if (textIndex === undefined) {
          output.content.push({ type: 'text', text: '' });
          textIndex = output.content.length - 1;
          events.push({ type: 'text_start', contentIndex: textIndex, partial: output });
        }
        return textIndex;
      };

      try {
        events.push({ type: 'start', partial: output });

        const request = buildAfmRequest(model, context, options);
        const result = await stream(request, {
          onDelta: (delta) => {
            if (delta.length === 0) return;
            const idx = ensureTextBlock();
            const block = output.content[idx];
            if (block?.type === 'text') block.text += delta;
            events.push({ type: 'text_delta', contentIndex: idx, delta, partial: output });
          },
          ...(options?.signal !== undefined ? { signal: options.signal } : {}),
          ...(deps.helperPath !== undefined ? { helperPath: deps.helperPath } : {}),
        });

        if (textIndex !== undefined) {
          const block = output.content[textIndex];
          events.push({
            type: 'text_end',
            contentIndex: textIndex,
            content: block?.type === 'text' ? block.text : '',
            partial: output,
          });
        }

        if (result.usage !== undefined) {
          output.usage.input = result.usage.inputTokens ?? 0;
          output.usage.output = result.usage.outputTokens ?? 0;
        }
        output.usage.totalTokens = output.usage.input + output.usage.output;
        calculateCost(model, output.usage);

        output.stopReason = 'stop';
        events.push({ type: 'done', reason: 'stop', message: output });
        events.end();
      } catch (error) {
        const aborted = options?.signal?.aborted === true || error instanceof AfmAbortError;
        output.stopReason = aborted ? 'aborted' : 'error';
        output.errorMessage = error instanceof Error ? error.message : String(error);
        events.push({ type: 'error', reason: output.stopReason, error: output });
        events.end();
      }
    })();

    return events;
  };
}
