import { describe, expect, it, vi } from 'vitest';
import type { CallModel } from '../model-call/call-model.js';
import { adversarialCheck, parseReview, reviewOutput } from './review.js';

describe('parseReview', () => {
  it('parses a clean pass', () => {
    expect(parseReview('{"ok":true,"issues":[]}')).toMatchObject({ ok: true, issues: [] });
  });
  it('parses a flagged result with issues', () => {
    const r = parseReview('The result is wrong. {"ok":false,"issues":["missing edge case"]}');
    expect(r.ok).toBe(false);
    expect(r.issues).toEqual(['missing edge case']);
  });
  it('fails open on unparseable output', () => {
    expect(parseReview('lgtm').ok).toBe(true);
  });
});

describe('reviewOutput / adversarialCheck', () => {
  it('flags a bad result', async () => {
    const callModel: CallModel = vi.fn(async () => '{"ok":false,"issues":["off-by-one"]}');
    const r = await reviewOutput(callModel, { task: 'sum', output: 'wrong' });
    expect(r.ok).toBe(false);
    expect(r.issues).toContain('off-by-one');
  });

  it('passes a good result', async () => {
    const callModel: CallModel = vi.fn(async () => '{"ok":true,"issues":[]}');
    const r = await adversarialCheck(callModel, { task: 'sum', output: '4' });
    expect(r.ok).toBe(true);
  });

  it('fails open when the model call throws', async () => {
    const callModel: CallModel = vi.fn(async () => {
      throw new Error('offline');
    });
    const r = await reviewOutput(callModel, { task: 't', output: 'o' });
    expect(r.ok).toBe(true);
  });
});

/**
 * The reviewer runs after EVERY turn from `medium` effort up, on the same
 * single-slot llama-server the chat uses. If its request does not start with the
 * conversation's own prefix, the server evicts that conversation to prefill the
 * critique and the user's next message pays a full cold prefill. MEASURED on the
 * shipped build before this: first message 274ms, follow-ups 4015-8096ms.
 */
describe('the critique rides the conversation prefix instead of evicting it', () => {
  const convo = [
    { role: 'system' as const, content: 'CANONICAL SYSTEM PROMPT' },
    { role: 'user' as const, content: 'hi' },
    { role: 'assistant' as const, content: 'hello' },
  ];
  const tools = [{ name: 'bash', description: 'run a command' }];

  it('sends the conversation + tools, and puts the role in the USER turn', async () => {
    const calls: Parameters<CallModel>[0][] = [];
    const callModel: CallModel = vi.fn(async (req) => {
      calls.push(req);
      return '{"ok":true,"issues":[]}';
    });
    await reviewOutput(callModel, {
      task: 'hi',
      output: 'hello',
      priorMessages: convo,
      tools,
    });
    const req = calls[0];
    if (req === undefined) throw new Error('the reviewer made no model call');
    // The system message must be the conversation's, byte for byte: it is the
    // first thing the template renders, so changing it invalidates everything.
    expect(req.messages).toEqual(convo);
    expect(req.system).toBeUndefined();
    expect(req.tools).toEqual(tools);
    // The reviewer's role instruction rides along in the appended user turn.
    expect(req.prompt).toContain('meticulous senior reviewer');
    expect(req.prompt).toContain('hello');
    // And it must not sit on the slot thinking before a two-field JSON verdict.
    expect(req.extraBody).toMatchObject({ chat_template_kwargs: { enable_thinking: false } });
    expect(req.maxTokens).toBeGreaterThan(0);
  });

  it('falls back to a standalone request when given no conversation', async () => {
    const calls: Parameters<CallModel>[0][] = [];
    const callModel: CallModel = vi.fn(async (req) => {
      calls.push(req);
      return '{"ok":true,"issues":[]}';
    });
    await adversarialCheck(callModel, { task: 't', output: 'o' });
    const req = calls[0];
    if (req === undefined) throw new Error('the reviewer made no model call');
    expect(req.system).toContain('adversarial');
    expect(req.messages).toBeUndefined();
  });

  it('still reports issues when riding the prefix', async () => {
    const callModel: CallModel = vi.fn(async () => '{"ok":false,"issues":["missing test"]}');
    const r = await reviewOutput(callModel, {
      task: 'hi',
      output: 'hello',
      priorMessages: convo,
      tools,
    });
    expect(r.ok).toBe(false);
    expect(r.issues).toContain('missing test');
  });
});

/**
 * The user outranks everything running behind them. The critique sits on the
 * single llama-server slot, so a follow-up typed the instant a reply finished
 * queues behind it — MEASURED at 1255ms against 256ms for the chat's first
 * message. before_agent_start aborts it; this is the wiring that makes that
 * abort actually reach the request.
 */
describe('the critique yields to the user', () => {
  it('passes the abort signal down to the model call', async () => {
    const calls: Parameters<CallModel>[0][] = [];
    const callModel: CallModel = vi.fn(async (req) => {
      calls.push(req);
      return '{"ok":true,"issues":[]}';
    });
    const controller = new AbortController();
    await reviewOutput(callModel, { task: 't', output: 'o', signal: controller.signal });
    expect(calls[0]?.signal).toBe(controller.signal);
  });

  it('fails open when the call is aborted — never a spurious revision', async () => {
    const callModel: CallModel = vi.fn(async () => {
      throw new DOMException('aborted', 'AbortError');
    });
    const r = await reviewOutput(callModel, { task: 't', output: 'o' });
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
  });
});
