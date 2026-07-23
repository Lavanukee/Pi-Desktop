import { describe, expect, it } from 'vitest';
import {
  comboLabel,
  overlayBoundsFor,
  rectsDiffer,
  toLocalPoint,
  typingPreview,
} from './overlay-geometry';

describe('overlayBoundsFor', () => {
  it('rounds to integer Electron bounds and never collapses to zero size', () => {
    expect(overlayBoundsFor({ x: 10.4, y: 20.6, w: 800.2, h: 599.9 })).toEqual({
      x: 10,
      y: 21,
      width: 800,
      height: 600,
    });
    expect(overlayBoundsFor({ x: 0, y: 0, w: 0.2, h: 0 })).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
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
  it('translates a screen point into window-local coordinates', () => {
    expect(toLocalPoint(600, 450, win)).toEqual({ x: 400, y: 300 });
  });
  it('clamps points at/off the window edge inside with an inset (cursor stays visible)', () => {
    expect(toLocalPoint(200, 150, win)).toEqual({ x: 4, y: 4 });
    expect(toLocalPoint(1100, 900, win)).toEqual({ x: 796, y: 596 });
    expect(toLocalPoint(0, 0, win)).toEqual({ x: 4, y: 4 });
  });
  it('survives degenerate window sizes', () => {
    expect(toLocalPoint(5, 5, { x: 0, y: 0, w: 2, h: 2 })).toEqual({ x: 4, y: 4 });
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
