/**
 * Pure geometry/visibility helpers for the native browser WebContentsView
 * overlay (Lane B). Kept in their own module — free of the xterm/DOM imports in
 * native-surfaces.ts — so the rounding + close-hide logic is unit-testable in
 * the desktop node test env.
 */
import type { BrowserBounds } from '../../../electron/canvas/browser-contract';

/** The subset of a DOMRect the bounds math reads (also lets tests pass plain objects). */
export interface RectEdges {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Convert a slot client rect to INTEGER window bounds with edge-aligned
 * rounding (B2 — "browser must fill the canvas, no gap/cutoff"). Each EDGE is
 * rounded to the nearest device pixel and width/height are derived from the
 * rounded edges — never `round(width)`, which can floor a subpixel width and
 * strand a 1px seam on the right/bottom. The result already being integer makes
 * browser-manager's own `Math.round` a no-op.
 */
export function rectToBounds(rect: RectEdges): BrowserBounds {
  const x = Math.round(rect.left);
  const y = Math.round(rect.top);
  return {
    x,
    y,
    width: Math.max(0, Math.round(rect.right) - x),
    height: Math.max(0, Math.round(rect.bottom) - y),
  };
}

/** One `browser:set-bounds` intent (tabId + bounds + visibility). */
export interface BrowserBoundsIntent {
  tabId: string;
  bounds: BrowserBounds;
  visible: boolean;
}

/** The `lastBounds` a browser entry carries (structural subset for testing). */
export interface BrowserBoundsEntry {
  lastBounds: BrowserBounds;
}

/**
 * Compute the `browser:set-bounds` calls to issue when the canvas panel's
 * open-state changes (B1 — closing the canvas must not leave the native browser
 * view painted over the chat).
 *
 *  - CLOSED → hide EVERY live browser view. Native WebContentsViews paint ABOVE
 *    the DOM and are not clipped by the collapsing aside, so unless we revoke
 *    their visibility they float, stranded, over the chat column.
 *  - OPEN → re-show only the ACTIVE browser view at its last bounds (the others
 *    stay hidden — they're switched-away tabs). The mount/rect path can't
 *    re-show them because the surface never unmounted while the panel slid out.
 */
export function browserBoundsForPanel(
  open: boolean,
  activeTabId: string | null,
  browsers: ReadonlyMap<string, BrowserBoundsEntry>,
): BrowserBoundsIntent[] {
  if (!open) {
    return [...browsers].map(([tabId, entry]) => ({
      tabId,
      bounds: entry.lastBounds,
      visible: false,
    }));
  }
  if (activeTabId === null) return [];
  const entry = browsers.get(activeTabId);
  return entry === undefined
    ? []
    : [{ tabId: activeTabId, bounds: entry.lastBounds, visible: true }];
}
