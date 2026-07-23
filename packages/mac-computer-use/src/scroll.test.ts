import { describe, expect, it } from 'vitest';
import { DEFAULT_SCROLL_AMOUNT, MIN_SCROLL_AMOUNT, scrollAmount, scrollDelta } from './scroll';

describe('scrollAmount', () => {
  it('uses a meaningful default when unset / zero / non-finite', () => {
    expect(scrollAmount(undefined)).toBe(DEFAULT_SCROLL_AMOUNT);
    expect(scrollAmount(0)).toBe(DEFAULT_SCROLL_AMOUNT);
    expect(scrollAmount(Number.NaN)).toBe(DEFAULT_SCROLL_AMOUNT);
    expect(scrollAmount(Number.POSITIVE_INFINITY)).toBe(DEFAULT_SCROLL_AMOUNT);
  });
  it('floors tiny amounts so a scroll can never silently no-op', () => {
    expect(scrollAmount(5)).toBe(MIN_SCROLL_AMOUNT);
    expect(scrollAmount(1)).toBe(MIN_SCROLL_AMOUNT);
  });
  it('rounds and takes the magnitude of a real amount', () => {
    expect(scrollAmount(300)).toBe(300);
    expect(scrollAmount(299.6)).toBe(300);
    expect(scrollAmount(-450)).toBe(450);
  });
});

describe('scrollDelta (direction → signed pixel deltas)', () => {
  it('maps vertical directions with CGEvent sign convention', () => {
    // "down" reveals content below → negative dy; "up" → positive dy.
    expect(scrollDelta('down', 400)).toEqual({ dx: 0, dy: -400 });
    expect(scrollDelta('up', 400)).toEqual({ dx: 0, dy: 400 });
  });
  it('maps horizontal directions', () => {
    expect(scrollDelta('left', 200)).toEqual({ dx: 200, dy: 0 });
    expect(scrollDelta('right', 200)).toEqual({ dx: -200, dy: 0 });
  });
  it('applies the meaningful default when no amount is given', () => {
    expect(scrollDelta('down')).toEqual({ dx: 0, dy: -DEFAULT_SCROLL_AMOUNT });
  });
});
