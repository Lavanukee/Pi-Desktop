/**
 * Drag-resize-to-collapse threshold (round-10 #14). Dragging the canvas rail's
 * resize handle rightward shrinks the rail; once it is dragged WELL below the
 * minimum width — more than halfway past the minimum — we treat the gesture as
 * clicking Collapse and close the panel instead of pinning it at the minimum.
 *
 * Pure so the threshold is unit-testable independent of the drag wiring.
 */
import { CANVAS_MIN_WIDTH } from '../../state/canvas-store';

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
