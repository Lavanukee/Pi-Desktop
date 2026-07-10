import { describe, expect, it } from 'vitest';
import { isSmallModel, parseModelParams, smallModelWarning } from './model-size.js';

describe('parseModelParams', () => {
  const cases: [string, number | null][] = [
    ['qwen3.6-27b', 27],
    ['qwen3.6-35b-a3b', 35],
    ['gemma4-e2b', 2],
    ['gemma4-e4b', 4],
    ['gemma4-12b', 12],
    ['llama-3.1-8b-instruct', 8],
    ['Mistral-7B', 7],
    ['phi-3.8b', 3.8],
    ['claude-opus', null],
    ['some-random-model', null],
  ];
  for (const [id, expected] of cases) {
    it(`${id} → ${expected}`, () => {
      expect(parseModelParams(id)).toBe(expected);
    });
  }
});

describe('isSmallModel', () => {
  it('treats ≤12B as small', () => {
    expect(isSmallModel({ id: 'gemma4-12b' })).toBe(true);
    expect(isSmallModel({ id: 'gemma4-e2b' })).toBe(true);
    expect(isSmallModel({ id: 'llama-3.1-8b' })).toBe(true);
  });

  it('treats >12B as not small', () => {
    expect(isSmallModel({ id: 'qwen3.6-27b' })).toBe(false);
    expect(isSmallModel({ id: 'qwen3.6-35b-a3b' })).toBe(false);
  });

  it('unknown size is not treated as small', () => {
    expect(isSmallModel({ id: 'mystery-model' })).toBe(false);
  });

  it('honours a custom threshold', () => {
    expect(isSmallModel({ id: 'llama-3.1-8b' }, 4)).toBe(false);
    expect(isSmallModel({ id: 'gemma4-e2b' }, 4)).toBe(true);
  });
});

describe('smallModelWarning', () => {
  it('warns for a small model on an advanced class', () => {
    expect(smallModelWarning({ id: 'gemma4-e2b', name: 'Gemma4 E2B' }, '3d')).toContain('small');
  });

  it('does not warn for a large model on an advanced class', () => {
    expect(smallModelWarning({ id: 'qwen3.6-27b' }, '3d')).toBeNull();
  });

  it('does not warn for a small model on a simple class', () => {
    expect(smallModelWarning({ id: 'gemma4-e2b' }, 'simple-QA')).toBeNull();
    expect(smallModelWarning({ id: 'gemma4-e2b' }, 'basic-tools')).toBeNull();
  });

  it('warns on full-shebang with a small model', () => {
    expect(smallModelWarning({ id: 'llama-3.1-8b' }, 'full-shebang')).not.toBeNull();
  });
});
