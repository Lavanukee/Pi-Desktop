/**
 * Canvas rail width (drag-resize) state — the only chat-owned canvas UI state
 * left after the tabbed rework (THEME 1): open/collapse/fullscreen/active-tab
 * now live in the shared `CanvasController` (@pi-desktop/canvas), and inline-vs-
 * canvas routing is derived per-artifact via `shouldGoToCanvas`. Width is kept
 * here so the rail persists a user's drag independent of the tab set.
 */
import { create } from 'zustand';

export const CANVAS_MIN_WIDTH = 320;
export const CANVAS_MAX_WIDTH = 760;
const CANVAS_DEFAULT_WIDTH = 440;

interface CanvasUiState {
  sideWidth: number;
  setSideWidth: (width: number) => void;
}

const clampWidth = (w: number): number => Math.max(CANVAS_MIN_WIDTH, Math.min(CANVAS_MAX_WIDTH, w));

export const useCanvasStore = create<CanvasUiState>((set) => ({
  sideWidth: CANVAS_DEFAULT_WIDTH,
  setSideWidth: (width) => set({ sideWidth: clampWidth(width) }),
}));
