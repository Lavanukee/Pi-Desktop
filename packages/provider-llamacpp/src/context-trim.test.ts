import type { Context, Message } from '@mariozechner/pi-ai';
import { describe, expect, it } from 'vitest';
import {
  cleanProviderError,
  estimateTokens,
  OVERFLOW_TRIM_PLACEHOLDER,
  parseContextOverflow,
  trimContextForOverflow,
} from './context-trim.js';

/** A tool-result message whose text is `chars` long (so token cost is known). */
function toolResult(id: string, chars: number): Message {
  return {
    role: 'toolResult',
    toolCallId: id,
    toolName: 'bash',
    content: [{ type: 'text', text: 'x'.repeat(chars) }],
    isError: false,
    timestamp: 0,
  };
}

const user = (text: string): Message => ({ role: 'user', content: text, timestamp: 0 });

function ctx(messages: Message[]): Context {
  return { systemPrompt: 'sys', messages, tools: [] };
}

/** Text of the tool-result message at `i` (test-only accessor). */
function textAt(context: Context, i: number): string {
  const msg = context.messages[i];
  if (msg === undefined || msg.role !== 'toolResult') throw new Error(`no toolResult at ${i}`);
  const part = msg.content[0];
  return part !== undefined && part.type === 'text' ? part.text : '';
}

describe('parseContextOverflow', () => {
  it('parses the structured exceed_context_size_error body', () => {
    const body = JSON.stringify({
      error: {
        code: 400,
        message: 'request (32978 tokens) exceeds the available context size (32768 tokens)',
        type: 'exceed_context_size_error',
        n_prompt_tokens: 32978,
        n_ctx: 32768,
      },
    });
    expect(parseContextOverflow(body)).toEqual({ nCtx: 32768, nPromptTokens: 32978 });
  });

  it('falls back to the human message when the fields are absent', () => {
    const body =
      'request (40000 tokens) exceeds the available context size (32768 tokens), try increasing it';
    expect(parseContextOverflow(body)).toEqual({ nCtx: 32768, nPromptTokens: 40000 });
  });

  it('returns undefined for a non-overflow error', () => {
    expect(parseContextOverflow('{"error":{"message":"bad request","code":400}}')).toBeUndefined();
    expect(parseContextOverflow('Internal Server Error')).toBeUndefined();
    expect(parseContextOverflow('')).toBeUndefined();
  });
});

describe('trimContextForOverflow', () => {
  it('drops the OLDEST tool results first, preserving user messages + recent turns', () => {
    const messages = [
      user('do a thing'),
      toolResult('t1', 8_000), // oldest, ~2000 tok
      user('and another'),
      toolResult('t2', 8_000), // ~2000 tok
      toolResult('t3', 8_000), // newest
    ];
    // Ask for ~2000 tokens: exactly the first tool result should go.
    const { context, trimmedCount } = trimContextForOverflow(ctx(messages), 1_500);
    expect(trimmedCount).toBe(1);
    // Oldest tool result trimmed…
    expect(textAt(context, 1)).toBe(OVERFLOW_TRIM_PLACEHOLDER);
    // …newer ones and every user message untouched.
    expect(textAt(context, 3)).toHaveLength(8_000);
    expect(textAt(context, 4)).toHaveLength(8_000);
    expect(context.messages[0]).toEqual(messages[0]);
    expect(context.messages[2]).toEqual(messages[2]);
  });

  it('keeps shedding across multiple passes until the target is met (idempotent)', () => {
    const messages = [toolResult('t1', 8_000), toolResult('t2', 8_000), toolResult('t3', 8_000)];
    // Target > one result → two get trimmed in a single pass.
    const pass1 = trimContextForOverflow(ctx(messages), 3_000);
    expect(pass1.trimmedCount).toBe(2);
    // A second pass over the already-trimmed context skips placeholders and trims
    // only the still-full one.
    const pass2 = trimContextForOverflow(pass1.context, 3_000);
    expect(pass2.trimmedCount).toBe(1);
    // Everything is now a placeholder → a third pass is a no-op (never loops forever).
    const pass3 = trimContextForOverflow(pass2.context, 3_000);
    expect(pass3.trimmedCount).toBe(0);
    expect(pass3.context).toBe(pass2.context);
  });

  it('is a no-op (returns the same context) when there is nothing to trim', () => {
    const messages = [user('hi'), toolResult('t', 4)]; // tiny result — not worth trimming
    const input = ctx(messages);
    const result = trimContextForOverflow(input, 5_000);
    expect(result.trimmedCount).toBe(0);
    expect(result.removedTokens).toBe(0);
    expect(result.context).toBe(input);
  });

  it('does not mutate the input context', () => {
    const messages = [toolResult('t', 8_000)];
    const input = ctx(messages);
    trimContextForOverflow(input, 1_000);
    expect(textAt(input, 0)).toHaveLength(8_000);
  });
});

describe('estimateTokens', () => {
  it('is chars / 4 rounded up', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});

describe('cleanProviderError', () => {
  it('never contains a raw HTTP/JSON blob', () => {
    const overflow = cleanProviderError(400, { nCtx: 32768, nPromptTokens: 40000 });
    expect(overflow).toContain('too long');
    expect(overflow).not.toContain('{');
    expect(overflow).not.toContain('n_ctx');

    const generic = cleanProviderError(500, undefined);
    expect(generic).toContain('HTTP 500');
    expect(generic).not.toContain('{');
  });
});
