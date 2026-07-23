import { describe, expect, it } from 'vitest';
import {
  comboLabel,
  OVERLAY_BUFFER,
  overlayBoundsFor,
  overlayShouldShow,
  rectsDiffer,
  toLocalPoint,
  typingPreview,
} from './overlay-geometry';

describe('overlayBoundsFor', () => {
  it('rounds to integer Electron bounds and never collapses to zero size (buffer 0)', () => {
    expect(overlayBoundsFor({ x: 10.4, y: 20.6, w: 800.2, h: 599.9 }, 0)).toEqual({
      x: 10,
      y: 21,
      width: 800,
      height: 600,
    });
    expect(overlayBoundsFor({ x: 0, y: 0, w: 0.2, h: 0 }, 0)).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
  });
  it('pads the window by the buffer on every side (larger than the tracked rect)', () => {
    const b = 40;
    expect(overlayBoundsFor({ x: 200, y: 150, w: 800, h: 600 }, b)).toEqual({
      x: 200 - b,
      y: 150 - b,
      width: 800 + b * 2,
      height: 600 + b * 2,
    });
    // Default buffer is applied when none is passed.
    const def = overlayBoundsFor({ x: 200, y: 150, w: 800, h: 600 });
    expect(def).toEqual({
      x: 200 - OVERLAY_BUFFER,
      y: 150 - OVERLAY_BUFFER,
      width: 800 + OVERLAY_BUFFER * 2,
      height: 600 + OVERLAY_BUFFER * 2,
    });
  });
});

describe('rectsDiffer (tracking-loop thrash guard)', () => {
  const base = { x: 100, y: 100, w: 640, h: 480 };
  it('ignores sub-point AX jitter', () => {
    expect(rectsDiffer(base, { x: 100.4, y: 99.7, w: 640.3, h: 480 })).toBe(false);
  });
  it('detects real moves and resizes', () => {
    expect(rectsDiffer(base, { ...base, x: 130 })).toBe(true);
    expect(rectsDiffer(base, { ...base, h: 500 })).toBe(true);
  });
  it('treats null (no window) vs a rect as a change, null vs null as none', () => {
    expect(rectsDiffer(null, base)).toBe(true);
    expect(rectsDiffer(base, null)).toBe(true);
    expect(rectsDiffer(null, null)).toBe(false);
  });
});

describe('toLocalPoint (screen → overlay mapping)', () => {
  const win = { x: 200, y: 150, w: 800, h: 600 };
  it('translates a screen point, offset by the buffer (window is padded)', () => {
    // Interior point: local = (screen - origin) + buffer on each axis.
    expect(toLocalPoint(600, 450, win, 40)).toEqual({ x: 440, y: 340 });
    // With buffer 0 it is pure translation (legacy behavior).
    expect(toLocalPoint(600, 450, win, 0)).toEqual({ x: 400, y: 300 });
  });
  it('lets the cursor sit ON the app edge inside the buffer zone (no clip)', () => {
    // A point on the app's own top-left corner maps to (buffer, buffer): the
    // cursor tip sits `buffer` px in, its glyph free to protrude toward 0.
    expect(toLocalPoint(200, 150, win, 40)).toEqual({ x: 40, y: 40 });
    // The app's bottom-right corner → padded window minus the buffer.
    expect(toLocalPoint(1000, 750, win, 40)).toEqual({ x: 40 + 800, y: 40 + 600 });
  });
  it('clamps a point well outside the padded window to a tiny inset', () => {
    const b = 40;
    const paddedW = win.w + b * 2;
    const paddedH = win.h + b * 2;
    expect(toLocalPoint(5000, 5000, win, b, 2)).toEqual({ x: paddedW - 2, y: paddedH - 2 });
    expect(toLocalPoint(-5000, -5000, win, b, 2)).toEqual({ x: 2, y: 2 });
  });
  it('survives degenerate window sizes', () => {
    expect(toLocalPoint(5, 5, { x: 0, y: 0, w: 2, h: 2 }, 0, 4)).toEqual({ x: 4, y: 4 });
  });
});

describe('overlayShouldShow (app-scoped visibility rule)', () => {
  it('hides when the controlled window is not present, regardless of the rest', () => {
    expect(overlayShouldShow({ controlledFrontmost: true, appVisible: false, driving: true })).toBe(
      false,
    );
  });
  it('shows while the model is actively driving, even in the background', () => {
    expect(overlayShouldShow({ controlledFrontmost: false, appVisible: true, driving: true })).toBe(
      true,
    );
  });
  it('shows when the controlled app is frontmost even if the model is idle', () => {
    expect(overlayShouldShow({ controlledFrontmost: true, appVisible: true, driving: false })).toBe(
      true,
    );
  });
  it('tucks away when backgrounded AND idle (user is working elsewhere)', () => {
    expect(
      overlayShouldShow({ controlledFrontmost: false, appVisible: true, driving: false }),
    ).toBe(false);
  });
});

describe('comboLabel (status-bubble key labels)', () => {
  it('renders modifier glyphs + uppercased key', () => {
    expect(comboLabel('cmd+s')).toBe('⌘S');
    expect(comboLabel('cmd+shift+z')).toBe('⌘⇧Z');
    expect(comboLabel('ctrl+alt+delete')).toBe('⌃⌥⌫');
  });
  it('renders named keys as their mac glyphs', () => {
    expect(comboLabel('return')).toBe('↩');
    expect(comboLabel('escape')).toBe('Esc');
    expect(comboLabel('down')).toBe('↓');
  });
  it('never returns an empty label', () => {
    expect(comboLabel('')).toBe('');
    expect(comboLabel('weirdkey')).toBe('Weirdkey');
  });
});

describe('typingPreview', () => {
  it('collapses whitespace and truncates with an ellipsis', () => {
    expect(typingPreview('hello   world')).toBe('hello world');
    const long = 'a'.repeat(80);
    const out = typingPreview(long);
    expect(out.length).toBe(44);
    expect(out.endsWith('…')).toBe(true);
  });
});
