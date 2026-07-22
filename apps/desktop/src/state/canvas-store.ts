/**
 * Canvas rail width (drag-resize) state — the only chat-owned canvas UI state
 * left after the tabbed rework (THEME 1): open/collapse/fullscreen/active-tab
 * now live in the shared `CanvasController` (@pi-desktop/canvas), and inline-vs-
 * canvas routing is derived per-artifact via `shouldGoToCanvas`. Width is kept
 * here so the rail persists a user's drag independent of the tab set.
 */
import type { CanvasController, CanvasState } from '@pi-desktop/canvas';
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

// ── Canvas controller bridge (per-session isolation) ───────────────────────
// The canvas TAB set lives in the React-owned CanvasController (@pi-desktop/
// canvas), which the non-React session lifecycle (pi-connect's newSession /
// switchSession) can't reach directly. The app shell registers the live
// controller here on mount, so the session lifecycle can reset / SNAPSHOT /
// RESTORE the canvas — each chat keeps its OWN canvas (its tabs are saved on
// switch-away and restored on switch-back) instead of leaking across chats.

let controller: CanvasController | null = null;

/** App shell → register (or, with `null`, unregister) the live CanvasController.
 * Idempotent; the latest registration wins. */
export function registerCanvasController(c: CanvasController | null): void {
  controller = c;
}

/**
 * Reset the canvas for a conversation with no saved state: drop every tab and
 * slide the rail closed so it starts empty. Safe before the shell mounts (no-op).
 */
export function resetCanvasForNewSession(): void {
  controller?.reset();
  useCanvasStore.getState().setCanvasOpen(false);
}

/** Snapshot the live canvas state (tabs/active/collapsed/fullscreen) so the
 * current chat's canvas can be restored on return. Null before the shell mounts. */
export function snapshotCanvas(): CanvasState | null {
  return controller?.getState() ?? null;
}

/** Restore a previously-snapshotted canvas for a returned-to chat, opening the
 * rail only when the snapshot actually had tabs (else it stays closed). */
export function restoreCanvas(state: CanvasState): void {
  controller?.restore(state);
  useCanvasStore.getState().setCanvasOpen(state.tabs.length > 0);
}
