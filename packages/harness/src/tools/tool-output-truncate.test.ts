import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_OUTPUT_TOKENS, truncateToolOutput } from './tool-output-truncate.js';

describe('truncateToolOutput', () => {
  it('passes short output through untouched', () => {
    const r = truncateToolOutput('a small result\nsecond line');
    expect(r.truncated).toBe(false);
    expect(r.removedChars).toBe(0);
    expect(r.text).toBe('a small result\nsecond line');
  });

  it('caps a huge output to ~the token budget and marks it truncated', () => {
    // ~24k tokens of `ls -R`-style lines (the observed context-blowing case).
    const line = 'src/components/widgets/Button.tsx\n';
    const huge = line.repeat(3000); // ~100k chars
    const r = truncateToolOutput(huge);
    expect(r.truncated).toBe(true);
    expect(r.removedChars).toBeGreaterThan(0);
    // Kept text is bounded near the budget (chars ≈ maxTokens * 4, + the marker).
    expect(r.text.length).toBeLessThan(DEFAULT_MAX_OUTPUT_TOKENS * 4 + 500);
    expect(r.text).toContain('truncated');
    expect(r.text).toContain('narrow the command');
  });

  it('keeps BOTH the head and the tail (error/exit often lands at the tail)', () => {
    const body = 'MIDDLE-NOISE\n'.repeat(5000);
    const text = `HEAD-START\n${body}TAIL-ERROR: exit 1`;
    const r = truncateToolOutput(text);
    expect(r.truncated).toBe(true);
    expect(r.text).toContain('HEAD-START');
    expect(r.text).toContain('TAIL-ERROR: exit 1');
    // The bulk of the middle is elided — most MIDDLE-NOISE lines are gone.
    const kept = (r.text.match(/MIDDLE-NOISE/g) ?? []).length;
    expect(kept).toBeLessThan(5000 * 0.5);
    // The marker sits between the head and the tail.
    expect(r.text.indexOf('HEAD-START')).toBeLessThan(r.text.indexOf('truncated'));
    expect(r.text.indexOf('truncated')).toBeLessThan(r.text.indexOf('TAIL-ERROR'));
  });

  it('respects a custom maxTokens', () => {
    const huge = 'x'.repeat(50_000);
    const small = truncateToolOutput(huge, { maxTokens: 100 });
    const big = truncateToolOutput(huge, { maxTokens: 4000 });
    expect(small.text.length).toBeLessThan(big.text.length);
  });
});
