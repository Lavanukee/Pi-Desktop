/**
 * Renderer state for the EXPERIMENTAL coordination harness (the situation-room
 * click-through). Tiny on purpose: the live CoordinationEvent stream is folded by
 * the situation room itself; this only tracks the active task id and which worker
 * node the user clicked, so the app can route that node's stream into the LEFT
 * chat area. Gated entirely behind the production-harness flag — untouched when
 * the flag is off.
 */
import type { OrgNodeView } from '@pi-desktop/coordination';
import { create } from 'zustand';

interface CorpStoreState {
  /** The active corp task id (a situation room is open for it), or null. */
  taskId: string | null;
  /** The worker node whose REAL stream the left chat area is showing, or null. */
  selectedNode: OrgNodeView | null;
  /** Start tracking a new corp task (clears any prior selection). */
  setTask: (taskId: string | null) => void;
  /** Toggle-select a worker node (clicking the selected node clears it). */
  selectNode: (node: OrgNodeView | null) => void;
}

export const useCorpStore = create<CorpStoreState>((set) => ({
  taskId: null,
  selectedNode: null,
  setTask: (taskId) => set({ taskId, selectedNode: null }),
  selectNode: (node) =>
    set((s) => ({ selectedNode: s.selectedNode?.id === node?.id ? null : node })),
}));
