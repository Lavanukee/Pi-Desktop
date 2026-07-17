/**
 * The REAL {@link CorpChatFn} for the desktop: one corp role-turn → one
 * `POST <baseUrl>/chat/completions` against the running llama-server (the same
 * OpenAI-compatible endpoint the inference supervisor exposes, `getInferenceUtility`).
 *
 * The corp seam is provider-agnostic on purpose (no `/no_think` tag, no
 * `chat_template_kwargs` in the request DTO — see `CorpChatRequest`), so THIS is
 * where the llama.cpp/qwen provider specifics are applied from `request.thinking`:
 *   - `chat_template_kwargs.enable_thinking` (qwen's jinja switch), AND
 *   - a trailing ` /no_think` tag on the last user message when thinking is off
 *     (belt-and-suspenders — the same convention the slice-4 live driver uses).
 * `max_tokens` is the per-role cap; `tools` (only on the worker promotion turn)
 * are forwarded with `tool_choice: 'auto'` and the streamed tool-call deltas are
 * reassembled into {@link CorpChatResult.toolCalls}.
 *
 * Streaming SSE, so a long generation never buries the reply in one giant body.
 * Node-only (electron main); kept electron-free so it is unit-testable with an
 * injected `fetch`.
 */

import type {
  CorpChatFn,
  CorpChatRequest,
  CorpChatResult,
  CorpToolCall,
} from '@pi-desktop/harness/corp';

/** Config for {@link createLlamaCorpChat}. */
export interface LlamaCorpChatConfig {
  /** OpenAI-compat base URL ending in `/v1` (supervisor `baseUrl`). */
  readonly baseUrl: string;
  /** The served model id. */
  readonly model: string;
  /** Optional bearer token (local server usually needs none). */
  readonly apiKey?: string;
  /** Injected fetch (defaults to global `fetch`), for tests. */
  readonly fetchImpl?: typeof fetch;
  /** Per-request abort signal source (the engine aborts by returning empty; this
   * is a lower-level network cap). */
  readonly signal?: () => AbortSignal | undefined;
}

const NO_THINK_TAG = ' /no_think';

interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Apply the qwen thinking-off convention to a copy of the messages. */
function withThinking(
  messages: readonly { role: OpenAiMessage['role']; content: string }[],
  thinking: boolean,
): OpenAiMessage[] {
  const out: OpenAiMessage[] = messages.map((m) => ({ role: m.role, content: m.content }));
  if (!thinking) {
    for (let i = out.length - 1; i >= 0; i--) {
      const msg = out[i];
      if (msg !== undefined && msg.role === 'user') {
        out[i] = { role: 'user', content: `${msg.content}${NO_THINK_TAG}` };
        break;
      }
    }
  }
  return out;
}

/** Accumulator for streamed tool-call deltas, keyed by their `index`. */
interface ToolCallAccum {
  name: string;
  args: string;
}

/**
 * Build the `CorpChatFn` bound to one running server. Each call streams the SSE
 * response and returns the accumulated assistant text (reasoning channel dropped)
 * plus any reassembled tool calls.
 */
export function createLlamaCorpChat(config: LlamaCorpChatConfig): CorpChatFn {
  const doFetch = config.fetchImpl ?? fetch;
  const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;

  return async (request: CorpChatRequest): Promise<CorpChatResult> => {
    const body: Record<string, unknown> = {
      model: config.model,
      messages: withThinking(request.messages, request.thinking),
      max_tokens: request.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
      // qwen jinja thinking switch (the seam's provider-specific half).
      chat_template_kwargs: { enable_thinking: request.thinking },
      ...(request.tools !== undefined && request.tools.length > 0
        ? { tools: request.tools, tool_choice: 'auto' }
        : {}),
    };

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
    };
    if (config.apiKey !== undefined && config.apiKey !== '') {
      headers.authorization = `Bearer ${config.apiKey}`;
    }

    const res = await doFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      ...(config.signal?.() !== undefined ? { signal: config.signal() } : {}),
    });
    if (!res.ok || res.body === null) {
      throw new Error(`corp chat: server returned ${res.status} ${res.statusText}`);
    }

    let content = '';
    const toolCalls = new Map<number, ToolCallAccum>();

    await readSse(res.body, (data) => {
      if (data === '[DONE]') return;
      let json: unknown;
      try {
        json = JSON.parse(data);
      } catch {
        return;
      }
      const choice = firstChoice(json);
      const delta = choice?.delta;
      if (delta === undefined) return;
      if (typeof delta.content === 'string') content += delta.content;
      // reasoning_content / reasoning are the thinking channel — dropped from the
      // returned assistant text (the seam wants the answer, not the scratchpad).
      const rawToolCalls = delta.tool_calls;
      if (Array.isArray(rawToolCalls)) {
        for (const tc of rawToolCalls) accumulateToolCall(toolCalls, tc);
      }
    });

    const calls: CorpToolCall[] = [...toolCalls.values()]
      .filter((c) => c.name !== '')
      .map((c) => ({ name: c.name, arguments: c.args }));

    return calls.length > 0 ? { content, toolCalls: calls } : { content };
  };
}

interface Delta {
  content?: unknown;
  tool_calls?: unknown;
}

function firstChoice(json: unknown): { delta?: Delta } | undefined {
  if (json === null || typeof json !== 'object') return undefined;
  const choices = (json as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const first = choices[0];
  if (first === null || typeof first !== 'object') return undefined;
  const delta = (first as { delta?: unknown }).delta;
  return { delta: (delta ?? undefined) as Delta | undefined };
}

function accumulateToolCall(acc: Map<number, ToolCallAccum>, raw: unknown): void {
  if (raw === null || typeof raw !== 'object') return;
  const tc = raw as { index?: unknown; function?: unknown };
  const index = typeof tc.index === 'number' ? tc.index : 0;
  const fn = (tc.function ?? {}) as { name?: unknown; arguments?: unknown };
  const entry = acc.get(index) ?? { name: '', args: '' };
  if (typeof fn.name === 'string' && fn.name !== '') entry.name = fn.name;
  if (typeof fn.arguments === 'string') entry.args += fn.arguments;
  acc.set(index, entry);
}

/**
 * Read an SSE `ReadableStream<Uint8Array>` line-by-line, invoking `onData` with
 * the payload of each `data:` line. Framing-tolerant (buffers partial lines).
 */
async function readSse(
  stream: ReadableStream<Uint8Array>,
  onData: (data: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (line.startsWith('data:')) onData(line.slice(5).trim());
        nl = buffer.indexOf('\n');
      }
    }
    const tail = buffer.trim();
    if (tail.startsWith('data:')) onData(tail.slice(5).trim());
  } finally {
    reader.releaseLock();
  }
}
