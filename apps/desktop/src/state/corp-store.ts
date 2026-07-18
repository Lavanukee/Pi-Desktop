/**
 * Renderer state for the EXPERIMENTAL coordination harness (the situation-room
 * click-through + follow-live). Tiny on purpose: the live CoordinationEvent
 * stream is folded by the situation room itself; this only tracks
 *
 *  - the active task id,
 *  - the FOLLOWED node — the top-most node actually running right now, folded
 *    from each org-chart snapshot (`followTarget`), so the left chat area is
 *    NEVER blank once a task is submitted and moves with the action, and
 *  - an optional user PIN — a clicked node the pane sticks to until the user
 *    resumes following (clicking the pinned node again, or "follow live").
 *
 * The node the left pane shows is `pinnedNode ?? liveNode`. Gated entirely
 * behind the production-harness flag — untouched when the flag is off.
 */
import { followTarget } from '@pi-desktop/canvas';
import type { OrgChartView, OrgNodeView } from '@pi-desktop/coordination';
import { create } from 'zustand';

interface CorpStoreState {
  /** The active corp task id (a situation room is open for it), or null. */
  taskId: string | null;
  /** Auto-followed node: the top-most node actually running (sticky). */
  liveNode: OrgNodeView | null;
  /** User-pinned node — overrides the follow; null = following live. */
  pinnedNode: OrgNodeView | null;
  /** Start tracking a new corp task (clears follow + pin). */
  setTask: (taskId: string | null) => void;
  /** Pin a clicked node; clicking the pinned node again resumes following. */
  selectNode: (node: OrgNodeView | null) => void;
  /** Drop the pin and resume following the running node. */
  followLive: () => void;
  /** Fold one org-chart snapshot: advance the follow target + refresh the
   * pinned node's live state (its gem/status must stay honest). */
  trackChart: (chart: OrgChartView) => void;
}

export const useCorpStore = create<CorpStoreState>((set) => ({
  taskId: null,
  liveNode: null,
  pinnedNode: null,
  setTask: (taskId) => set({ taskId, liveNode: null, pinnedNode: null }),
  selectNode: (node) => set((s) => ({ pinnedNode: s.pinnedNode?.id === node?.id ? null : node })),
  followLive: () => set({ pinnedNode: null }),
  trackChart: (chart) =>
    set((s) => {
      const nextLive = followTarget(chart, s.liveNode?.id) ?? s.liveNode;
      // Keep the pinned node's state fresh from the chart (unknown id: keep as-is).
      const nextPinned =
        s.pinnedNode !== null
          ? (chart.nodes.find((n) => n.id === s.pinnedNode?.id) ?? s.pinnedNode)
          : null;
      // Preserve object identity when nothing user-visible changed, so chart
      // bursts don't re-render the pane (selectors compare by reference).
      const same = (a: OrgNodeView | null, b: OrgNodeView | null) =>
        a !== null && b !== null && a.id === b.id && a.state === b.state && a.name === b.name;
      return {
        liveNode: same(s.liveNode, nextLive) ? s.liveNode : nextLive,
        pinnedNode: same(s.pinnedNode, nextPinned) ? s.pinnedNode : nextPinned,
      };
    }),
}));

/** The node the left chat area should show right now (pin wins over follow). */
export function shownCorpNode(s: {
  pinnedNode: OrgNodeView | null;
  liveNode: OrgNodeView | null;
}): OrgNodeView | null {
  return s.pinnedNode ?? s.liveNode;
}
