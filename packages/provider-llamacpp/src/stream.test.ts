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
  contextHasImage,
  createLlamaCppStream,
  type LlamaCppTimings,
  promptProgressFraction,
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

  it('opts into prefill progress frames with return_progress', () => {
    const body = buildChatCompletionsRequest(makeModel(), {
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hello', timestamp: 0 }],
    }) as { return_progress?: boolean; stream_options?: { include_usage?: boolean } };
    expect(body.return_progress).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it('carries a prior assistant turn thinking back as reasoning_content (preserve-thinking)', () => {
    const body = buildChatCompletionsRequest(makeModel(), {
      systemPrompt: 'sys',
      messages: [
        { role: 'user', content: 'q', timestamp: 0 },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'let me reason' },
            { type: 'text', text: 'answer' },
          ],
          timestamp: 1,
        },
        { role: 'user', content: 'follow-up', timestamp: 2 },
      ],
    } as unknown as Parameters<typeof buildChatCompletionsRequest>[1]) as {
      messages: Array<{ role: string; content?: unknown; reasoning_content?: string }>;
    };
    const assistant = body.messages.find((m) => m.role === 'assistant');
    expect(assistant?.reasoning_content).toBe('let me reason');
    expect(assistant?.content).toBe('answer');
  });

  it('omits reasoning_content when the assistant turn had no thinking', () => {
    const body = buildChatCompletionsRequest(makeModel(), {
      systemPrompt: 'sys',
      messages: [
        { role: 'user', content: 'q', timestamp: 0 },
        { role: 'assistant', content: [{ type: 'text', text: 'plain' }], timestamp: 1 },
      ],
    } as unknown as Parameters<typeof buildChatCompletionsRequest>[1]) as {
      messages: Array<{ role: string; reasoning_content?: string }>;
    };
    const assistant = body.messages.find((m) => m.role === 'assistant');
    expect(assistant?.reasoning_content).toBeUndefined();
  });
});

describe('contextHasImage (provider-layer vision-need detector)', () => {
  it('is false for a pure-text context (string or text-part content)', () => {
    expect(contextHasImage({ messages: [{ role: 'user', content: 'hi', timestamp: 0 }] })).toBe(
      false,
    );
    expect(
      contextHasImage({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 0 }],
      }),
    ).toBe(false);
  });

  it('is true when any user message carries an image part', () => {
    expect(
      contextHasImage({
        messages: [
          { role: 'user', content: 'describe this', timestamp: 0 },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'look' },
              { type: 'image', mimeType: 'image/png', data: 'AAAA' },
            ],
            timestamp: 1,
          },
        ],
      }),
    ).toBe(true);
  });
});

describe('promptProgressFraction (pure)', () => {
  it('is processed/total clamped to 0..1', () => {
    expect(promptProgressFraction({ processed: 512, total: 1024 })).toBeCloseTo(0.5, 5);
    expect(promptProgressFraction({ processed: 1024, total: 1024 })).toBe(1);
    expect(promptProgressFraction({ processed: 2048, total: 1024 })).toBe(1); // over-report
  });

  it('is 0 when the total is unknown / not yet reported (no divide-by-zero)', () => {
    expect(promptProgressFraction({ processed: 10 })).toBe(0);
    expect(promptProgressFraction({ processed: 10, total: 0 })).toBe(0);
    expect(promptProgressFraction({})).toBe(0);
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

  it('reports prefill progress from `prompt_progress` frames, then streams text', async () => {
    // Two choice-less prefill frames arrive before the first token — exactly the
    // shape llama-server emits under `return_progress: true`.
    const { fetchImpl } = sseFetch([
      { choices: [], prompt_progress: { processed: 256, total: 1024 } },
      { choices: [], prompt_progress: { processed: 1024, total: 1024 } },
      { choices: [{ delta: { content: 'Hi' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]);
    const onPromptProgress = vi.fn();
    const stream = createLlamaCppStream({ fetchImpl, onPromptProgress })(
      makeModel(),
      emptyContext(),
    );
    const { final } = await consume(stream);

    // Both prefill frames surfaced with a normalized fraction; the choice-less
    // frames did not break text parsing.
    expect(onPromptProgress).toHaveBeenCalledTimes(2);
    expect(onPromptProgress.mock.calls[0]?.[0]).toEqual({
      processed: 256,
      total: 1024,
      fraction: 0.25,
    });
    expect(onPromptProgress.mock.calls[1]?.[0]).toMatchObject({ fraction: 1 });
    const text = final.content.find((c) => c.type === 'text');
    expect(text?.type === 'text' && text.text).toBe('Hi');
    expect(final.stopReason).toBe('stop');
  });

  it('does not require onPromptProgress — a prefill frame is a safe no-op without it', async () => {
    const { fetchImpl } = sseFetch([
      { choices: [], prompt_progress: { processed: 10, total: 20 } },
      { choices: [{ delta: { content: 'ok' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]);
    const stream = createLlamaCppStream({ fetchImpl })(makeModel(), emptyContext());
    const { final } = await consume(stream);
    const text = final.content.find((c) => c.type === 'text');
    expect(text?.type === 'text' && text.text).toBe('ok');
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

describe('createLlamaCppStream — rung 0 (text-content reconstruction)', () => {
  const tools: Context['tools'] = [
    { name: 'read', description: 'read a file', parameters: Type.Object({ path: Type.String() }) },
  ];

  it('reconstructs a tool call the model wrote as CONTENT prose (no tool_calls frame)', async () => {
    // The model answers in prose with a JSON envelope instead of a structured call.
    const { fetchImpl } = sseFetch([
      {
        choices: [
          { delta: { content: 'Let me look:\n{"name":"read","arguments":{"path":"/etc/hosts"}}' } },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]);
    const onRepair = vi.fn();
    const stream = createLlamaCppStream({ fetchImpl, onRepair })(makeModel(), emptyContext(tools));
    const { events, final } = await consume(stream);

    // A structured tool call was synthesized from the prose and finalized.
    expect(events.some((e) => e.type === 'toolcall_start')).toBe(true);
    expect(events.some((e) => e.type === 'toolcall_end')).toBe(true);
    const call = final.content.find((c) => c.type === 'toolCall');
    expect(call?.type === 'toolCall' && call.name).toBe('read');
    expect(call?.type === 'toolCall' && call.arguments).toEqual({ path: '/etc/hosts' });
    expect(final.stopReason).toBe('toolUse');
    // Recorded as a rung-0 structural repair.
    expect(onRepair).toHaveBeenCalledWith({ toolName: 'read', rung: 0, ok: true });
  });

  it('does NOT reconstruct when the content only MENTIONS a tool', async () => {
    const { fetchImpl } = sseFetch([
      { choices: [{ delta: { content: 'You can use the read tool to open files.' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]);
    const onRepair = vi.fn();
    const stream = createLlamaCppStream({ fetchImpl, onRepair })(makeModel(), emptyContext(tools));
    const { events, final } = await consume(stream);
    expect(events.some((e) => e.type === 'toolcall_end')).toBe(false);
    expect(final.content.some((c) => c.type === 'toolCall')).toBe(false);
    expect(final.stopReason).toBe('stop');
    expect(onRepair).not.toHaveBeenCalled();
  });

  it('does NOT reconstruct when a structured tool call was already emitted', async () => {
    const { fetchImpl } = sseFetch([
      {
        choices: [
          {
            delta: {
              content: '{"name":"read","arguments":{"path":"/decoy"}}',
              tool_calls: [
                { index: 0, id: 't1', function: { name: 'read', arguments: '{"path":"/real"}' } },
              ],
            },
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    const stream = createLlamaCppStream({ fetchImpl })(makeModel(), emptyContext(tools));
    const { final } = await consume(stream);
    const calls = final.content.filter((c) => c.type === 'toolCall');
    expect(calls).toHaveLength(1); // only the real structured one
    expect(calls[0]?.type === 'toolCall' && calls[0].arguments).toEqual({ path: '/real' });
  });
});

// This is the EXACT corp failure this whole change targets: llama-server's jinja
// grammar fails and the model writes its call as raw `<tool_call>` XML into the
// assistant CONTENT (Hermes/Qwen `<function=…><parameter=…>` form) with NO
// structured tool_calls frame — under the STOCK openai-completions handler it would
// render as inert XML and never execute. Routing the corp through createLlamaCppStream
// runs RUNG 0, which salvages it into a structured, executable call.
describe('createLlamaCppStream — rung 0 (corp raw-XML tool call from content)', () => {
  const webTools: Context['tools'] = [
    {
      name: 'web_fetch',
      description: 'fetch a url',
      parameters: Type.Object({ url: Type.String() }),
    },
  ];
  const writeTools: Context['tools'] = [
    {
      name: 'write',
      description: 'write a file',
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
    },
  ];

  it('reconstructs a <function=web_fetch><parameter=url> call streamed as CONTENT deltas', async () => {
    // The offending shape, streamed across several content deltas, no tool_calls frame.
    const { fetchImpl } = sseFetch([
      { choices: [{ delta: { content: '<tool_call>\n<function=web_fetch>\n' } }] },
      { choices: [{ delta: { content: '<parameter=url>\nhttps://x/\n</parameter>\n' } }] },
      { choices: [{ delta: { content: '</function>\n</tool_call>' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]);
    const onRepair = vi.fn();
    const stream = createLlamaCppStream({ fetchImpl, onRepair })(
      makeModel(),
      emptyContext(webTools),
    );
    const { events, final } = await consume(stream);

    // RUNG 0 fired: a STRUCTURED tool call was synthesized and finalized.
    expect(events.some((e) => e.type === 'toolcall_end')).toBe(true);
    const call = final.content.find((c) => c.type === 'toolCall');
    expect(call?.type).toBe('toolCall');
    expect(call?.type === 'toolCall' && call.name).toBe('web_fetch');
    expect(call?.type === 'toolCall' && call.arguments).toEqual({ url: 'https://x/' });
    // The message ENDS WITH the structured toolCall block (text first, call last).
    const last = final.content.at(-1);
    expect(last?.type).toBe('toolCall');
    expect(final.stopReason).toBe('toolUse');
    expect(onRepair).toHaveBeenCalledWith({ toolName: 'web_fetch', rung: 0, ok: true });
  });

  it('reconstructs a <function=write> call whose <parameter=content> is TS with braces', async () => {
    const tsBody = 'export function f() { return { a: 1, b: { c: 2 } }; }';
    const { fetchImpl } = sseFetch([
      { choices: [{ delta: { content: `<function=write>\n<parameter=path>\nsrc/foo.ts\n</parameter>\n` } }] },
      { choices: [{ delta: { content: `<parameter=content>\n${tsBody}\n</parameter>\n</function>` } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]);
    const stream = createLlamaCppStream({ fetchImpl })(makeModel(), emptyContext(writeTools));
    const { final } = await consume(stream);

    const call = final.content.find((c) => c.type === 'toolCall');
    expect(call?.type === 'toolCall' && call.name).toBe('write');
    // Braces in the code body survive intact (not mis-parsed as the args JSON).
    expect(call?.type === 'toolCall' && call.arguments).toEqual({
      path: 'src/foo.ts',
      content: tsBody,
    });
  });
});

// The seam that lets the corp keep its sampling + hang watchdog while running through
// createLlamaCppStream: it now honors pi's `onPayload` (before_provider_request) and
// `onResponse` (after_provider_response) hooks, exactly like the built-in providers.
describe('createLlamaCppStream — onPayload / onResponse hooks', () => {
  it('sends the body onPayload returns (sampling merge lands on the wire)', async () => {
    const { fetchImpl, calls } = sseFetch([
      { choices: [{ delta: { content: 'ok' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]);
    // A stand-in for corpExt's before_provider_request: merge extra sampling params.
    const onPayload = vi.fn((payload: unknown) => {
      const p = payload as Record<string, unknown>;
      p.temperature = 0.6;
      p.top_p = 0.95;
      p.top_k = 20;
      p.min_p = 0;
      p.presence_penalty = 0;
      p.max_tokens = 1234;
      return p;
    });
    const stream = createLlamaCppStream({ fetchImpl })(makeModel(), emptyContext(), { onPayload });
    await consume(stream);

    expect(onPayload).toHaveBeenCalledOnce();
    const sent = JSON.parse(String(calls[0]?.body)) as Record<string, unknown>;
    expect(sent).toMatchObject({
      temperature: 0.6,
      top_p: 0.95,
      top_k: 20,
      min_p: 0,
      presence_penalty: 0,
      max_tokens: 1234,
    });
  });

  it('calls onResponse with the response status once the response arrives', async () => {
    const { fetchImpl } = sseFetch([
      { choices: [{ delta: { content: 'ok' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]);
    const onResponse = vi.fn();
    const stream = createLlamaCppStream({ fetchImpl })(makeModel(), emptyContext(), { onResponse });
    await consume(stream);

    expect(onResponse).toHaveBeenCalledOnce();
    expect(onResponse.mock.calls[0]?.[0]).toMatchObject({ status: 200 });
  });
});

describe('createLlamaCppStream — fuzzy tool-name correction', () => {
  const tools: Context['tools'] = [
    { name: 'read', description: 'read a file', parameters: Type.Object({ path: Type.String() }) },
  ];

  it('renames an unknown/misspelled structured tool call to the nearest registered tool', async () => {
    const { fetchImpl } = sseFetch([
      {
        choices: [{ delta: { tool_calls: [{ index: 0, id: 'x', function: { name: 'reed' } }] } }],
      },
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"/x"}' } }] } },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    const onRepair = vi.fn();
    const stream = createLlamaCppStream({ fetchImpl, onRepair })(makeModel(), emptyContext(tools));
    const { final } = await consume(stream);
    const call = final.content.find((c) => c.type === 'toolCall');
    expect(call?.type === 'toolCall' && call.name).toBe('read'); // corrected
    expect(call?.type === 'toolCall' && call.arguments).toEqual({ path: '/x' });
    expect(onRepair).toHaveBeenCalledWith({ toolName: 'read', rung: 0, ok: true });
  });

  it('leaves a wildly-unknown name uncorrected (existing not-found path)', async () => {
    const { fetchImpl } = sseFetch([
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, id: 'x', function: { name: 'zzz_nope' } }] } },
        ],
      },
      {
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] } }],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    const stream = createLlamaCppStream({ fetchImpl })(makeModel(), emptyContext(tools));
    const { final } = await consume(stream);
    const call = final.content.find((c) => c.type === 'toolCall');
    expect(call?.type === 'toolCall' && call.name).toBe('zzz_nope'); // unchanged
  });
});

describe('createLlamaCppStream — per-session relaxed schema (rung 4)', () => {
  const tools: Context['tools'] = [
    { name: 'read', description: 'read a file', parameters: Type.Object({ path: Type.String() }) },
  ];

  it('validates against the relaxed schema so a previously-invalid call passes without repair', async () => {
    // Missing the required "path" — normally schema-invalid → repair. But the
    // harness relaxed this tool's schema, so it passes at rung 2 untouched.
    const { fetchImpl } = sseFetch([
      {
        choices: [{ delta: { tool_calls: [{ index: 0, id: 'r', function: { name: 'read' } }] } }],
      },
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: '{"wrong":1}' } }] } },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    const onRepair = vi.fn();
    const stream = createLlamaCppStream({
      fetchImpl,
      onRepair,
      repairProvider: () => ({
        relaxedSchemaFor: (name) =>
          name === 'read' ? { type: 'object', additionalProperties: true } : undefined,
      }),
    })(makeModel(), emptyContext(tools));
    const { final } = await consume(stream);
    // No repair fired — the relaxed schema accepted the args as-is.
    expect(onRepair).not.toHaveBeenCalled();
    const call = final.content.find((c) => c.type === 'toolCall');
    expect(call?.type === 'toolCall' && call.arguments).toEqual({ wrong: 1 });
  });
});
