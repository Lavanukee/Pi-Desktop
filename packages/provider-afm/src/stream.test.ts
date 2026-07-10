/**
 * Unit tests for the AFM streamSimple: the Context → AfmRequest translation and
 * the AfmStreamResult → AssistantMessageEventStream mapping, driven with a fake
 * `streamAfm` (no real `pi-afm` binary). Locks in that a live prompt streams as
 * one text block, prior turns fold into the transcript, usage maps through, and
 * both the in-band error and the abort paths surface as pi error events.
 */

import type { Api, AssistantMessageEvent, Context, Model } from '@mariozechner/pi-ai';
import { AfmAbortError, AfmError, type AfmRequest, type StreamAfmOptions } from '@pi-desktop/afm';
import { describe, expect, it } from 'vitest';
import { buildAfmRequest, createAfmStream, type StreamAfmFn } from './stream.js';

function model(api: Api = 'afm-stream'): Model<Api> {
  return {
    id: 'apple-on-device',
    name: 'Apple Intelligence',
    api,
    provider: 'afm',
    baseUrl: 'afm://local',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 4096,
    maxTokens: 1024,
  };
}

async function drain(
  stream: AsyncIterable<AssistantMessageEvent>,
): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const e of stream) events.push(e);
  return events;
}

describe('buildAfmRequest', () => {
  it('maps systemPrompt → instructions, last user → prompt, prior turns → messages', () => {
    const ctx: Context = {
      systemPrompt: 'be terse',
      messages: [
        { role: 'user', content: 'hello', timestamp: 0 },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'hi!' }],
          api: 'afm-stream',
          provider: 'afm',
          model: 'apple-on-device',
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: 'stop',
          timestamp: 1,
        },
        { role: 'user', content: 'say hi again', timestamp: 2 },
      ],
    };

    const req = buildAfmRequest(model(), ctx, { temperature: 0.5, maxTokens: 128 });
    expect(req.prompt).toBe('say hi again');
    expect(req.instructions).toBe('be terse');
    expect(req.messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi!' },
    ]);
    expect(req.temperature).toBe(0.5);
    expect(req.maxTokens).toBe(128);
  });

  it('flattens array user content to text and defaults maxTokens from the model', () => {
    const ctx: Context = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'part one ' },
            { type: 'text', text: 'part two' },
          ],
          timestamp: 0,
        },
      ],
    };
    const req = buildAfmRequest(model(), ctx);
    expect(req.prompt).toBe('part one part two');
    expect(req.instructions).toBeUndefined();
    expect(req.messages).toBeUndefined();
    expect(req.maxTokens).toBe(1024);
  });
});

/** A fake streamAfm that records its request, emits deltas, then resolves. */
function fakeStream(
  deltas: string[],
  result: { text?: string; usage?: { inputTokens?: number; outputTokens?: number } } = {},
): { fn: StreamAfmFn; seen: () => { request: AfmRequest; options?: StreamAfmOptions } } {
  let captured: { request: AfmRequest; options?: StreamAfmOptions } | undefined;
  const fn: StreamAfmFn = async (request, options) => {
    captured = { request, options };
    for (const d of deltas) options?.onDelta?.(d);
    return {
      text: result.text ?? deltas.join(''),
      ...(result.usage ? { usage: result.usage } : {}),
    };
  };
  return {
    fn,
    seen: () => {
      if (captured === undefined) throw new Error('streamAfm was never called');
      return captured;
    },
  };
}

const oneUser: Context = { messages: [{ role: 'user', content: 'hi', timestamp: 0 }] };

describe('createAfmStream — event mapping', () => {
  it('streams a single text block and maps usage on done', async () => {
    const fake = fakeStream(['Hel', 'lo'], { usage: { inputTokens: 3, outputTokens: 2 } });
    const streamSimple = createAfmStream({ streamAfmImpl: fake.fn });
    const events = await drain(streamSimple(model(), oneUser));

    const types = events.map((e) => e.type);
    expect(types).toEqual(['start', 'text_start', 'text_delta', 'text_delta', 'text_end', 'done']);
    const done = events.at(-1);
    if (done?.type !== 'done') throw new Error('expected done');
    expect(done.message.stopReason).toBe('stop');
    const text = done.message.content
      .filter((c) => c.type === 'text')
      .map((c) => (c.type === 'text' ? c.text : ''))
      .join('');
    expect(text).toBe('Hello');
    expect(done.message.usage.input).toBe(3);
    expect(done.message.usage.output).toBe(2);
    expect(done.message.usage.totalTokens).toBe(5);
  });

  it('passes the translated request + injected helperPath through to streamAfm', async () => {
    const fake = fakeStream(['ok']);
    const streamSimple = createAfmStream({ streamAfmImpl: fake.fn, helperPath: '/bin/pi-afm' });
    await drain(streamSimple(model(), oneUser));
    const { request, options } = fake.seen();
    expect(request.prompt).toBe('hi');
    expect(options?.helperPath).toBe('/bin/pi-afm');
  });

  it('emits no text block when the model returns nothing', async () => {
    const fake = fakeStream([]);
    const streamSimple = createAfmStream({ streamAfmImpl: fake.fn });
    const events = await drain(streamSimple(model(), oneUser));
    expect(events.map((e) => e.type)).toEqual(['start', 'done']);
  });

  it('surfaces an AfmError as an error event', async () => {
    const streamSimple = createAfmStream({
      streamAfmImpl: async () => {
        throw new AfmError('context window exceeded', true);
      },
    });
    const events = await drain(streamSimple(model(), oneUser));
    const last = events.at(-1);
    if (last?.type !== 'error') throw new Error('expected error event');
    expect(last.reason).toBe('error');
    expect(last.error.errorMessage).toContain('context window exceeded');
  });

  it('reports an aborted stop reason when the signal fires', async () => {
    const controller = new AbortController();
    controller.abort();
    const streamSimple = createAfmStream({
      streamAfmImpl: async () => {
        throw new AfmAbortError();
      },
    });
    const events = await drain(streamSimple(model(), oneUser, { signal: controller.signal }));
    const last = events.at(-1);
    if (last?.type !== 'error') throw new Error('expected error event');
    expect(last.reason).toBe('aborted');
  });
});
