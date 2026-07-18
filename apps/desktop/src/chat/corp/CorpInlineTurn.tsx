/**
 * The corp run rendered INSIDE the chat as a normal assistant turn (the
 * "you never left your conversation" reframe): the CEO — the model the user was
 * already talking to — is answering the question; it just happens to be waiting
 * on a pile of subagents. The delegation reads as a familiar in-progress tool
 * call (the ActivityChain collapsed-summary interaction), clean by default and
 * expandable when the user is curious:
 *
 *  - State A (collapsed): a shimmering "Waiting for N of M tasks to finish ·
 *    K in progress" summary over the honest progress rail. When the run is
 *    done it settles to "✓ Delivered N tasks with a team of A" (no shimmer,
 *    no spinner) plus a "Build snapshot" button — ONLY when there is actually
 *    a snapshot to open (`peekAvailable`).
 *  - State B (expanded): one row per org-chart node — status glyph, name, a
 *    live status line, and a spinner only while that node is working. Active
 *    rows sort to the top (working → blocked → queued → done → stopped). A
 *    lead (`ceo`/`manager`) that is working reads "waiting for other
 *    subagents to finish"; a builder shows its real `currentAction`.
 *  - State C (a row expanded): that node's REAL live stream, rendered through
 *    the same {@link CorpWorkerFeed} the worker pane uses, fetched via the
 *    injected `fetchTranscript` and polled while the node is still working
 *    (the worker pane's cadence). One row open at a time.
 *
 * Pure/props-driven: renders a folded {@link SituationState}; transcripts
 * arrive via `fetchTranscript` (IPC in the app, the scripted mock in demos and
 * tests). Nothing here talks to stores or the engine directly.
 */
import { contractProgress, formatEta, type SituationState, workingCount } from '@pi-desktop/canvas';
import type { OrgNodeView, WorkerTranscriptView } from '@pi-desktop/coordination';
import { Button, IconCheck, IconChevronRight, IconEye, ShimmerText, Spinner } from '@pi-desktop/ui';
import { useEffect, useState } from 'react';
import { CorpWorkerFeed } from './CorpWorkerPane';
import './CorpInlineTurn.css';

/** Transcript poll cadence — mirrors CorpWorkerPane (fast while streaming). */
const POLL_MS = 900;
const POLL_STREAMING_MS = 350;

export interface CorpInlineTurnProps {
  taskId: string;
  /** The folded corp event stream (reduceSituation output). */
  state: SituationState;
  /** One node's live transcript (IPC in the app; the mock in demos/tests). */
  fetchTranscript: (nodeId: string) => Promise<WorkerTranscriptView | null>;
  /** There is a build snapshot to open — the peek button only renders then. */
  peekAvailable: boolean;
  /** Open the Build snapshot. */
  onPeek?: () => void;
}

/** The engine's raw "thinking" action reads as a live "thinking…" to a person. */
function actionText(action: string): string {
  return action === 'thinking' ? 'thinking…' : action;
}

/** The one-line status a subagent row shows for its node's live state. */
function rowStatusLine(node: OrgNodeView): string {
  switch (node.state) {
    case 'working':
      // A lead's "work" is coordination — say so instead of echoing an action.
      if (node.role === 'ceo' || node.role === 'manager') {
        return 'waiting for other subagents to finish';
      }
      return node.currentAction !== undefined ? actionText(node.currentAction) : 'working…';
    case 'done':
      return 'done';
    case 'blocked':
      return 'blocked';
    case 'retired':
      return 'stopped';
    default:
      return 'queued';
  }
}

/** Active rows on top: working → blocked → queued → done → stopped. */
const STATE_RANK: Record<OrgNodeView['state'], number> = {
  working: 0,
  blocked: 1,
  idle: 2,
  done: 3,
  retired: 4,
};

/** Stable ordering: rank by state, keep the chart's order within a rank. */
function orderRows(nodes: readonly OrgNodeView[]): readonly OrgNodeView[] {
  return nodes
    .map((node, index) => ({ node, index }))
    .sort((a, b) => STATE_RANK[a.node.state] - STATE_RANK[b.node.state] || a.index - b.index)
    .map((entry) => entry.node);
}

/** The row's status glyph: the sitroom gem while live, a check when done,
 * a hollow ring when queued/stopped — the situation room's design language. */
function RowGlyph({ state }: { state: OrgNodeView['state'] }) {
  if (state === 'done') {
    return (
      <span className="pd-corpturn-glyph" data-state="done" aria-hidden>
        <IconCheck size={11} />
      </span>
    );
  }
  if (state === 'working' || state === 'blocked') {
    return (
      <span className="pd-corpturn-glyph pd-sitroom-gem" data-state={state} aria-hidden>
        <span className="pd-sitroom-gem-glow" />
        <span className="pd-sitroom-gem-ring" />
        <span className="pd-sitroom-gem-core" />
      </span>
    );
  }
  return (
    <span className="pd-corpturn-glyph" data-state={state} aria-hidden>
      <span className="pd-corpturn-glyph-hollow" />
    </span>
  );
}

/** Poll-burst dedupe (the worker pane's rule): a fresh snapshot that shows
 * nothing new must not re-render the feed. Compares the growth surface. */
function sameSnapshot(prev: WorkerTranscriptView, next: WorkerTranscriptView): boolean {
  if (prev.nodeId !== next.nodeId || prev.lines.length !== next.lines.length) return false;
  if (prev.streaming !== next.streaming || prev.currentAction !== next.currentAction) return false;
  const a = prev.lines[prev.lines.length - 1];
  const b = next.lines[next.lines.length - 1];
  return a?.text === b?.text && a?.streaming === b?.streaming;
}

interface RowFeedProps {
  node: OrgNodeView;
  fetchTranscript: (nodeId: string) => Promise<WorkerTranscriptView | null>;
}

/** State C: the expanded row's live stream — fetch, then poll while working. */
function RowFeed({ node, fetchTranscript }: RowFeedProps) {
  const [transcript, setTranscript] = useState<WorkerTranscriptView | null>(null);
  const [loading, setLoading] = useState(true);
  const working = node.state === 'working';

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pull = () => {
      void fetchTranscript(node.id).then((t) => {
        if (cancelled) return;
        setLoading(false);
        if (t !== null) {
          setTranscript((prev) => (prev !== null && sameSnapshot(prev, t) ? prev : t));
        }
        // Keep polling only while the node is actually working (the worker
        // pane's cadence: fast while the model streams, calm otherwise).
        if (!working) return;
        timer = setTimeout(pull, t?.streaming === true ? POLL_STREAMING_MS : POLL_MS);
      });
    };
    pull();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [node.id, fetchTranscript, working]);

  return (
    <div className="pd-corpturn-rowfeed" data-testid="corp-inline-feed">
      <CorpWorkerFeed
        transcript={transcript}
        working={working}
        loading={loading}
        nodeState={node.state}
      />
    </div>
  );
}

export function CorpInlineTurn({
  taskId,
  state,
  fetchTranscript,
  peekAvailable,
  onPeek,
}: CorpInlineTurnProps) {
  const [expanded, setExpanded] = useState(false);
  const [openNodeId, setOpenNodeId] = useState<string | null>(null);

  const progress = contractProgress(state);
  const busy = workingCount(state.chart);
  const terminal =
    state.status === 'done' || state.status === 'aborted' || state.status === 'error';
  const delivered = state.status === 'done';
  const eta = terminal ? '' : formatEta(state.eta);
  const agentCount = state.chart.nodes.length;
  const remaining = Math.max(0, progress.total - progress.done);

  // Honest pre-plan fallback (no checklist yet): the surface's plain phrasing.
  const waitLabel =
    progress.total > 0
      ? `Waiting for ${remaining} of ${progress.total} tasks to finish · ${busy} in progress`
      : (state.statusDetail ??
        (state.status === 'starting' ? 'Getting started' : 'Forming a plan'));

  const terminalLabel = delivered
    ? `Delivered ${progress.total} tasks with a team of ${agentCount}`
    : state.status === 'aborted'
      ? `Stopped after ${progress.done} of ${progress.total} tasks`
      : (state.result?.error ?? 'Something went wrong');

  return (
    <div
      className="pd-corpturn"
      data-testid="corp-inline-turn"
      data-status={state.status}
      data-task-id={taskId}
    >
      {/* The assistant gem: this is Pi answering, not a separate panel. */}
      <span
        className="pd-corpturn-gem pd-sitroom-gem"
        data-state={terminal ? (delivered ? 'done' : 'idle') : 'working'}
        aria-hidden
      >
        {delivered ? (
          <IconCheck size={11} />
        ) : (
          <>
            <span className="pd-sitroom-gem-glow" />
            <span className="pd-sitroom-gem-ring" />
            <span className="pd-sitroom-gem-core" />
          </>
        )}
      </span>

      <div className="pd-corpturn-main">
        <div className="pd-corpturn-headrow">
          <button
            type="button"
            className="pd-corpturn-summary pd-focusable"
            aria-expanded={expanded}
            data-testid="corp-inline-summary"
            onClick={() => setExpanded((v) => !v)}
          >
            {terminal ? (
              <span className="pd-corpturn-summary-text" data-testid="corp-inline-done">
                {delivered ? (
                  <span className="pd-corpturn-donecheck" aria-hidden>
                    <IconCheck size={12} />
                  </span>
                ) : null}
                {terminalLabel}
              </span>
            ) : (
              <span className="pd-corpturn-summary-text">
                <ShimmerText>{waitLabel}</ShimmerText>
              </span>
            )}
            {eta !== '' ? (
              <span className="pd-corpturn-eta" data-confidence={state.eta?.confidence ?? 'low'}>
                {eta}
              </span>
            ) : null}
            <span className="pd-corpturn-chevron" data-expanded={expanded}>
              <IconChevronRight size={14} />
            </span>
          </button>
          {delivered && peekAvailable ? (
            <Button
              variant="outline"
              size="sm"
              data-testid="corp-inline-peek"
              onClick={() => onPeek?.()}
            >
              <IconEye size={13} />
              Build snapshot
            </Button>
          ) : null}
        </div>

        {/* The honest progress rail (the situation room's): fill exists only
            once tasks do. */}
        <div
          className="pd-corpturn-rail"
          role="progressbar"
          aria-valuenow={progress.done}
          aria-valuemin={0}
          aria-valuemax={progress.total > 0 ? progress.total : undefined}
          aria-label="Tasks finished"
        >
          <span
            className="pd-corpturn-rail-fill"
            style={
              progress.total > 0
                ? { width: `${(progress.done / progress.total) * 100}%` }
                : undefined
            }
          />
        </div>

        {expanded ? (
          <ul className="pd-corpturn-rows" data-testid="corp-inline-rows">
            {orderRows(state.chart.nodes).map((node) => {
              const open = openNodeId === node.id;
              return (
                <li key={node.id} className="pd-corpturn-rowwrap">
                  <button
                    type="button"
                    className="pd-corpturn-row pd-focusable"
                    data-state={node.state}
                    data-node-id={node.id}
                    aria-expanded={open}
                    onClick={() => setOpenNodeId((cur) => (cur === node.id ? null : node.id))}
                  >
                    <RowGlyph state={node.state} />
                    <span className="pd-corpturn-row-name">{node.name}</span>
                    <span className="pd-corpturn-row-status" data-state={node.state}>
                      {rowStatusLine(node)}
                    </span>
                    {node.state === 'working' ? (
                      <Spinner size={11} className="pd-corpturn-row-spinner" />
                    ) : null}
                  </button>
                  {open ? (
                    <RowFeed key={node.id} node={node} fetchTranscript={fetchTranscript} />
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
