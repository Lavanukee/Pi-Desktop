/**
 * Pure scroll-delta resolution for mac_scroll, extracted so it unit-tests in
 * plain Node and the "make the delta meaningful" logic lives in ONE place.
 *
 * A direction + a pixel amount become a signed (dx, dy) the helper posts as a
 * pixel-unit scroll wheel event. Sign convention matches CGEvent scroll wheels
 * (top-left screen space): a POSITIVE wheel1 scrolls the content UP (toward the
 * top), so "down" — reveal what's below — is a NEGATIVE dy. Likewise a positive
 * wheel2 scrolls content LEFT, so "right" is a negative dx.
 *
 * The default is deliberately larger than a single mouse "notch": a background
 * (pid-targeted) scroll of one tiny delta is easy for a modern momentum scroll
 * view to swallow, and jedd saw exactly that no-op. A meaningful default plus
 * the helper's stepped, continuous delivery is what actually moves the view.
 */

export type ScrollDirection = 'up' | 'down' | 'left' | 'right';

/** Meaningful default when the model doesn't specify an amount (roughly half a
 * screen of content — enough to visibly move even a coarse scroll view). */
export const DEFAULT_SCROLL_AMOUNT = 600;
/** Floor so a tiny/zero/negative amount can never silently no-op. */
export const MIN_SCROLL_AMOUNT = 40;

/** Clamp a requested scroll amount (pixels) to a meaningful positive integer. */
export function scrollAmount(amount?: number): number {
  const a = typeof amount === 'number' && Number.isFinite(amount) ? Math.abs(amount) : NaN;
  const chosen = Number.isNaN(a) || a === 0 ? DEFAULT_SCROLL_AMOUNT : a;
  return Math.max(MIN_SCROLL_AMOUNT, Math.round(chosen));
}

/** Resolve a direction (+ optional amount) into the signed pixel deltas the
 * helper posts. `dy` drives vertical scroll, `dx` horizontal. */
export function scrollDelta(
  direction: ScrollDirection,
  amount?: number,
): { dx: number; dy: number } {
  const m = scrollAmount(amount);
  switch (direction) {
    case 'up':
      return { dx: 0, dy: m };
    case 'down':
      return { dx: 0, dy: -m };
    case 'left':
      return { dx: m, dy: 0 };
    case 'right':
      return { dx: -m, dy: 0 };
    default:
      return { dx: 0, dy: -m };
  }
}
