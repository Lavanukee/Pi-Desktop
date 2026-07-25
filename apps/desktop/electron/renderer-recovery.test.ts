import { describe, expect, it, vi } from 'vitest';
import {
  CRASH_COOLDOWN_MS,
  createRendererRecovery,
  MAX_CONSECUTIVE_RECOVERIES,
  type RendererRecoveryDeps,
} from './renderer-recovery';

function harness(overrides: Partial<RendererRecoveryDeps> = {}) {
  let clock = 1_000_000;
  const reload = vi.fn();
  const log = vi.fn();
  const recovery = createRendererRecovery({
    reload,
    isDestroyed: () => false,
    now: () => clock,
    log,
    ...overrides,
  });
  return {
    recovery,
    reload,
    log,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('createRendererRecovery', () => {
  it('reloads the window when the renderer dies (the blank-screen brick)', () => {
    const h = harness();
    expect(h.recovery.onRenderProcessGone({ reason: 'crashed', exitCode: 139 })).toBe('reloaded');
    expect(h.reload).toHaveBeenCalledTimes(1);
  });

  it('recovers an OOM death — the likeliest cause on a huge mesh', () => {
    const h = harness();
    expect(h.recovery.onRenderProcessGone({ reason: 'oom' })).toBe('reloaded');
    expect(h.reload).toHaveBeenCalledTimes(1);
  });

  it('ignores a clean exit (quit / deliberate teardown is not a crash)', () => {
    const h = harness();
    expect(h.recovery.onRenderProcessGone({ reason: 'clean-exit' })).toBe('ignored');
    expect(h.reload).not.toHaveBeenCalled();
  });

  it('ignores a destroyed WebContents (nothing left to reload)', () => {
    const h = harness({ isDestroyed: () => true });
    expect(h.recovery.onRenderProcessGone({ reason: 'crashed' })).toBe('ignored');
    expect(h.reload).not.toHaveBeenCalled();
  });

  it('stops after repeated rapid deaths instead of reload-storming', () => {
    const h = harness();
    for (let i = 0; i < MAX_CONSECUTIVE_RECOVERIES; i++) {
      expect(h.recovery.onRenderProcessGone({ reason: 'crashed' })).toBe('reloaded');
      h.advance(100); // well inside the cooldown → counts as the same failure
    }
    expect(h.recovery.onRenderProcessGone({ reason: 'crashed' })).toBe('gave-up');
    expect(h.reload).toHaveBeenCalledTimes(MAX_CONSECUTIVE_RECOVERIES);
    expect(h.log).toHaveBeenCalledWith(
      expect.stringContaining('giving up'),
      expect.objectContaining({ reason: 'crashed' }),
    );
  });

  it('a later, unrelated crash recovers again (the streak resets after the cooldown)', () => {
    const h = harness();
    for (let i = 0; i < MAX_CONSECUTIVE_RECOVERIES + 1; i++) {
      h.recovery.onRenderProcessGone({ reason: 'crashed' });
      h.advance(100);
    }
    h.reload.mockClear();
    h.advance(CRASH_COOLDOWN_MS + 1);
    expect(h.recovery.onRenderProcessGone({ reason: 'crashed' })).toBe('reloaded');
    expect(h.reload).toHaveBeenCalledTimes(1);
  });
});
