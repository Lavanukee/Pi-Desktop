import { describe, expect, it } from 'vitest';
import { BRIDGE_EXIT_TOAST, isBridgeExitNotice } from './toast-policy';

/**
 * Round-blindtest #11: a pi crash used to stack TWO red toasts — a raw
 * "pi exited (143)." error next to "Pi stopped". These pin the dedupe rule (the
 * raw crash line is recognized so ToastHost can drop it) and the humanized copy
 * (never a raw signal/exit code), leaving ONE friendly toast + a Restart action.
 */
describe('isBridgeExitNotice', () => {
  it('matches the router\'s raw "pi exited (<code>)." crash line', () => {
    expect(isBridgeExitNotice('pi exited (143).')).toBe(true);
    expect(isBridgeExitNotice('pi exited (1).')).toBe(true);
    expect(isBridgeExitNotice('pi exited (SIGTERM).')).toBe(true);
  });

  it('does NOT match ordinary errors (those still surface)', () => {
    expect(isBridgeExitNotice('Model failed to load')).toBe(false);
    expect(isBridgeExitNotice('Network error')).toBe(false);
    expect(isBridgeExitNotice('the pi exited early')).toBe(false);
  });
});

describe('BRIDGE_EXIT_TOAST copy', () => {
  it('is humanized — never leaks a raw signal/exit code', () => {
    const text = `${BRIDGE_EXIT_TOAST.title} ${BRIDGE_EXIT_TOAST.description}`;
    expect(text).not.toMatch(/\d{2,3}/); // no "143"/"SIGTERM"-style codes
    expect(text).not.toMatch(/exited|signal|SIG[A-Z]+/i);
    expect(BRIDGE_EXIT_TOAST.title.length).toBeGreaterThan(0);
    expect(BRIDGE_EXIT_TOAST.description).toMatch(/restart/i);
  });
});
