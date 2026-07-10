import {
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type Model,
  Type,
} from '@mariozechner/pi-ai';
import { describe, expect, it, vi } from 'vitest';
import { createMlxStream } from './stream.js';

function makeModel(baseUrl = 'http://127.0.0.1:8181/v1'): Model<'openai-completions'> {
  return {
    id: 'mlx-community/Qwen3.5-4B-MLX-4bit',
    name: 'Qwen3.5 4B (MLX)',
    api: 'openai-completions',
    provider: 'mlx',
    baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_768,
    maxTokens: 4096,
  };
}

/** A fake fetch that streams the given chunk objects as OpenAI SSE. */
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

describe('createMlxStream — text + CLIENT-side TPS', () => {
  it('streams text deltas, extracts usage, and reports client-side TPS (no timings)', async () => {
    // MLX chunks carry NO `timings` block — only `usage`.
    const { fetchImpl, calls } = sseFetch([
      { choices: [{ delta: { content: 'Hello' } }] },
      { choices: [{ delta: { content: ' MLX' } }] },
      {
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 12 },
      },
    ]);
    const onTps = vi.fn();
    const stream = createMlxStream({ fetchImpl, onTps })(makeModel(), emptyContext());
    const { events, final } = await consume(stream);

    expect(events.some((e) => e.type === 'text_delta')).toBe(true);
    const text = final.content.find((c) => c.type === 'text');
    expect(text?.type === 'text' && text.text).toBe('Hello MLX');
    expect(final.stopReason).toBe('stop');
    expect(final.usage.output).toBe(12);
    // TPS was computed on the client from completion tokens + wall clock.
    expect(onTps).toHaveBeenCalledOnce();
    const info = onTps.mock.calls[0]?.[0] as { tps: number; tokens: number; ms: number };
    expect(info.tokens).toBe(12);
    expect(info.ms).toBeGreaterThan(0);
    expect(info.tps).toBeGreaterThan(0);
    expect(calls).toHaveLength(1);
  });

  it('does not report TPS when no tokens were produced', async () => {
    const { fetchImpl } = sseFetch([
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { completion_tokens: 0 } },
    ]);
    const onTps = vi.fn();
    await consume(createMlxStream({ fetchImpl, onTps })(makeModel(), emptyContext()));
    expect(onTps).not.toHaveBeenCalled();
  });
});

describe('createMlxStream — REUSES the repair ladder (matters more for MLX #1096)', () => {
  const tools: Context['tools'] = [
    { name: 'read', description: 'read a file', parameters: Type.Object({ path: Type.String() }) },
  ];

  it('repairs a truncated tool-call JSON before emitting toolcall_end', async () => {
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
    const stream = createMlxStream({ fetchImpl, onRepair })(makeModel(), emptyContext(tools));
    const { final } = await consume(stream);
    const call = final.content.find((c) => c.type === 'toolCall');
    expect(call?.type === 'toolCall' && call.arguments).toEqual({ path: '/etc/hosts' });
    expect(final.stopReason).toBe('toolUse');
    expect(onRepair).toHaveBeenCalledOnce();
    expect(onRepair.mock.calls[0]?.[0]).toMatchObject({ toolName: 'read', ok: true, rung: 2 });
  });

  it('prefers live repairProvider deps (the harness bridge) over static ones', async () => {
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
    const stream = createMlxStream({
      fetchImpl,
      fixer: staticFixer,
      repairProvider: () => ({ fixer: liveFixer }),
    })(makeModel(), emptyContext(tools));
    const { final } = await consume(stream);
    expect(liveFixer).toHaveBeenCalledOnce();
    expect(staticFixer).not.toHaveBeenCalled();
    const call = final.content.find((c) => c.type === 'toolCall');
    expect(call?.type === 'toolCall' && call.arguments).toEqual({ path: '/live' });
  });
});
