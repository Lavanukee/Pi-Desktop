import { describe, expect, it } from 'vitest';
import { isLongThought, LONG_THINKING_THRESHOLD, thinkingLabel } from './shimmer.tsx';

describe('thinkingLabel', () => {
  it('is present tense while running', () => {
    expect(thinkingLabel('running')).toBe('Thinking…');
    expect(thinkingLabel('running', 12000)).toBe('Thinking…');
  });

  it('flips to past tense with a duration on done', () => {
    expect(thinkingLabel('done', 12000)).toBe('Thought for 12s');
    expect(thinkingLabel('done', 500)).toBe('Thought for 1s');
    expect(thinkingLabel('done', 0)).toBe('Thought for 0s');
  });

  it('formats durations over a minute as m/s', () => {
    expect(thinkingLabel('done', 65000)).toBe('Thought for 1m 5s');
    expect(thinkingLabel('done', 120000)).toBe('Thought for 2m');
  });

  it('falls back to a bare past-tense label without a duration', () => {
    expect(thinkingLabel('done')).toBe('Thought');
  });
});

describe('isLongThought', () => {
  it('is false for short / empty / non-string thoughts', () => {
    expect(isLongThought('a brief thought')).toBe(false);
    expect(isLongThought('')).toBe(false);
    expect(isLongThought(undefined)).toBe(false);
  });

  it('is true past the default threshold', () => {
    expect(isLongThought('x'.repeat(LONG_THINKING_THRESHOLD + 1))).toBe(true);
  });

  it('is false exactly at the threshold (strictly greater)', () => {
    expect(isLongThought('x'.repeat(LONG_THINKING_THRESHOLD))).toBe(false);
  });

  it('respects a custom threshold', () => {
    expect(isLongThought('hello world', 5)).toBe(true);
    expect(isLongThought('hi', 5)).toBe(false);
  });

  it('ignores surrounding whitespace when measuring length', () => {
    expect(isLongThought(`   ${'x'.repeat(3)}   `, 5)).toBe(false);
  });
});
