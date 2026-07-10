import { describe, expect, it } from 'vitest';
import { CANVAS_MIN_WIDTH } from '../../state/canvas-store';
import { CANVAS_COLLAPSE_DRAG_THRESHOLD, shouldCollapseOnResize } from './resize-collapse';

describe('resize-to-collapse threshold (round-10 #14)', () => {
  it('is half the canvas minimum width', () => {
    expect(CANVAS_COLLAPSE_DRAG_THRESHOLD).toBe(CANVAS_MIN_WIDTH / 2);
  });

  it('does not collapse at or above the minimum width', () => {
    expect(shouldCollapseOnResize(CANVAS_MIN_WIDTH)).toBe(false);
    expect(shouldCollapseOnResize(CANVAS_MIN_WIDTH + 100)).toBe(false);
  });

  it('does not collapse until dragged more than halfway past the minimum', () => {
    // Just below min but above the halfway point → clamp to min, stay open.
    expect(shouldCollapseOnResize(CANVAS_MIN_WIDTH - 1)).toBe(false);
    expect(shouldCollapseOnResize(CANVAS_COLLAPSE_DRAG_THRESHOLD)).toBe(false);
  });

  it('collapses once dragged well below the minimum (past halfway)', () => {
    expect(shouldCollapseOnResize(CANVAS_COLLAPSE_DRAG_THRESHOLD - 1)).toBe(true);
    expect(shouldCollapseOnResize(0)).toBe(true);
    expect(shouldCollapseOnResize(-50)).toBe(true);
  });
});
