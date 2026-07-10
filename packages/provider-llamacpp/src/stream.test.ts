import {
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type Model,
  Type,
} from '@mariozechner/pi-ai';
import { describe, expect, it, vi } from 'vitest';
import {
  buildChatCompletionsRequest,
  createLlamaCppStream,
  type LlamaCppTimings,
} from './stream.js';

function makeModel(baseUrl = 'http://127.0.0.1:8080/v1'): Model<'openai-completions'> {
  return {
    id: 'gemma-4-e2b-it',
    name: 'Gemma 4 E2B',
    api: 'openai-completions',
    provider: 'llamacpp',
    baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_768,
    maxTokens: 4096,
  };
}

/** Build a fake fetch that streams the given chunk objects as SSE. */
function sseFetch(chunks: unknown[]): { fetchImpl: typeof fetch; calls: RequestInit[] } {
  const calls: RequestInit[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    calls.push(init);
    async function* body(): AsyncGenerator<Uint8Array> {
      const enc = new TextEncoder();
      for (const c of chunks) yield enc.encode(`data: ${JSON.stringify(c)}\n\n`);
      yield enc.encode('data: [DONE]\n\n');
    }
    return { ok: true, status: 200, body: body() } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

async function consume(
  stream: AsyncIterable<AssistantMessageEvent>,
): Promise<{ events: AssistantMessageEvent[]; final: AssistantMessage }> {
  const events: AssistantMessageEvent[] = [];
  let final: AssistantMessage | undefined;
  for await (const e of stream) {
    events.push(e);
    if (e.type === 'done') final = e.message;
    if (e.type === 'error') final = e.error;
  }
  if (final === undefined) throw new Error('stream never terminated');
  return { events, final };
}

const emptyContext = (tools?: Context['tools']): Context => ({
  systemPrompt: 'You are a test.',
  messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
  tools,
});

describe('buildChatCompletionsRequest', () => {
  it('maps system/user/tools into an OpenAI body', () => {
    const body = buildChatCompletionsRequest(makeModel(), {
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hello', timestamp: 0 }],
      tools: [{ name: 'read', description: 'read a file', parameters: Type.Object({}) }],
    }) as { messages: Array<{ role: string }>; stream: boolean; tools?: unknown[] };
    expect(body.stream).toBe(true);
    expect(body.messages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(body.messages[1]?.role).toBe('user');
    expect(body.tools).toHaveLength(1);
  });
});

describe('createLlamaCppStream — text', () => {
  it('streams text deltas, extracts usage, and reports TPS from timings', async () => {
    const timings: LlamaCppTimings = { predicted_per_second: 88.5, predicted_n: 2 };
    const { fetchImpl, calls } = sseFetch([
      { choices: [{ delta: { content: 'Hello' } }] },
      { choices: [{ delta: { content: ' world' } }] },
      {
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
        timings,
      },
    ]);
    const onTimings = vi.fn();
    const stream = createLlamaCppStream({ fetchImpl, onTimings })(makeModel(), emptyContext());
    const { events, final } = await consume(stream);

    expect(events.some((e) => e.type === 'text_delta')).toBe(true);
    const text = final.content.find((c) => c.type === 'text');
    expect(text?.type === 'text' && text.text).toBe('Hello world');
    expect(final.stopReason).toBe('stop');
    expect(final.usage.output).toBe(2);
    expect(onTimings).toHaveBeenCalledWith(timings);
    // Sanity: the POST went to the chat/completions endpoint.
    expect(calls).toHaveLength(1);
  });
});

describe('createLlamaCppStream — tool-call repair', () => {
  const tools: Context['tools'] = [
    {
      name: 'read',
      description: 'read a file',
      parameters: Type.Object({ path: Type.String() }),
    },
  ];

  it('repairs a truncated tool-call JSON before emitting toolcall_end', async () => {
    // Arguments arrive truncated: missing the closing quote + brace.
    const { fetchImpl } = sseFetch([
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read' } }] } },
        ],
      },
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"/etc/hosts' } }] } },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    const onRepair = vi.fn();
    const stream = createLlamaCppStream({ fetchImpl, onRepair })(makeModel(), emptyContext(tools));
    const { events, final } = await consume(stream);

    const toolEnd = events.find((e) => e.type === 'toolcall_end');
    expect(toolEnd).toBeDefined();
    const call = final.content.find((c) => c.type === 'toolCall');
    expect(call?.type === 'toolCall' && call.name).toBe('read');
    expect(call?.type === 'toolCall' && call.arguments).toEqual({ path: '/etc/hosts' });
    expect(final.stopReason).toBe('toolUse');
    // Repair fired and succeeded (rung 2: schema-valid after syntactic fix).
    expect(onRepair).toHaveBeenCalledOnce();
    expect(onRepair.mock.calls[0]?.[0]).toMatchObject({ toolName: 'read', ok: true, rung: 2 });
  });

  it('invokes the injected fixer when the repaired args miss the schema', async () => {
    const { fetchImpl } = sseFetch([
      {
        choices: [{ delta: { tool_calls: [{ index: 0, id: 'c2', function: { name: 'read' } }] } }],
      },
      // Valid JSON but wrong shape (no "path"), and truncated so parse fails first.
      {
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"wrong":1' } }] } }],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    const fixer = vi.fn(async () => ({ path: '/fixed-by-model' }));
    const stream = createLlamaCppStream({ fetchImpl, fixer })(makeModel(), emptyContext(tools));
    const { final } = await consume(stream);
    expect(fixer).toHaveBeenCalledOnce();
    const call = final.content.find((c) => c.type === 'toolCall');
    expect(call?.type === 'toolCall' && call.arguments).toEqual({ path: '/fixed-by-model' });
  });

  it('enters the ladder for a SCHEMA-invalid tool call that PARSED cleanly', async () => {
    // Fully valid JSON, but missing the required "path" — parse succeeds, so this
    // never reached repair before. Now it must enter the ladder and hit the fixer.
    const { fetchImpl } = sseFetch([
      {
        choices: [{ delta: { tool_calls: [{ index: 0, id: 'c3', function: { name: 'read' } }] } }],
      },
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: '{"wrong":1}' } }] } },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    const fixer = vi.fn(async () => ({ path: '/repaired' }));
    const onRepair = vi.fn();
    const stream = createLlamaCppStream({ fetchImpl, fixer, onRepair })(
      makeModel(),
      emptyContext(tools),
    );
    const { final } = await consume(stream);
    expect(fixer).toHaveBeenCalledOnce();
    expect(onRepair).toHaveBeenCalledWith({ toolName: 'read', ok: true, rung: 2 });
    const call = final.content.find((c) => c.type === 'toolCall');
    expect(call?.type === 'toolCall' && call.arguments).toEqual({ path: '/repaired' });
  });

  it('does NOT repair a schema-valid tool call', async () => {
    const { fetchImpl } = sseFetch([
      {
        choices: [{ delta: { tool_calls: [{ index: 0, id: 'c4', function: { name: 'read' } }] } }],
      },
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"/ok"}' } }] } },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    const onRepair = vi.fn();
    const stream = createLlamaCppStream({ fetchImpl, onRepair })(makeModel(), emptyContext(tools));
    const { final } = await consume(stream);
    expect(onRepair).not.toHaveBeenCalled();
    const call = final.content.find((c) => c.type === 'toolCall');
    expect(call?.type === 'toolCall' && call.arguments).toEqual({ path: '/ok' });
  });

  it('resolves live deps from repairProvider (the harness bridge) over static deps', async () => {
    const { fetchImpl } = sseFetch([
      {
        choices: [{ delta: { tool_calls: [{ index: 0, id: 'c5', function: { name: 'read' } }] } }],
      },
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: '{"wrong":1}' } }] } },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    const staticFixer = vi.fn(async () => ({ path: '/static' }));
    const liveFixer = vi.fn(async () => ({ path: '/live' }));
    const liveOnRepair = vi.fn();
    const stream = createLlamaCppStream({
      fetchImpl,
      fixer: staticFixer,
      repairProvider: () => ({ fixer: liveFixer, onRepair: liveOnRepair }),
    })(makeModel(), emptyContext(tools));
    const { final } = await consume(stream);
    expect(liveFixer).toHaveBeenCalledOnce();
    expect(staticFixer).not.toHaveBeenCalled();
    expect(liveOnRepair).toHaveBeenCalledWith({ toolName: 'read', ok: true, rung: 2 });
    const call = final.content.find((c) => c.type === 'toolCall');
    expect(call?.type === 'toolCall' && call.arguments).toEqual({ path: '/live' });
  });
});
