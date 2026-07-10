import { afterEach, describe, expect, it, vi } from 'vitest';
import { COPY_FEEDBACK_MS, scheduleCopyReset } from './copy-button.tsx';

/**
 * Copy-feedback timing (jedd round-5 #21): a copy shows the check for ~2s, then
 * reverts. `scheduleCopyReset` is the hook's only timing primitive, so the dwell
 * + cancellation are testable here with fake timers — no DOM required.
 */
describe('copy feedback timing', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('defaults the dwell to ~2 seconds', () => {
    expect(COPY_FEEDBACK_MS).toBe(2000);
  });

  it('reverts exactly at the timeout, not before', () => {
    vi.useFakeTimers();
    let reverted = false;
    scheduleCopyReset(() => {
      reverted = true;
    });
    vi.advanceTimersByTime(1999);
    expect(reverted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(reverted).toBe(true);
  });

  it('honors a custom timeout', () => {
    vi.useFakeTimers();
    let reverted = false;
    scheduleCopyReset(() => {
      reverted = true;
    }, 500);
    vi.advanceTimersByTime(499);
    expect(reverted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(reverted).toBe(true);
  });

  it('cancel() prevents the revert (rapid re-copy / unmount)', () => {
    vi.useFakeTimers();
    let reverted = false;
    const cancel = scheduleCopyReset(() => {
      reverted = true;
    });
    cancel();
    vi.advanceTimersByTime(COPY_FEEDBACK_MS * 2);
    expect(reverted).toBe(false);
  });
});
