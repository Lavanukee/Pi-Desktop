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
  type NodeTiming,
  nodeElapsedMs,
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
  | {
      kind: 'tool';
      toolName: string;
      label?: string;
      detail?: string;
      path?: string;
      /** Captured RESULT text (a bash command's output) — replaced in place as it
       * grows, so a terminal tab can mirror the command + its live output. */
      output?: string;
    }
  | {
      kind: 'file';
      path: string;
      label?: string;
      addedLines: number;
      removedLines: number;
      /** The written file BODY when the engine captured it (a structured write lands
       * it in full at completion) — the live file canvas renders THIS so the tab
       * shows the actual content, not a blank peek. Absent when only the line count
       * is known. */
      content?: string;
    };

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
      // An OUTPUT update for an already-open tool row (a bash command streaming its
      // result): fold it onto the most recent row of the same tool — replacing its
      // captured output in place — rather than pushing a duplicate row. A partial
      // then a final output both land on the SAME row this way.
      if (event.output !== undefined) {
        for (let i = blocks.length - 1; i >= 0; i--) {
          const b = blocks[i];
          if (
            b !== undefined &&
            b.kind === 'tool' &&
            b.toolName === (event.toolName ?? b.toolName)
          ) {
            blocks[i] = { ...b, output: event.output };
            return blocks;
          }
        }
        // No matching row yet (the output outran its start) — seed a row for it.
        closeTrailingStream(blocks);
        blocks.push({
          kind: 'tool',
          toolName: event.toolName ?? 'tool',
          ...(event.detail !== undefined ? { detail: event.detail } : {}),
          output: event.output,
        });
        return blocks;
      }
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
        // A repeat write to the SAME tail path ticks +N/−N up in real time. The
        // newest write's body wins (the completion carries the full file); a start
        // record (no body) keeps whatever content already landed.
        const content = event.content ?? last.content;
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
          ...(content !== undefined ? { content } : {}),
        };
      } else {
        blocks.push({
          kind: 'file',
          path,
          ...(event.label !== undefined ? { label: event.label } : {}),
          addedLines: event.addedLines ?? 0,
          removedLines: event.removedLines ?? 0,
          ...(event.content !== undefined ? { content: event.content } : {}),
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
  /** True while the task is live (from start until its terminal `done`/`status`
   * event). Drives the composer's Stop button — a follow-up-able but finished
   * task keeps its taskId, so taskId!==null alone can't mean "running". */
  corpRunning: boolean;
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
   * Per-node working timing, keyed by nodeId — `startedAt` stamped the first
   * time a node enters `working`, `finishedAt` when it leaves working→
   * `done`/`retired`. The one datum the neutral {@link OrgNodeView} lacks;
   * stamped here (app-state, not the pure fold) and threaded into the situation
   * surface so each subagent shows a live timer + a "finished in Nm Ns" line.
   */
  nodeTiming: Record<string, NodeTiming>;
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
  /** Fold one org-chart snapshot: advance the follow target, refresh the pinned
   * node's live state (its gem/status must stay honest), stamp per-node timing,
   * and auto-return (drop the pin) when the pinned node finishes. */
  trackChart: (chart: OrgChartView) => void;
  /** Record the run's latest context reading (from a transcript poll). */
  setContextPercent: (percent: number) => void;
}

export const useCorpStore = create<CorpStoreState>((set) => ({
  taskId: null,
  corpRunning: false,
  situation: null,
  liveNode: null,
  pinnedNode: null,
  contextPercent: null,
  workerBlocks: {},
  nodeTiming: {},
  setTask: (taskId) =>
    set({
      taskId,
      // A freshly-tracked task is running; setTask(null) clears the flag.
      corpRunning: taskId !== null,
      situation: null,
      liveNode: null,
      pinnedNode: null,
      contextPercent: null,
      workerBlocks: {},
      nodeTiming: {},
    }),
  // Same initial state as SituationRoomHost: `initialSituation(taskId ?? '')`,
  // then one `reduceSituation` per event.
  foldEvent: (event) =>
    set((s) => ({
      situation: reduceSituation(s.situation ?? initialSituation(s.taskId ?? ''), event),
      // The terminal `done` (completed / aborted / failed) ends the run — flip the
      // Stop button off. Follow-ups after this go through the CEO ask path.
      ...(event.type === 'done' ? { corpRunning: false } : {}),
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
      // PRESERVE THE CEO'S VISION across promotion: pre-promotion the vision streams
      // into `workerBlocks['solo']`; on promotion the chart swaps the `solo` node for a
      // `ceo` node, and the lead history feed reads `workerBlocks['ceo']` — which would
      // be empty, so the chat looked "deleted". Migrate the solo blocks onto `ceo` the
      // first time a `ceo` node appears (idempotent: solo is emptied, so it runs once).
      // The engine mirrors this on its transcript (getWorkerTranscript) for late-join.
      let workerBlocks = s.workerBlocks;
      const promoted = chart.nodes.some((n) => n.id === 'ceo');
      const soloBlocks = workerBlocks.solo;
      if (promoted && soloBlocks !== undefined && soloBlocks.length > 0) {
        workerBlocks = {
          ...workerBlocks,
          ceo: [...soloBlocks, ...(workerBlocks.ceo ?? [])],
          solo: [],
        };
      }
      const nextLive = followTarget(chart, s.liveNode?.id) ?? s.liveNode;
      // Keep the pinned node's state fresh from the chart (unknown id: keep as-is).
      const refreshedPin =
        s.pinnedNode !== null
          ? (chart.nodes.find((n) => n.id === s.pinnedNode?.id) ?? s.pinnedNode)
          : null;
      // AUTO-RETURN (STEP 5): a pinned node that just finished drops the pin
      // (followLive) so the chat returns to the CEO-waiting overview to pick
      // another / the CEO. Fires exactly once — once null, no chart re-triggers it.
      const pinnedJustFinished =
        s.pinnedNode !== null &&
        s.pinnedNode.state !== 'done' &&
        s.pinnedNode.state !== 'retired' &&
        refreshedPin !== null &&
        (refreshedPin.state === 'done' || refreshedPin.state === 'retired');
      const nextPinned = pinnedJustFinished ? null : refreshedPin;
      // Preserve object identity when nothing user-visible changed, so chart
      // bursts don't re-render the pane (selectors compare by reference).
      const same = (a: OrgNodeView | null, b: OrgNodeView | null) =>
        a !== null && b !== null && a.id === b.id && a.state === b.state && a.name === b.name;
      // Stamp per-node timing (STEP 1): startedAt on first `working`, finishedAt
      // when a started node leaves working→done/retired. Idempotent + additive —
      // a new object only when something changed, so the canvas subscription
      // (CanvasTabsPanel) fires on transitions, not on every chart burst.
      const timing = stampTiming(s.nodeTiming, chart);
      return {
        liveNode: same(s.liveNode, nextLive) ? s.liveNode : nextLive,
        pinnedNode: pinnedJustFinished
          ? null
          : same(s.pinnedNode, nextPinned)
            ? s.pinnedNode
            : nextPinned,
        ...(timing !== s.nodeTiming ? { nodeTiming: timing } : {}),
        ...(workerBlocks !== s.workerBlocks ? { workerBlocks } : {}),
      };
    }),
}));

// E2E hook (?piE2E): probes read/drive the corp store to assert the nested
// dropdown surfaces running roles. Mirrors the __pi_store / __child_store hooks.
if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('piE2E')) {
  (window as unknown as { __corp_store?: typeof useCorpStore }).__corp_store = useCorpStore;
}

/**
 * Stamp per-node working timing from one chart snapshot. `startedAt` lands the
 * first time a node is seen `working`; `finishedAt` lands when a node that had a
 * `startedAt` is `done`/`retired`. Pure + idempotent — returns the SAME object
 * when nothing changed (referential-equality change signal for subscribers). The
 * clock is `Date.now()` here (app-state, not the pure situation fold).
 */
function stampTiming(
  prev: Record<string, NodeTiming>,
  chart: OrgChartView,
): Record<string, NodeTiming> {
  let next: Record<string, NodeTiming> | null = null;
  for (const node of chart.nodes) {
    const cur = prev[node.id];
    if (node.state === 'working' && cur?.startedAt === undefined) {
      next ??= { ...prev };
      next[node.id] = { ...cur, startedAt: Date.now() };
      continue;
    }
    if (
      (node.state === 'done' || node.state === 'retired') &&
      cur?.startedAt !== undefined &&
      cur.finishedAt === undefined
    ) {
      next ??= { ...prev };
      next[node.id] = { ...cur, finishedAt: Date.now() };
    }
  }
  return next ?? prev;
}

/** The node the left chat area should show right now (pin wins over follow). */
export function shownCorpNode(s: {
  pinnedNode: OrgNodeView | null;
  liveNode: OrgNodeView | null;
}): OrgNodeView | null {
  return s.pinnedNode ?? s.liveNode;
}

/**
 * A node's elapsed working time in millis (live = `now − startedAt`; frozen =
 * `finishedAt − startedAt`; `undefined` if it never started) — the selector the
 * chat pane reads for its "finished in" line. Re-exports the canvas helper over
 * the store's timing map so callers don't reach into the shape.
 */
export function corpNodeElapsedMs(
  s: { nodeTiming: Record<string, NodeTiming> },
  nodeId: string,
  now: number,
): number | undefined {
  return nodeElapsedMs(s.nodeTiming[nodeId], now);
}
