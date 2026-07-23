/**
 * Pure support logic for the Mac computer-use cursor overlay, extracted from
 * overlay-window.ts so it unit-tests in plain Node (window-policy.ts
 * precedent): screen↔overlay coordinate mapping, window-bounds diffing for the
 * tracking loop, and the key-combo → display-label prettifier the status
 * bubble shows. All coordinates are global macOS screen POINTS (top-left
 * origin) — the same space AX positions, CGEvent posts, and Electron window
 * bounds share, so mapping is pure translation (no scaling).
 */

/** A window rect in global screen points. */
export interface OverlayRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * Extra transparent margin (points) the overlay window carries on EVERY side
 * beyond the tracked app window. It buys two things the old "exactly the window
 * bounds" sizing couldn't: the phantom cursor can protrude PAST the app's edge
 * (an action a hair outside the frame, or the arrow's glow at the very border)
 * without being clipped, and the status pill has room to render fully / flip
 * near a corner instead of being sheared off. All screen→local mapping is
 * offset by this buffer so a point on the app's own edge lands `buffer` px in
 * from the padded window's edge. 56pt clears the whole 34×40 cursor glyph
 * (which reaches ~35px below its tip) at any edge. */
export const OVERLAY_BUFFER = 56;

/** Integer Electron bounds for the overlay window covering `rect` plus the
 * buffer margin on every side (larger than the tracked window on purpose — see
 * OVERLAY_BUFFER). Never collapses below 1×1. */
export function overlayBoundsFor(
  rect: OverlayRect,
  buffer = OVERLAY_BUFFER,
): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  return {
    x: Math.round(rect.x - buffer),
    y: Math.round(rect.y - buffer),
    width: Math.max(1, Math.round(rect.w + buffer * 2)),
    height: Math.max(1, Math.round(rect.h + buffer * 2)),
  };
}

/** Did the tracked window move/resize enough to reposition the overlay?
 * (Sub-point AX jitter is ignored so the tracker doesn't thrash setBounds.) */
export function rectsDiffer(a: OverlayRect | null, b: OverlayRect | null): boolean {
  if (a === null || b === null) return a !== b;
  return (
    Math.abs(a.x - b.x) >= 1 ||
    Math.abs(a.y - b.y) >= 1 ||
    Math.abs(a.w - b.w) >= 1 ||
    Math.abs(a.h - b.h) >= 1
  );
}

/**
 * Map a global screen point into overlay-local coordinates. The overlay window
 * is padded by `buffer` on every side (see OVERLAY_BUFFER), so a screen point
 * ON the tracked window's own edge maps to `buffer` px in from the padded
 * window edge — leaving the buffer zone free for the cursor glyph to protrude
 * past the app's border without clipping. Clamped into the PADDED window with a
 * tiny inset (the buffer, not the inset, is what keeps the glyph on-screen), so
 * a point a hair outside the tracked rect mid-drag still lands cleanly.
 */
export function toLocalPoint(
  screenX: number,
  screenY: number,
  rect: OverlayRect,
  buffer = OVERLAY_BUFFER,
  inset = 2,
): { x: number; y: number } {
  const paddedW = rect.w + buffer * 2;
  const paddedH = rect.h + buffer * 2;
  const maxX = Math.max(inset, paddedW - inset);
  const maxY = Math.max(inset, paddedH - inset);
  return {
    x: Math.min(maxX, Math.max(inset, Math.round(screenX - rect.x) + buffer)),
    y: Math.min(maxY, Math.max(inset, Math.round(screenY - rect.y) + buffer)),
  };
}

/** Inputs the overlay-visibility rule reads each tracking tick. */
export interface OverlayVisibilityState {
  /** The controlled app currently owns the user's focus (its window is front). */
  readonly controlledFrontmost: boolean;
  /** The controlled window is present/on-screen (a bounds read succeeded — not
   * minimized, closed, or on another space we can't see). */
  readonly appVisible: boolean;
  /** The model is actively driving the app right now (a tool act in flight or
   * within the recent activity window). */
  readonly driving: boolean;
  /** Z-ORDER TRUTH from the helper (CGWindowList): is the controlled window
   * meaningfully covered by OTHER apps' windows above it? `null`/undefined =
   * unknown (old helper / no windowId) → fall back to the driving/frontmost
   * proxy rule. */
  readonly occluded?: boolean | null;
}

/**
 * Should the phantom cursor overlay be VISIBLE?
 *
 * macOS window levels are global bands, not per-app, so a click-through child
 * window can't be truly z-sandwiched between the controlled app and whatever
 * else is on screen. The honest scope, then, is a show/hide rule: the overlay
 * is tied to the controlled app, never floating over an app the user has turned
 * to on their own.
 *
 *   - The window must exist at all (`appVisible`) — nothing to overlay
 *     otherwise.
 *   - OCCLUSION IS TRUTH when the helper reports it: a controlled window
 *     covered by another app's window must never wear the phantom (even while
 *     the model is driving — the cursor lives ON the app, not on whatever the
 *     user dragged over it), and a CLEAR window keeps its cursor even when
 *     the model is idle and the app is backgrounded.
 *   - Occlusion unknown (old helper): fall back to the proxy rule — show
 *     while DRIVING or while the controlled app is FRONTMOST, tuck away
 *     otherwise.
 */
export function overlayShouldShow(s: OverlayVisibilityState): boolean {
  if (!s.appVisible) return false;
  if (s.occluded === true) return false;
  if (s.occluded === false) return true;
  return s.driving || s.controlledFrontmost;
}

const MODIFIER_GLYPHS: Record<string, string> = {
  cmd: '⌘',
  command: '⌘',
  meta: '⌘',
  super: '⌘',
  win: '⌘',
  shift: '⇧',
  alt: '⌥',
  option: '⌥',
  opt: '⌥',
  ctrl: '⌃',
  control: '⌃',
  fn: 'fn',
  function: 'fn',
};

const KEY_LABELS: Record<string, string> = {
  return: '↩',
  enter: '↩',
  tab: '⇥',
  space: 'Space',
  escape: 'Esc',
  esc: 'Esc',
  delete: '⌫',
  backspace: '⌫',
  forwarddelete: '⌦',
  left: '←',
  right: '→',
  up: '↑',
  down: '↓',
  pageup: 'PgUp',
  pagedown: 'PgDn',
  home: 'Home',
  end: 'End',
};

/** Render "cmd+shift+s" as the label macOS users read: "⌘⇧S". Unknown tokens
 * pass through capitalized, so the bubble never shows an empty label. */
export function comboLabel(combo: string): string {
  const parts = combo
    .split(/[+-]/)
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p !== '');
  if (parts.length === 0) return combo;
  let mods = '';
  let key = '';
  for (const part of parts) {
    const glyph = MODIFIER_GLYPHS[part];
    if (glyph !== undefined) {
      mods += glyph;
      continue;
    }
    key = KEY_LABELS[part] ?? (part.length === 1 ? part.toUpperCase() : capitalize(part));
  }
  return `${mods}${key}` === '' ? combo : `${mods}${key}`;
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

/** Truncate the live-typing preview so the bubble stays a bubble. */
export function typingPreview(text: string, max = 44): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1)}…`;
}
