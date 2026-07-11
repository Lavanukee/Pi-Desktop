/**
 * Drag-resize-to-collapse threshold (round-10 #14). Dragging the canvas rail's
 * resize handle rightward shrinks the rail; once it is dragged WELL below the
 * minimum width — more than halfway past the minimum — we treat the gesture as
 * clicking Collapse and close the panel instead of pinning it at the minimum.
 *
 * Pure so the threshold is unit-testable independent of the drag wiring.
 */
import { CANVAS_MAX_WIDTH, CANVAS_MIN_WIDTH } from '../../state/canvas-store';

/** The rail closes once the (unclamped) dragged width drops below this — half of
 * the canvas minimum width. */
export const CANVAS_COLLAPSE_DRAG_THRESHOLD = CANVAS_MIN_WIDTH / 2;

/**
 * True when an in-progress resize should snap to Collapse: the unclamped target
 * width has been dragged more than halfway past the minimum (i.e. below
 * {@link CANVAS_COLLAPSE_DRAG_THRESHOLD}).
 */
export function shouldCollapseOnResize(nextWidth: number): boolean {
  return nextWidth < CANVAS_COLLAPSE_DRAG_THRESHOLD;
}

/** Callbacks the drag gesture drives; the DOM wiring lives in CanvasTabsPanel. */
export interface CanvasDragResizeCallbacks {
  /** Persist the remembered rail width. NEVER called with a value < min. */
  setSideWidth: (width: number) => void;
  /** Live per-frame preview width (may shrink below min toward 0); null = idle. */
  setDragWidth: (width: number | null) => void;
  /** Commit the close. Called at most once, on release, only when collapsing. */
  setCanvasOpen: (open: boolean) => void;
  /** Tear down listeners / drag flags (also resets the preview to null). */
  cleanup: () => void;
}

/**
 * The canvas resize-drag as pure gesture logic (round-14 #8), so the
 * provisional-collapse contract is unit-testable without a DOM:
 *
 *  - `move` only PREVIEWS: it sets a live `dragWidth` (clamped 0..max, so the
 *    rail visibly shrinks toward 0 past the minimum) and persists to the store
 *    ONLY while at/above the minimum — a provisional over-drag never corrupts
 *    the remembered `sideWidth`. It never opens/closes the panel.
 *  - `up` COMMITS ONCE: cleans up, then closes the panel only if the final
 *    position crossed the collapse threshold, letting the now-live width
 *    transition animate the close. Dragging back above the threshold before
 *    release cancels the close.
 */
export function createCanvasDragResize(
  startX: number,
  startWidth: number,
  cb: CanvasDragResizeCallbacks,
): { move: (clientX: number) => void; up: () => void } {
  let willClose = false;
  let committed = false;
  const move = (clientX: number): void => {
    const next = startWidth + (startX - clientX);
    willClose = shouldCollapseOnResize(next);
    // Live preview may go below min (down toward 0) so the collapse is visible.
    cb.setDragWidth(Math.max(0, Math.min(CANVAS_MAX_WIDTH, next)));
    // Only remember widths at/above the minimum — an over-drag must not persist.
    if (next >= CANVAS_MIN_WIDTH) {
      cb.setSideWidth(Math.max(CANVAS_MIN_WIDTH, Math.min(CANVAS_MAX_WIDTH, next)));
    }
  };
  const up = (): void => {
    if (committed) return;
    committed = true;
    cb.cleanup();
    if (willClose) cb.setCanvasOpen(false);
  };
  return { move, up };
}
