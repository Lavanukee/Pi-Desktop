import { describe, expect, it } from 'vitest';
import type { BrowserBounds } from '../../../electron/canvas/browser-contract';
import { type BrowserBoundsEntry, browserBoundsForPanel, rectToBounds } from './browser-bounds';

describe('rectToBounds (B2 — browser fills the slot, no seam)', () => {
  it('passes through integer rects unchanged', () => {
    expect(rectToBounds({ left: 800, top: 96, right: 1240, bottom: 700 })).toEqual({
      x: 800,
      y: 96,
      width: 440,
      height: 604,
    });
  });

  it('rounds each EDGE (not the width) so a subpixel slot leaves no right/bottom gap', () => {
    // A slot at x=800.4 spanning 439.6px ends at 1240.0. Rounding the WIDTH
    // (439.6 → 440) with a floored x (800) would end at 1240 — fine here — but a
    // slot ending at a .5 boundary is where flooring strands a pixel. Edge-round
    // keeps the right/bottom edges pinned to the rounded slot edges.
    const bounds = rectToBounds({ left: 800.4, top: 96.4, right: 1240.6, bottom: 700.6 });
    // right edge = round(1240.6)=1241, x=round(800.4)=800 → width 441 reaches it.
    expect(bounds.x + bounds.width).toBe(1241);
    expect(bounds.y + bounds.height).toBe(701);
    expect(bounds).toEqual({ x: 800, y: 96, width: 441, height: 605 });
  });

  it('never emits a negative width/height', () => {
    expect(rectToBounds({ left: 10, top: 10, right: 5, bottom: 4 })).toEqual({
      x: 10,
      y: 10,
      width: 0,
      height: 0,
    });
  });
});

describe('browserBoundsForPanel (B1 — closing the canvas hides the native browser)', () => {
  const b = (n: number): BrowserBounds => ({ x: n, y: n, width: 400, height: 300 });
  const browsers = new Map<string, BrowserBoundsEntry>([
    ['a', { lastBounds: b(1) }],
    ['b', { lastBounds: b(2) }],
  ]);

  it('hides EVERY browser view when the panel closes', () => {
    const intents = browserBoundsForPanel(false, 'a', browsers);
    expect(intents).toEqual([
      { tabId: 'a', bounds: b(1), visible: false },
      { tabId: 'b', bounds: b(2), visible: false },
    ]);
  });

  it('re-shows only the ACTIVE browser view when the panel reopens', () => {
    expect(browserBoundsForPanel(true, 'b', browsers)).toEqual([
      { tabId: 'b', bounds: b(2), visible: true },
    ]);
  });

  it('shows nothing on reopen when the active tab is not a browser', () => {
    expect(browserBoundsForPanel(true, 'not-a-browser', browsers)).toEqual([]);
    expect(browserBoundsForPanel(true, null, browsers)).toEqual([]);
  });

  it('is a no-op (empty) when closing with no browser views', () => {
    expect(browserBoundsForPanel(false, null, new Map())).toEqual([]);
  });
});
