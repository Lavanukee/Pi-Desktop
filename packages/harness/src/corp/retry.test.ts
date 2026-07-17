import { describe, expect, it, vi } from 'vitest';
import {
  isBlankFile,
  MANAGER_EMPTY_RETRY_NUDGE,
  type RetryTurn,
  withRetryOnEmpty,
} from './retry.js';

describe('withRetryOnEmpty', () => {
  it('does NOT retry when the first turn is non-empty', async () => {
    const run = vi.fn((_turn: RetryTurn) => ['c1', 'c2']);
    const result = await withRetryOnEmpty({ run, isEmpty: (c) => c.length === 0 });

    expect(result.value).toEqual(['c1', 'c2']);
    expect(result.attempts).toBe(1);
    expect(result.retried).toBe(false);
    expect(result.emptyAfterRetry).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toEqual({ attempt: 1, isRetry: false });
  });

  it('retries ONCE on an empty first turn and takes the retry when it succeeds', async () => {
    // First turn empty, retry non-empty — the manager "0 contracts → nudge → ok" path.
    const run = vi.fn((turn: RetryTurn) => (turn.isRetry ? ['recovered'] : ([] as string[])));
    const result = await withRetryOnEmpty({ run, isEmpty: (c) => c.length === 0 });

    expect(result.value).toEqual(['recovered']);
    expect(result.attempts).toBe(2);
    expect(result.retried).toBe(true);
    expect(result.emptyAfterRetry).toBe(false);
    expect(run).toHaveBeenCalledTimes(2);
    // The retry turn is flagged so the caller can vary it (append a nudge, flip thinking).
    expect(run.mock.calls[1]?.[0]).toEqual({ attempt: 2, isRetry: true });
  });

  it('records emptyAfterRetry when BOTH turns are empty (never silently drops)', async () => {
    const run = vi.fn((_turn: RetryTurn) => [] as string[]);
    const result = await withRetryOnEmpty({ run, isEmpty: (c) => c.length === 0 });

    expect(result.value).toEqual([]);
    expect(result.attempts).toBe(2);
    expect(result.retried).toBe(true);
    expect(result.emptyAfterRetry).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('works with a string/file predicate and awaits an async run', async () => {
    // Engineer path: whitespace-only draft → retry (thinking off) → real file.
    const run = vi.fn(async (turn: RetryTurn) =>
      turn.isRetry ? 'export const x = 1;\n' : '   \n  ',
    );
    const result = await withRetryOnEmpty({ run, isEmpty: isBlankFile });

    expect(result.value).toBe('export const x = 1;\n');
    expect(result.emptyAfterRetry).toBe(false);
    expect(result.retried).toBe(true);
  });

  it('reports emptyAfterRetry for an engineer that stays blank after the retry', async () => {
    const run = vi.fn(async (_turn: RetryTurn) => '   ');
    const result = await withRetryOnEmpty({ run, isEmpty: isBlankFile });
    expect(result.emptyAfterRetry).toBe(true);
    expect(result.value).toBe('   ');
  });
});

describe('isBlankFile', () => {
  it('treats whitespace-only and non-strings as blank', () => {
    expect(isBlankFile('')).toBe(true);
    expect(isBlankFile('   \n\t')).toBe(true);
    expect(isBlankFile(undefined)).toBe(true);
    expect(isBlankFile(null)).toBe(true);
    expect(isBlankFile('export const x = 1;')).toBe(false);
  });
});

describe('MANAGER_EMPTY_RETRY_NUDGE', () => {
  it('is a non-empty nudge that asks for a non-empty contract array', () => {
    expect(MANAGER_EMPTY_RETRY_NUDGE.length).toBeGreaterThan(0);
    expect(MANAGER_EMPTY_RETRY_NUDGE.toLowerCase()).toContain('contract');
    expect(MANAGER_EMPTY_RETRY_NUDGE.toLowerCase()).toContain('do not return an empty list');
  });
});
