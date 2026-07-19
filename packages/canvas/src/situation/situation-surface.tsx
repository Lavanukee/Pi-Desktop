/**
 * The situation room — the live canvas view of the coordination harness
 * working (docs/harness-architecture.md §11). A CLEAN subagent navigator:
 * a header (phase gem + plain-language phase line + honest task progress +
 * ETA range + peek button over the progress rail) above exactly two
 * collapsible sections —
 *
 *  - "Subagents": one clickable row per subagent (bold name + its live
 *    current action, rendered with the chat's activity-row visual — the
 *    branded spinner + shimmering action while working, a soft check +
 *    muted "done" when finished, muted "queued" while waiting). Clicking a
 *    row routes that worker's live stream to the app's left pane.
 *  - "Plan": the checklist, checked off from real contract state.
 *
 * The room measures its own width and adapts: wide, the plan sits in a side
 * rail; narrow, it restacks into the column; tight, the plan auto-collapses
 * (a user toggle always wins). Collapsed sections keep an honest one-line
 * live summary.
 *
 * All user-facing copy says what is happening TO THE USER'S PROJECT — plain
 * language, never the harness's internal org vocabulary.
 *
 * Pure/props-driven: {@link SituationRoomSurface} renders a folded
 * {@link SituationState}; {@link SituationRoomHost} folds a live
 * `CoordinationEvent` stream (any engine — or the scripted mock) into it.
 */

import type {
  ArtifactRef,
  CoordinationEvent,
  ExerciseSessionView,
  OrgNodeView,
} from '@pi-desktop/coordination';
import {
  ActivityRow,
  Button,
  IconCheck,
  IconChevronDown,
  IconEye,
  ShimmerText,
  Spinner,
} from '@pi-desktop/ui';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { ExercisePanel } from './exercise-panel.tsx';
import { PlanPanel } from './plan-panel.tsx';
import {
  contractProgress,
  formatClock,
  formatDuration,
  formatEta,
  initialSituation,
  type NodeTiming,
  nodeElapsedMs,
  reduceSituation,
  type SituationState,
} from './situation-model.ts';

/** The app's experience level (round-12 userMode): gates raw-path detail. */
export type SituationUserMode = 'user' | 'power';

export interface SituationRoomSurfaceProps {
  state: SituationState;
  /** Open the current best artifact ("peek at what we have so far"). */
  onPeek?: (artifact: ArtifactRef) => void;
  /** Accepted for API stability; the simplified room has no raw-path detail to gate. */
  userMode?: SituationUserMode;
  /** Clicking a worker routes its live stream to the app (left chat area). */
  onSelectNode?: (node: OrgNodeView) => void;
  selectedNodeId?: string;
  /**
   * Per-node working timing (from the app's corp store) — each subagent row
   * shows a live `m:ss` timer while working and "finished in Nm Ns" once done.
   * Absent = no timers (the surface stays honest; nothing invented).
   */
  nodeTiming?: Record<string, NodeTiming>;
  className?: string;
}

/** The newest artifact — what "peek" opens. */
export function latestArtifact(state: SituationState): ArtifactRef | undefined {
  const fromResult = state.result?.artifacts;
  if (fromResult && fromResult.length > 0) return fromResult[fromResult.length - 1];
  return state.artifacts.length > 0 ? state.artifacts[state.artifacts.length - 1] : undefined;
}

/** Plain-language phase line: what is happening to the user's project. */
function phaseLabel(state: SituationState): string {
  switch (state.status) {
    case 'starting':
      return state.statusDetail ?? 'Getting started';
    case 'planning':
      return state.statusDetail ?? 'Forming a plan';
    case 'working':
      return state.statusDetail ?? 'Building it';
    case 'reviewing':
      return state.statusDetail ?? 'Checking the work';
    case 'blocked':
      return state.statusDetail ?? 'Waiting on you';
    case 'done':
      return state.result?.summary ?? 'Ready';
    case 'aborted':
      return 'Stopped';
    case 'error':
      return state.result?.error ?? 'Something went wrong';
  }
}

const LIVE_STATUSES = new Set(['starting', 'planning', 'working', 'reviewing']);

/** The room's collapsible sections (each gets its own expand/collapse). */
type SectionId = 'agents' | 'plan';

/** Below this room width the plan restacks from the side rail into the column. */
const STACK_WIDTH = 640;
/** Below this room width the plan auto-collapses (a user toggle always wins). */
const TIGHT_WIDTH = 460;

/**
 * The subagents the navigator lists: every chart node EXCEPT the single root
 * (CEO / solo) — the root is the "you" node, the agent the user is already
 * talking to in the chat pane, not one of its own subagents. Managers,
 * specialists, work areas and builders all list.
 */
function subagentNodes(nodes: readonly OrgNodeView[]): readonly OrgNodeView[] {
  return nodes.filter(
    (n) => !(n.parentId === undefined && (n.role === 'ceo' || n.role === 'solo')),
  );
}

/**
 * A `now` that ticks each second while `active` — the per-subagent timers read
 * from it (`now − startedAt`). Idle: no interval (frozen timers don't need it),
 * so nothing leaks. Mirrors apps/desktop HarnessStatus.tsx's `useElapsed`, but
 * kept surface-local since the canvas is a framework-lib.
 */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export function SituationRoomSurface({
  state,
  onPeek,
  onSelectNode,
  selectedNodeId,
  nodeTiming,
  className,
}: SituationRoomSurfaceProps) {
  const progress = contractProgress(state);
  const live = LIVE_STATUSES.has(state.status);
  const eta = live ? formatEta(state.eta) : '';
  const peekTarget = latestArtifact(state);

  // Adaptive layout: the room watches its OWN width (it lives in a resizable
  // rail) and restacks/auto-collapses sections to stay legible at any size.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w !== undefined) setWidth(w);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const stacked = width !== null && width < STACK_WIDTH;
  const tight = width !== null && width < TIGHT_WIDTH;

  // Per-section collapse: `undefined` = automatic (open, unless the room is
  // tight); a user toggle overrides the automatics until toggled back.
  const [secOverride, setSecOverride] = useState<Partial<Record<SectionId, boolean>>>({});
  const secOpen = (id: SectionId): boolean => {
    const auto = id === 'plan' ? !tight : true;
    return secOverride[id] ?? auto;
  };
  const toggleSec = (id: SectionId) => {
    const next = !secOpen(id);
    setSecOverride((prev) => ({ ...prev, [id]: next }));
  };

  // Honest live summaries for collapsed (and quiet) section headers.
  const subagents = subagentNodes(state.chart.nodes);
  const busy = subagents.filter((n) => n.state === 'working').length;
  // A shared 1s clock, ticking only while a subagent is at work, drives every
  // row's live timer; frozen ("finished in") timers read `finishedAt` and ignore it.
  const now = useNow(busy > 0);
  const agentsSummary = busy > 0 ? `${busy} at work` : undefined;
  const planSummary = progress.total > 0 ? `${progress.done}/${progress.total}` : undefined;

  // Exercise panel lifecycle: slide in while a session RUNS; on a terminal
  // status hold the verdict briefly, then slide away. A session that is
  // already terminal when first seen (history replay) never flashes in.
  const session = state.exercise;
  const [shownSession, setShownSession] = useState<ExerciseSessionView | undefined>(undefined);
  const [leaving, setLeaving] = useState(false);
  const seenRunning = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!session) return undefined;
    if (session.status === 'running') {
      seenRunning.current = session.id;
      setShownSession(session);
      setLeaving(false);
      return undefined;
    }
    if (seenRunning.current !== session.id) return undefined;
    setShownSession(session);
    const hold = setTimeout(() => setLeaving(true), 1600);
    const gone = setTimeout(() => {
      setShownSession(undefined);
      setLeaving(false);
    }, 2100);
    return () => {
      clearTimeout(hold);
      clearTimeout(gone);
    };
  }, [session]);

  const planSection = (
    <RoomSection
      id="plan"
      title="Plan"
      summary={planSummary}
      open={secOpen('plan')}
      onToggle={toggleSec}
    >
      <PlanPanel items={state.checklist} />
    </RoomSection>
  );

  const rootClass = ['pd-sitroom', className].filter(Boolean).join(' ');
  return (
    <div
      className={rootClass}
      ref={rootRef}
      data-status={state.status}
      data-stacked={stacked || undefined}
      data-testid="situation-room"
    >
      <header className="pd-sitroom-header">
        <span
          className="pd-sitroom-status pd-sitroom-gem"
          data-status={state.status}
          data-state={live ? 'working' : state.status === 'blocked' ? 'blocked' : 'idle'}
          aria-hidden="true"
        >
          {state.status === 'done' ? (
            <IconCheck size={11} />
          ) : (
            <>
              <span className="pd-sitroom-gem-glow" />
              <span className="pd-sitroom-gem-ring" />
              <span className="pd-sitroom-gem-core" />
            </>
          )}
        </span>
        <span className="pd-sitroom-phase">
          {live ? <ShimmerText>{phaseLabel(state)}</ShimmerText> : phaseLabel(state)}
        </span>
        <span className="pd-sitroom-header-spacer" />
        {progress.total > 0 ? (
          <span className="pd-sitroom-contracts">
            <strong>{progress.done}</strong>
            <span> of {progress.total} tasks</span>
          </span>
        ) : null}
        {eta !== '' ? (
          <span className="pd-sitroom-eta" data-confidence={state.eta?.confidence ?? 'low'}>
            {eta}
          </span>
        ) : null}
        <Button
          variant="outline"
          size="sm"
          disabled={peekTarget === undefined}
          title={peekTarget?.title}
          onClick={() => {
            if (peekTarget && onPeek) onPeek(peekTarget);
          }}
        >
          <IconEye size={13} />
          {state.status === 'done' ? 'View the build' : 'Peek at the build'}
        </Button>
      </header>

      <div
        className="pd-sitroom-rail"
        role="progressbar"
        aria-valuenow={progress.done}
        aria-valuemin={0}
        aria-valuemax={progress.total > 0 ? progress.total : undefined}
        aria-label="Tasks finished"
      >
        {/* Honest by construction: the fill exists only once tasks do. */}
        <span
          className="pd-sitroom-rail-fill"
          style={
            progress.total > 0 ? { width: `${(progress.done / progress.total) * 100}%` } : undefined
          }
        />
      </div>

      <div className="pd-sitroom-body">
        <div className="pd-sitroom-main pd-scroll">
          <RoomSection
            id="agents"
            title="Subagents"
            summary={agentsSummary}
            live={busy > 0}
            open={secOpen('agents')}
            onToggle={toggleSec}
          >
            <SubagentList
              nodes={subagents}
              onSelectNode={onSelectNode}
              selectedNodeId={selectedNodeId}
              nodeTiming={nodeTiming}
              now={now}
            />
          </RoomSection>
          {stacked ? planSection : null}
        </div>
        {!stacked ? <aside className="pd-sitroom-side">{planSection}</aside> : null}
        {/* The exercise panel overlays the BODY (not the scroll column), so the
            headline moment stays in view regardless of scroll or collapse. */}
        {shownSession !== undefined ? (
          <ExercisePanel session={shownSession} leaving={leaving} />
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Room sections — self-contained, collapsible, never-overlapping
// ---------------------------------------------------------------------------

interface RoomSectionProps {
  id: SectionId;
  title: string;
  /** One-line live summary shown beside the title (honest, never invented). */
  summary?: string;
  /** Puts the tiny live gem beside the title while work is actually running. */
  live?: boolean;
  open: boolean;
  onToggle: (id: SectionId) => void;
  children: ReactNode;
}

/** One collapsible slice of the room: a premium header row (chevron + title +
 * live summary) over a grid-rows 0fr↔1fr body roll (the app's signature). */
function RoomSection({ id, title, summary, live, open, onToggle, children }: RoomSectionProps) {
  return (
    <section className="pd-sitroom-sec" data-sec={id} data-testid={`sitroom-section-${id}`}>
      <button
        type="button"
        className="pd-sitroom-sec-head pd-focusable"
        aria-expanded={open}
        onClick={() => onToggle(id)}
      >
        <span className="pd-sitroom-sec-chevron" data-open={open || undefined} aria-hidden="true">
          <IconChevronDown size={12} />
        </span>
        <span className="pd-sitroom-sec-title">{title}</span>
        {live ? (
          <span className="pd-sitroom-gem pd-sitroom-sec-gem" data-state="working" aria-hidden>
            <span className="pd-sitroom-gem-glow" />
            <span className="pd-sitroom-gem-ring" />
            <span className="pd-sitroom-gem-core" />
          </span>
        ) : null}
        {summary !== undefined ? <span className="pd-sitroom-sec-summary">{summary}</span> : null}
      </button>
      <div className="pd-sitroom-sec-body" data-collapsed={!open || undefined}>
        <div className="pd-sitroom-sec-inner">{children}</div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Subagent navigator — one clickable row per subagent (bold name + the live
// current action, in the chat's activity-row visual)
// ---------------------------------------------------------------------------

/** The engine's raw "thinking" action reads as a live "thinking…" to a person. */
function actionText(action: string): string {
  return action === 'thinking' ? 'thinking…' : action;
}

/** The one-line status a subagent row shows for its node's live state —
 * exactly the chat's wording (CorpInlineTurn's rowStatusLine). A finished node
 * with known timing reads "finished in Nm Ns" (Point 4c) instead of a bare "done". */
function agentStatusLine(node: OrgNodeView, elapsedMs?: number): string {
  switch (node.state) {
    case 'working':
      // A lead's "work" is coordination — say so instead of echoing an action.
      if (node.role === 'ceo' || node.role === 'manager') {
        return 'waiting for other subagents to finish';
      }
      return node.currentAction !== undefined ? actionText(node.currentAction) : 'working…';
    case 'done':
      return elapsedMs !== undefined ? `finished in ${formatDuration(elapsedMs)}` : 'done';
    case 'blocked':
      return 'blocked';
    case 'retired':
      return elapsedMs !== undefined ? `finished in ${formatDuration(elapsedMs)}` : 'stopped';
    default:
      return 'queued';
  }
}

/** Active rows on top (the chat's order): working → blocked → queued → done → stopped. */
const STATE_RANK: Record<OrgNodeView['state'], number> = {
  working: 0,
  blocked: 1,
  idle: 2,
  done: 3,
  retired: 4,
};

/** Stable ordering: rank by state, keep the chart's order within a rank. */
function orderSubagents(nodes: readonly OrgNodeView[]): readonly OrgNodeView[] {
  return nodes
    .map((node, index) => ({ node, index }))
    .sort((a, b) => STATE_RANK[a.node.state] - STATE_RANK[b.node.state] || a.index - b.index)
    .map((entry) => entry.node);
}

/** The row's icon-slot glyph: the chat activity row's own marks — Spinner
 * while working (ActivityRow's running visual), a check when done, a quiet
 * hollow ring while queued / blocked / stopped. */
function agentGlyph(state: OrgNodeView['state']): ReactNode {
  if (state === 'working') return <Spinner size={13} />;
  if (state === 'done') return <IconCheck size={13} />;
  return <span className="pd-sitroom-agent-dot" />;
}

interface SubagentListProps {
  nodes: readonly OrgNodeView[];
  onSelectNode?: (node: OrgNodeView) => void;
  selectedNodeId?: string;
  /** Per-node working timing — drives each row's live/frozen timer. */
  nodeTiming?: Record<string, NodeTiming>;
  /** The shared 1s clock the live timers read from. */
  now: number;
}

/**
 * The subagent navigator: one {@link ActivityRow} per subagent — the SAME
 * component (icon slot + shimmering label) the chat thread renders activity
 * with — prefixed by the subagent's bold name. The whole row is the button:
 * clicking routes that worker's live stream to the app's left pane (the
 * row does not expand in place, so the expander chevron is suppressed in CSS).
 */
function SubagentList({ nodes, onSelectNode, selectedNodeId, nodeTiming, now }: SubagentListProps) {
  const ordered = orderSubagents(nodes);
  if (ordered.length === 0) {
    return <div className="pd-sitroom-feed-empty">Waiting for the work to start…</div>;
  }
  return (
    <div className="pd-sitroom-agents" data-testid="subagent-list">
      {ordered.map((node) => {
        const working = node.state === 'working';
        const elapsed = nodeElapsedMs(nodeTiming?.[node.id], now);
        const line = agentStatusLine(node, elapsed);
        return (
          <ActivityRow
            key={node.id}
            className="pd-sitroom-agent"
            data-testid="subagent-row"
            data-node-id={node.id}
            data-state={node.state}
            data-selected={selectedNodeId === node.id || undefined}
            aria-expanded={undefined}
            title={onSelectNode !== undefined ? `Watch ${node.name} live` : undefined}
            icon={agentGlyph(node.state)}
            label={
              <>
                <strong className="pd-sitroom-agent-name">{node.name}</strong>
                {working ? (
                  <ShimmerText className="pd-sitroom-agent-action">{line}</ShimmerText>
                ) : (
                  <span className="pd-sitroom-agent-action">{line}</span>
                )}
                {/* The per-subagent timer: a live `m:ss` while working, frozen at
                    its final duration once done. Present only when the node has
                    actually started (honest — nothing invented for a queued row). */}
                {working && elapsed !== undefined ? (
                  <span className="pd-sitroom-agent-timer" data-testid="subagent-timer">
                    {formatClock(elapsed)}
                  </span>
                ) : null}
              </>
            }
            onClick={() => onSelectNode?.(node)}
          />
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Host — folds a live event stream into the renderable state
// ---------------------------------------------------------------------------

export interface SituationRoomHostProps {
  /**
   * The task's ordered event stream — `TaskHandle.events` from any
   * CoordinationEngine, or the scripted mock (`startMockCorpRun().events`).
   */
  events?: AsyncIterable<CoordinationEvent>;
  taskId?: string;
  onPeek?: (artifact: ArtifactRef) => void;
  userMode?: SituationUserMode;
  onSelectNode?: (node: OrgNodeView) => void;
  selectedNodeId?: string;
  /** Per-node working timing (from the app's corp store) — drives the row timers. */
  nodeTiming?: Record<string, NodeTiming>;
}

/**
 * Subscribes to the event stream and renders the surface live. One pass over
 * the iterable; unmounting stops consuming (the app owns stopping the engine).
 */
export function SituationRoomHost({
  events,
  taskId,
  onPeek,
  userMode,
  onSelectNode,
  selectedNodeId,
  nodeTiming,
}: SituationRoomHostProps) {
  const [state, setState] = useState<SituationState>(() => initialSituation(taskId ?? ''));

  useEffect(() => {
    if (!events) return undefined;
    let cancelled = false;
    setState(initialSituation(taskId ?? ''));
    // Start consuming on a fresh task, not synchronously: the stream is
    // single-consumer, and under StrictMode's dev double-mount a synchronous
    // start would leave a dead first consumer whose pending `next()` steals
    // events from the real one. The cleared timeout guarantees a cancelled
    // effect never touches the iterable at all.
    const timer = setTimeout(() => {
      void (async () => {
        try {
          for await (const event of events) {
            if (cancelled) return;
            setState((s) => reduceSituation(s, event));
          }
        } catch {
          // A broken stream leaves the last good state on screen.
        }
      })();
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [events, taskId]);

  if (!events) {
    return (
      <div className="pd-sitroom pd-sitroom--missing" data-testid="situation-room">
        <div className="pd-sitroom-chart-empty">No live run to watch.</div>
      </div>
    );
  }
  return (
    <SituationRoomSurface
      state={state}
      onPeek={onPeek}
      userMode={userMode}
      onSelectNode={onSelectNode}
      selectedNodeId={selectedNodeId}
      nodeTiming={nodeTiming}
    />
  );
}
