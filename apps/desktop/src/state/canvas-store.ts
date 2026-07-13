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
  /**
   * App-owned desired open/closed state of the canvas rail. The persistent
   * top-right toggle (round-7) drives this so the canvas can be opened/closed
   * even when no artifact is showing; the panel-toggle inside the rail and a new
   * routed-in artifact drive it too. Starts closed (no rail until there's
   * something to show, or the user opens it).
   */
  canvasOpen: boolean;
  setCanvasOpen: (open: boolean) => void;
  toggleCanvasOpen: () => void;
}

const clampWidth = (w: number): number => Math.max(CANVAS_MIN_WIDTH, Math.min(CANVAS_MAX_WIDTH, w));

export const useCanvasStore = create<CanvasUiState>((set) => ({
  sideWidth: CANVAS_DEFAULT_WIDTH,
  setSideWidth: (width) => set({ sideWidth: clampWidth(width) }),
  canvasOpen: false,
  setCanvasOpen: (open) => set({ canvasOpen: open }),
  toggleCanvasOpen: () => set((s) => ({ canvasOpen: !s.canvasOpen })),
}));

// ── Canvas-reset bridge (session isolation) ────────────────────────────────
// The canvas TAB set lives in the React-owned CanvasController (@pi-desktop/
// canvas), which the non-React session lifecycle (pi-connect's newSession /
// switchSession) can't reach directly. The app shell registers the live
// controller's `reset` here on mount, so starting or switching a conversation
// can clear the PREVIOUS conversation's canvas — each chat gets its own clean
// canvas instead of accumulating tabs across "separate" chats (backlog #2).

let controllerReset: (() => void) | null = null;

/** App shell → register (or, with `null`, unregister) the live CanvasController's
 * tab-reset. Idempotent; the latest registration wins. */
export function registerCanvasControllerReset(fn: (() => void) | null): void {
  controllerReset = fn;
}

/**
 * Reset the canvas for a fresh / switched conversation: drop every tab
 * (CanvasController.reset via the registered bridge) and slide the rail closed
 * so the new chat starts with an empty canvas. Safe to call when nothing is
 * registered (a no-op before the shell mounts).
 */
export function resetCanvasForNewSession(): void {
  controllerReset?.();
  useCanvasStore.getState().setCanvasOpen(false);
}
