import { describe, expect, it, vi } from 'vitest';
import { CANVAS_MAX_WIDTH, CANVAS_MIN_WIDTH } from '../../state/canvas-store';
import {
  CANVAS_COLLAPSE_DRAG_THRESHOLD,
  createCanvasDragResize,
  shouldCollapseOnResize,
} from './resize-collapse';

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

/**
 * The provisional-collapse gesture (round-14 #8): move only PREVIEWS (live
 * dragWidth, persist only ≥ min), release COMMITS the close once, and only when
 * the final position crossed the collapse threshold. The panel is never torn
 * down mid-drag, so dragging back un-collapses. The rail grows leftward, so a
 * SMALLER clientX ⇒ WIDER panel: next = startWidth + (startX − clientX).
 */
describe('createCanvasDragResize gesture (round-14 #8)', () => {
  const START_X = 1000;
  const START_W = 440;

  function harness() {
    const cb = {
      setSideWidth: vi.fn(),
      setDragWidth: vi.fn(),
      setCanvasOpen: vi.fn(),
      cleanup: vi.fn(),
    };
    return { cb, drag: createCanvasDragResize(START_X, START_W, cb) };
  }

  // Drag the handle RIGHT far enough that next drops past the collapse threshold.
  const overDrag = START_X + (START_W - (CANVAS_COLLAPSE_DRAG_THRESHOLD - 20)); // next ≈ 140

  it('move never opens or closes the panel (provisional until release)', () => {
    const { cb, drag } = harness();
    drag.move(overDrag); // next well below the threshold → would-collapse
    drag.move(START_X - 100); // next = 540, comfortably open
    expect(cb.setCanvasOpen).not.toHaveBeenCalled();
  });

  it('previews a live width that may shrink below the minimum toward 0', () => {
    const { cb, drag } = harness();
    drag.move(overDrag);
    // Preview reflects the sub-minimum target so the collapse is visible.
    expect(cb.setDragWidth).toHaveBeenLastCalledWith(CANVAS_COLLAPSE_DRAG_THRESHOLD - 20);
    // Drag past the far end → clamps to 0 (never negative).
    drag.move(START_X + START_W + 500);
    expect(cb.setDragWidth).toHaveBeenLastCalledWith(0);
    // Drag the other way past the max → preview clamps to the max.
    drag.move(START_X - (CANVAS_MAX_WIDTH + 200));
    expect(cb.setDragWidth).toHaveBeenLastCalledWith(CANVAS_MAX_WIDTH);
  });

  it('persists to the store ONLY at/above the minimum — an over-drag never corrupts sideWidth', () => {
    const { cb, drag } = harness();
    drag.move(overDrag); // next ≈ 140 (< min) → must NOT persist
    drag.move(START_X - 100); // next = 540 (in range) → persist 540
    drag.move(START_X - (CANVAS_MAX_WIDTH + 500)); // next huge → persist clamped max
    // Every persisted width is at or above the minimum.
    for (const [w] of cb.setSideWidth.mock.calls) {
      expect(w).toBeGreaterThanOrEqual(CANVAS_MIN_WIDTH);
    }
    expect(cb.setSideWidth).toHaveBeenCalledWith(540);
    expect(cb.setSideWidth).toHaveBeenCalledWith(CANVAS_MAX_WIDTH);
    // The sub-minimum target was never persisted.
    expect(cb.setSideWidth).not.toHaveBeenCalledWith(CANVAS_COLLAPSE_DRAG_THRESHOLD - 20);
  });

  it('release COMMITS the close once when the final position crossed the threshold', () => {
    const { cb, drag } = harness();
    drag.move(overDrag);
    drag.up();
    expect(cb.cleanup).toHaveBeenCalledTimes(1);
    expect(cb.setCanvasOpen).toHaveBeenCalledTimes(1);
    expect(cb.setCanvasOpen).toHaveBeenCalledWith(false);
  });

  it('release does NOT close when settled at/above the minimum', () => {
    const { cb, drag } = harness();
    drag.move(START_X - 100); // next = 540, open
    drag.up();
    expect(cb.cleanup).toHaveBeenCalledTimes(1);
    expect(cb.setCanvasOpen).not.toHaveBeenCalled();
  });

  it('dragging back above the threshold before release cancels the close', () => {
    const { cb, drag } = harness();
    drag.move(overDrag); // would collapse…
    drag.move(START_X); // …then dragged back to the start width (>= threshold)
    drag.up();
    expect(cb.setCanvasOpen).not.toHaveBeenCalled();
  });

  it('release commits at most once (idempotent up)', () => {
    const { cb, drag } = harness();
    drag.move(overDrag);
    drag.up();
    drag.up();
    expect(cb.cleanup).toHaveBeenCalledTimes(1);
    expect(cb.setCanvasOpen).toHaveBeenCalledTimes(1);
  });
});
