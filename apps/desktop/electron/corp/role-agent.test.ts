import { describe, expect, it } from 'vitest';
import {
  applySamplingMode,
  collectFilesWritten,
  countAssistantTurns,
  createStepCapCounter,
  deriveTerminatedReason,
  maxTurnOutputTokens,
  type RoleAgentToolCall,
  SAMPLING_MODES,
  type SamplingMode,
  type StripMessage,
  stripPriorThinking,
} from './role-agent';

describe('SAMPLING_MODES — the owner qwen params, verbatim', () => {
  it('thinking-general', () => {
    expect(SAMPLING_MODES['thinking-general']).toEqual({
      temperature: 1.0,
      top_p: 0.95,
      top_k: 20,
      min_p: 0.0,
      presence_penalty: 1.5,
      repetition_penalty: 1.0,
    });
  });

  it('thinking-coding (presence_penalty 0, temp 0.6)', () => {
    expect(SAMPLING_MODES['thinking-coding']).toEqual({
      temperature: 0.6,
      top_p: 0.95,
      top_k: 20,
      min_p: 0.0,
      presence_penalty: 0.0,
      repetition_penalty: 1.0,
    });
  });

  it('instruct-general (temp 0.7, top_p 0.8)', () => {
    expect(SAMPLING_MODES['instruct-general']).toEqual({
      temperature: 0.7,
      top_p: 0.8,
      top_k: 20,
      min_p: 0.0,
      presence_penalty: 1.5,
      repetition_penalty: 1.0,
    });
  });

  it('instruct-reasoning (temp 1.0, top_p 0.95)', () => {
    expect(SAMPLING_MODES['instruct-reasoning']).toEqual({
      temperature: 1.0,
      top_p: 0.95,
      top_k: 20,
      min_p: 0.0,
      presence_penalty: 1.5,
      repetition_penalty: 1.0,
    });
  });
});

describe('applySamplingMode — the payload merge per mode', () => {
  const modes: SamplingMode[] = [
    'thinking-coding',
    'thinking-general',
    'instruct-general',
    'instruct-reasoning',
  ];

  for (const mode of modes) {
    it(`stamps the exact ${mode} params onto the payload`, () => {
      const payload: Record<string, unknown> = { model: 'x', stream: true, messages: [] };
      const out = applySamplingMode(payload, mode) as Record<string, unknown>;
      const expected = SAMPLING_MODES[mode];
      expect(out.temperature).toBe(expected.temperature);
      expect(out.top_p).toBe(expected.top_p);
      expect(out.top_k).toBe(expected.top_k);
      expect(out.min_p).toBe(expected.min_p);
      expect(out.presence_penalty).toBe(expected.presence_penalty);
      expect(out.repetition_penalty).toBe(expected.repetition_penalty);
      // Pre-existing keys are preserved.
      expect(out.model).toBe('x');
      expect(out.stream).toBe(true);
    });
  }

  it('mutates in place and returns the same object (the hook replaces it)', () => {
    const payload: Record<string, unknown> = {};
    const out = applySamplingMode(payload, 'thinking-coding');
    expect(out).toBe(payload);
    expect((payload as Record<string, unknown>).temperature).toBe(0.6);
  });

  it('overrides any params the provider pre-set', () => {
    const payload = { temperature: 0.2, top_p: 0.1, top_k: 100 };
    applySamplingMode(payload, 'instruct-general');
    expect(payload.temperature).toBe(0.7);
    expect(payload.top_p).toBe(0.8);
    expect(payload.top_k).toBe(20);
  });

  it('passes non-object payloads through untouched', () => {
    expect(applySamplingMode(undefined, 'thinking-coding')).toBeUndefined();
    expect(applySamplingMode(null, 'thinking-coding')).toBeNull();
    expect(applySamplingMode('raw', 'thinking-coding')).toBe('raw');
  });
});

describe('createStepCapCounter — the hard tool-call cap', () => {
  it('allows up to maxSteps calls, blocks past it, and records the hit', () => {
    const cap = createStepCapCounter(3);
    expect(cap.charge()).toBeUndefined(); // 1
    expect(cap.charge()).toBeUndefined(); // 2
    expect(cap.charge()).toBeUndefined(); // 3
    expect(cap.hit).toBe(false);
    const blocked = cap.charge(); // 4 — over the cap
    expect(blocked).toEqual({ block: true, reason: 'step cap (3) reached' });
    expect(cap.hit).toBe(true);
    expect(cap.count).toBe(4);
  });

  it('keeps blocking every call after the cap', () => {
    const cap = createStepCapCounter(1);
    expect(cap.charge()).toBeUndefined();
    expect(cap.charge()?.block).toBe(true);
    expect(cap.charge()?.block).toBe(true);
    expect(cap.count).toBe(3);
  });

  it('defaults to a cap of 20', () => {
    const cap = createStepCapCounter();
    for (let i = 0; i < 20; i++) expect(cap.charge()).toBeUndefined();
    expect(cap.charge()?.reason).toBe('step cap (20) reached');
  });
});

describe('stripPriorThinking — preserve-thinking OFF', () => {
  it('removes thinking blocks from assistant messages, keeping text/toolCall', () => {
    const messages: StripMessage[] = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'lots of scratchpad' },
          { type: 'text', text: 'the answer' },
          { type: 'toolCall', name: 'write' },
        ],
      },
    ];
    const { messages: out, strippedBlocks } = stripPriorThinking(messages);
    expect(strippedBlocks).toBe(1);
    expect(out[1]?.content).toEqual([
      { type: 'text', text: 'the answer' },
      { type: 'toolCall', name: 'write' },
    ]);
    // The user message is untouched (same reference).
    expect(out[0]).toBe(messages[0]);
  });

  it('never empties a message: an all-thinking turn is left as-is', () => {
    const messages: StripMessage[] = [
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'only thoughts' }] },
    ];
    const { messages: out, strippedBlocks } = stripPriorThinking(messages);
    expect(strippedBlocks).toBe(0);
    expect(out[0]).toBe(messages[0]);
    expect(out).toHaveLength(1);
  });

  it('ignores user messages and non-array content', () => {
    const messages: StripMessage[] = [
      { role: 'user', content: [{ type: 'thinking', thinking: 'x' }] },
      { role: 'assistant', content: 'plain string' },
    ];
    const { strippedBlocks } = stripPriorThinking(messages);
    expect(strippedBlocks).toBe(0);
  });
});

describe('collectFilesWritten — result shaping from mock write/edit tool events', () => {
  const cwd = '/ws';
  const statBytes = (abs: string): number | undefined => {
    const sizes: Record<string, number> = {
      '/ws/src/util/clamp.ts': 512,
      '/ws/src/engine/vec3.ts': 1024,
      '/abs/only.ts': 42,
    };
    return sizes[abs];
  };

  it('maps write/edit calls to {path,bytes}, resolving relative paths against cwd', () => {
    const calls: RoleAgentToolCall[] = [
      { name: 'read', arguments: { path: 'src/util/clamp.ts' } },
      { name: 'write', arguments: { path: 'src/util/clamp.ts', content: 'export ...' } },
      { name: 'edit', arguments: { path: 'src/engine/vec3.ts', oldText: 'a', newText: 'b' } },
    ];
    const files = collectFilesWritten(calls, statBytes, cwd);
    expect(files).toEqual([
      { path: 'src/util/clamp.ts', bytes: 512 },
      { path: 'src/engine/vec3.ts', bytes: 1024 },
    ]);
  });

  it('drops calls whose target cannot be stat’d (never written)', () => {
    const calls: RoleAgentToolCall[] = [
      { name: 'write', arguments: { path: 'src/missing.ts', content: 'x' } },
    ];
    expect(collectFilesWritten(calls, statBytes, cwd)).toEqual([]);
  });

  it('dedupes by path — the last write wins', () => {
    const bytesFor = (abs: string): number | undefined => (abs === '/ws/a.ts' ? 99 : undefined);
    const calls: RoleAgentToolCall[] = [
      { name: 'write', arguments: { path: 'a.ts', content: 'v1' } },
      { name: 'write', arguments: { path: 'a.ts', content: 'v2-longer' } },
    ];
    const files = collectFilesWritten(calls, bytesFor, cwd);
    expect(files).toEqual([{ path: 'a.ts', bytes: 99 }]);
  });

  it('honours absolute paths and decodes JSON-string arguments', () => {
    const calls: RoleAgentToolCall[] = [
      { name: 'write', arguments: JSON.stringify({ path: '/abs/only.ts', content: 'x' }) },
    ];
    expect(collectFilesWritten(calls, statBytes, cwd)).toEqual([
      { path: '/abs/only.ts', bytes: 42 },
    ]);
  });

  it('accepts a file_path alias and ignores pathless calls', () => {
    const bytesFor = (abs: string): number | undefined =>
      abs === '/ws/aliased.ts' ? 7 : undefined;
    const calls: RoleAgentToolCall[] = [
      { name: 'write', arguments: { file_path: 'aliased.ts', content: 'x' } },
      { name: 'write', arguments: { content: 'no path' } },
    ];
    expect(collectFilesWritten(calls, bytesFor, cwd)).toEqual([{ path: 'aliased.ts', bytes: 7 }]);
  });
});

describe('deriveTerminatedReason — the backstop precedence', () => {
  it('clean stop', () => {
    expect(deriveTerminatedReason({ timedOut: false, stepCapHit: false, promptError: false })).toBe(
      'stop',
    );
  });
  it('timeout wins over a co-occurring abort error', () => {
    expect(deriveTerminatedReason({ timedOut: true, stepCapHit: false, promptError: true })).toBe(
      'timeout',
    );
  });
  it('step-cap over a plain error', () => {
    expect(deriveTerminatedReason({ timedOut: false, stepCapHit: true, promptError: true })).toBe(
      'step-cap',
    );
  });
  it('genuine error', () => {
    expect(deriveTerminatedReason({ timedOut: false, stepCapHit: false, promptError: true })).toBe(
      'error',
    );
  });
});

describe('turn / token roll-ups', () => {
  const messages = [
    { role: 'user' },
    { role: 'assistant', usage: { output: 1281 } },
    { role: 'toolResult' },
    { role: 'assistant', usage: { output: 640 } },
    { role: 'assistant' }, // no usage
  ];

  it('counts assistant turns', () => {
    expect(countAssistantTurns(messages)).toBe(3);
  });

  it('reports the largest single-turn output tokens (runaway detector)', () => {
    expect(maxTurnOutputTokens(messages)).toBe(1281);
  });

  it('is 0 with no assistant usage', () => {
    expect(maxTurnOutputTokens([{ role: 'user' }, { role: 'assistant' }])).toBe(0);
  });
});
