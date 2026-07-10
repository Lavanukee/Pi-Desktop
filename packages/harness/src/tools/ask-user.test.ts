import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@mariozechner/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import {
  ASK_USER_SENTINEL,
  type AskUserSpec,
  describeAnswer,
  encodeAskUser,
  registerAskUser,
  specFromParams,
} from './ask-user.js';

const SLIDER_SPEC: AskUserSpec = { v: 1, mode: 'slider', question: 'How many?', min: 0, max: 10 };

describe('encodeAskUser', () => {
  it('prefixes the sentinel and round-trips the spec JSON', () => {
    const encoded = encodeAskUser(SLIDER_SPEC);
    expect(encoded.startsWith(ASK_USER_SENTINEL)).toBe(true);
    expect(JSON.parse(encoded.slice(ASK_USER_SENTINEL.length))).toEqual(SLIDER_SPEC);
  });
});

describe('specFromParams', () => {
  it('defaults mode to choice and forwards option/slider fields', () => {
    const spec = specFromParams({
      question: 'Pick some',
      mode: 'multi',
      options: [{ value: 'a', label: 'A' }],
      min: 1,
      max: 5,
    });
    expect(spec).toMatchObject({ v: 1, mode: 'multi', question: 'Pick some', min: 1, max: 5 });
    expect(spec.options).toEqual([{ value: 'a', label: 'A' }]);
  });
});

describe('describeAnswer', () => {
  const choiceSpec: AskUserSpec = {
    v: 1,
    mode: 'multi',
    question: 'q',
    options: [
      { value: 'r', label: 'Red' },
      { value: 'g', label: 'Green' },
    ],
  };

  it('maps choice/multi values back to labels', () => {
    expect(describeAnswer(choiceSpec, JSON.stringify({ mode: 'choice', values: ['r', 'g'] }))).toBe(
      'Red, Green',
    );
  });

  it('reads a slider number and free text', () => {
    expect(describeAnswer(SLIDER_SPEC, JSON.stringify({ mode: 'slider', value: 7 }))).toBe('7');
    expect(
      describeAnswer(
        { v: 1, mode: 'free', question: 'q' },
        JSON.stringify({ mode: 'free', text: '  hi  ' }),
      ),
    ).toBe('hi');
  });

  it('falls back to a raw typed string (plain TUI, no decoder)', () => {
    expect(describeAnswer(SLIDER_SPEC, 'just text')).toBe('just text');
  });
});

describe('registerAskUser', () => {
  function captureTool() {
    let tool: ToolDefinition | undefined;
    const pi = {
      registerTool: (def: ToolDefinition) => {
        tool = def;
      },
    } as unknown as ExtensionAPI;
    return { pi, getTool: () => tool };
  }

  it('sends the encoded spec over input and reports the parsed answer', async () => {
    const input = vi.fn(async (_title: string, _placeholder?: string) =>
      JSON.stringify({ mode: 'choice', values: ['g'] }),
    );
    const ctx = { hasUI: true, ui: { input } } as unknown as ExtensionContext;
    const { pi, getTool } = captureTool();
    registerAskUser(pi);
    const tool = getTool();
    expect(tool?.name).toBe('ask_user');

    const result = await tool?.execute?.(
      'call',
      {
        question: 'Fav color?',
        mode: 'choice',
        options: [
          { value: 'r', label: 'Red' },
          { value: 'g', label: 'Green' },
        ],
      },
      undefined,
      undefined,
      ctx,
    );

    // The tool asked via input with a sentinel-encoded placeholder.
    expect(input).toHaveBeenCalledOnce();
    const placeholder = (input.mock.calls[0]?.[1] ?? '') as string;
    expect(placeholder.startsWith(ASK_USER_SENTINEL)).toBe(true);
    const text = (result?.content?.[0] as { text?: string })?.text ?? '';
    expect(text).toBe('User answered: Green');
  });

  it('reports a cancelled question (input returns undefined)', async () => {
    const input = vi.fn(async () => undefined);
    const ctx = { hasUI: true, ui: { input } } as unknown as ExtensionContext;
    const { pi, getTool } = captureTool();
    registerAskUser(pi);
    const result = await getTool()?.execute?.(
      'call',
      { question: 'q', mode: 'free' },
      undefined,
      undefined,
      ctx,
    );
    expect((result?.details as { cancelled?: boolean })?.cancelled).toBe(true);
  });
});
