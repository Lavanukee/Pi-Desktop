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

/** Integer Electron bounds for the overlay window covering `rect` exactly. */
export function overlayBoundsFor(rect: OverlayRect): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.max(1, Math.round(rect.w)),
    height: Math.max(1, Math.round(rect.h)),
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
 * Map a global screen point into overlay-local coordinates, clamped into the
 * window with a small inset so the cursor glyph + its glow stay visible even
 * when an action lands at the very edge (or the helper reports a point a hair
 * outside the tracked rect mid-move).
 */
export function toLocalPoint(
  screenX: number,
  screenY: number,
  rect: OverlayRect,
  inset = 4,
): { x: number; y: number } {
  const maxX = Math.max(inset, rect.w - inset);
  const maxY = Math.max(inset, rect.h - inset);
  return {
    x: Math.min(maxX, Math.max(inset, Math.round(screenX - rect.x))),
    y: Math.min(maxY, Math.max(inset, Math.round(screenY - rect.y))),
  };
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
