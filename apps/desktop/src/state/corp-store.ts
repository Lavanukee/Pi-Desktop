/**
 * Renderer state for the EXPERIMENTAL coordination harness. Tracks
 *
 *  - the active task id,
 *  - the SITUATION — the task's CoordinationEvent stream folded through
 *    `reduceSituation` (the same fold `SituationRoomHost` runs), which the
 *    inline corp turn in the chat thread renders live,
 *  - the FOLLOWED node — the top-most node actually running right now, folded
 *    from each org-chart snapshot (`followTarget`), and
 *  - an optional user PIN — a clicked node that sticks until the user resumes
 *    following (clicking the pinned node again, or "follow live").
 *
 * Gated entirely behind the production-harness flag — untouched when off.
 */
import {
  followTarget,
  initialSituation,
  reduceSituation,
  type SituationState,
} from '@pi-desktop/canvas';
import type {
  CoordinationEvent,
  OrgChartView,
  OrgNodeView,
  WorkerActivityEvent,
} from '@pi-desktop/coordination';
import { create } from 'zustand';

/**
 * One accumulated block of a node's LIVE feed — the renderer-side mirror of the
 * engine's per-node streaming, grown by PUSHED {@link WorkerActivityEvent}
 * deltas (never a poll). `text`/`thinking` blocks GROW their `text` per token so
 * `<Markdown>` re-renders live (exactly the normal chat's per-delta accumulation);
 * `tool`/`file` blocks are discrete rows (a `file` block's +N/−N counts tick up
 * in real time). Mirrors pi-slice's text/thinking block growth.
 */
export type CorpBlock =
  | { kind: 'text'; text: string; streaming: boolean }
  | { kind: 'thinking'; text: string; streaming: boolean }
  | { kind: 'tool'; toolName: string; label?: string; detail?: string; path?: string }
  | { kind: 'file'; path: string; label?: string; addedLines: number; removedLines: number };

/** Settle the trailing text/thinking block (its live flag off), if any — the
 * renderer's mirror of the engine's `closeStream`: a tool/file/next-block start
 * ends the preceding streaming tail. Returns a NEW array only when it changed. */
function closeTrailingStream(blocks: CorpBlock[]): void {
  const last = blocks[blocks.length - 1];
  if (last !== undefined && (last.kind === 'text' || last.kind === 'thinking') && last.streaming) {
    blocks[blocks.length - 1] = { ...last, streaming: false };
  }
}

/**
 * Fold ONE {@link WorkerActivityEvent} into a node's accumulated blocks — pure,
 * returns a fresh array (so a selector notices the growth). Mirrors the engine's
 * `streamInto`/`mapRoleActivity`: `text`/`thinking` open→grow→close a streaming
 * block by phase; a `tool` step is a discrete row; a `file` step is a row whose
 * +N/−N accumulate across repeat writes to the same path. Exported for tests.
 */
export function appendWorkerActivity(
  prev: readonly CorpBlock[],
  event: WorkerActivityEvent,
): CorpBlock[] {
  const blocks = prev.slice();
  switch (event.kind) {
    case 'text':
    case 'thinking': {
      const blockKind = event.kind;
      const last = blocks[blocks.length - 1];
      const openMatches =
        last !== undefined && last.kind === blockKind && last.streaming ? last : undefined;
      if (event.phase === 'start') {
        closeTrailingStream(blocks);
        blocks.push({ kind: blockKind, text: event.delta ?? '', streaming: true });
        return blocks;
      }
      if (event.phase === 'end') {
        if (openMatches !== undefined) {
          // The `end` may carry the authoritative full text (a provider that only
          // reports on end) — replace with it, matching the engine's line.
          const text =
            event.delta !== undefined && event.delta.length > 0 ? event.delta : openMatches.text;
          blocks[blocks.length - 1] = { kind: blockKind, text, streaming: false };
        } else if (event.delta !== undefined && event.delta.length > 0) {
          blocks.push({ kind: blockKind, text: event.delta, streaming: false });
        }
        return blocks;
      }
      // delta (or a bare delta with no phase)
      if (openMatches !== undefined) {
        blocks[blocks.length - 1] = {
          kind: blockKind,
          text: openMatches.text + (event.delta ?? ''),
          streaming: true,
        };
      } else {
        closeTrailingStream(blocks);
        blocks.push({ kind: blockKind, text: event.delta ?? '', streaming: true });
      }
      return blocks;
    }
    case 'tool': {
      closeTrailingStream(blocks);
      blocks.push({
        kind: 'tool',
        toolName: event.toolName ?? 'tool',
        ...(event.label !== undefined ? { label: event.label } : {}),
        ...(event.detail !== undefined ? { detail: event.detail } : {}),
        ...(event.path !== undefined ? { path: event.path } : {}),
      });
      return blocks;
    }
    case 'file': {
      closeTrailingStream(blocks);
      const path = event.path ?? '';
      const last = blocks[blocks.length - 1];
      if (last !== undefined && last.kind === 'file' && last.path === path) {
        // A repeat write to the SAME tail path ticks +N/−N up in real time.
        blocks[blocks.length - 1] = {
          kind: 'file',
          path,
          ...(last.label !== undefined
            ? { label: last.label }
            : event.label !== undefined
              ? { label: event.label }
              : {}),
          addedLines: last.addedLines + (event.addedLines ?? 0),
          removedLines: last.removedLines + (event.removedLines ?? 0),
        };
      } else {
        blocks.push({
          kind: 'file',
          path,
          ...(event.label !== undefined ? { label: event.label } : {}),
          addedLines: event.addedLines ?? 0,
          removedLines: event.removedLines ?? 0,
        });
      }
      return blocks;
    }
    default:
      return blocks;
  }
}

interface CorpStoreState {
  /** The active corp task id (an inline corp turn renders it), or null. */
  taskId: string | null;
  /**
   * The task's folded event stream (`reduceSituation` output) — what the
   * inline corp turn renders. Null until the task's first event arrives.
   */
  situation: SituationState | null;
  /** Auto-followed node: the top-most node actually running (sticky). */
  liveNode: OrgNodeView | null;
  /** User-pinned node — overrides the follow; null = following live. */
  pinnedNode: OrgNodeView | null;
  /**
   * The run's live context fullness (0..100) — the latest reading from the
   * followed/pinned node's transcript. The composer's context ring prefers this
   * while a corp task is active, so the circle actually FILLS during a run.
   */
  contextPercent: number | null;
  /**
   * Per-node accumulated live blocks, keyed by nodeId — the PUSH mirror of the
   * engine's per-node streaming, grown from `worker-activity` deltas. The inline
   * chat feed renders the shown node's blocks live (per token) instead of polling
   * the transcript, so a watched agent streams exactly like the normal chat.
   */
  workerBlocks: Record<string, CorpBlock[]>;
  /** Start tracking a new corp task (clears situation + follow + pin + blocks). */
  setTask: (taskId: string | null) => void;
  /** Fold one CoordinationEvent into `situation` (SituationRoomHost's fold). */
  foldEvent: (event: CoordinationEvent) => void;
  /** Fold one `worker-activity` delta into the emitting node's block accumulator. */
  foldWorkerActivity: (event: WorkerActivityEvent) => void;
  /** Pin a clicked node; clicking the pinned node again resumes following. */
  selectNode: (node: OrgNodeView | null) => void;
  /** Drop the pin and resume following the running node. */
  followLive: () => void;
  /** Fold one org-chart snapshot: advance the follow target + refresh the
   * pinned node's live state (its gem/status must stay honest). */
  trackChart: (chart: OrgChartView) => void;
  /** Record the run's latest context reading (from a transcript poll). */
  setContextPercent: (percent: number) => void;
}

export const useCorpStore = create<CorpStoreState>((set) => ({
  taskId: null,
  situation: null,
  liveNode: null,
  pinnedNode: null,
  contextPercent: null,
  workerBlocks: {},
  setTask: (taskId) =>
    set({
      taskId,
      situation: null,
      liveNode: null,
      pinnedNode: null,
      contextPercent: null,
      workerBlocks: {},
    }),
  // Same initial state as SituationRoomHost: `initialSituation(taskId ?? '')`,
  // then one `reduceSituation` per event.
  foldEvent: (event) =>
    set((s) => ({
      situation: reduceSituation(s.situation ?? initialSituation(s.taskId ?? ''), event),
    })),
  foldWorkerActivity: (event) =>
    set((s) => {
      const prev = s.workerBlocks[event.nodeId] ?? [];
      const next = appendWorkerActivity(prev, event);
      // A new array ref per delta so the shown-node selector re-renders live;
      // other nodes' arrays keep their ref, so their panes don't churn.
      return { workerBlocks: { ...s.workerBlocks, [event.nodeId]: next } };
    }),
  setContextPercent: (percent) =>
    set((s) => (s.contextPercent === percent ? s : { contextPercent: percent })),
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
