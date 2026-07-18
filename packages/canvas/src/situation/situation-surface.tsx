/**
 * The situation room — the live canvas view of the coordination harness
 * working (docs/harness-architecture.md §11). Engagement, not a spinner: the
 * work tree grows with orchestrated motion as the plan forms, the file map
 * lights up as files land (with live +/− deltas for power users), the plan
 * checks itself off from real task state, the ETA is an honest narrowing
 * range, and when the run exercises its own work (browse / test / run) a
 * prominent activity panel slides in so the user SEES it.
 *
 * LAYOUT (the long-watch pass): the room is a column of self-contained,
 * individually collapsible SECTIONS — the team tree, the live activity feed,
 * the file map, and the plan — stacked in one scroll column so nothing ever
 * overlaps or clips at any panel size. The room measures its own width and
 * adapts: wide, the plan sits in a side rail; narrow, it restacks into the
 * column; tight, the heavier sections auto-collapse (a user toggle always
 * wins). Collapsed sections keep an honest one-line live summary.
 *
 * All user-facing copy says what is happening TO THE USER'S PROJECT — plain
 * language, never the harness's internal org vocabulary.
 *
 * Pure/props-driven: {@link SituationRoomSurface} renders a folded
 * {@link SituationState}; {@link SituationRoomHost} folds a live
 * `CoordinationEvent` stream (any engine — or the scripted mock) into it.
 */

import type {
  Activity,
  ArtifactRef,
  CoordinationEvent,
  ExerciseSessionView,
  OrgNodeView,
} from '@pi-desktop/coordination';
import {
  Button,
  IconChat,
  IconCheck,
  IconChevronDown,
  IconEye,
  IconFile,
  IconPuzzle,
  IconSparkles,
  IconTerminal,
  ShimmerText,
} from '@pi-desktop/ui';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { ExercisePanel } from './exercise-panel.tsx';
import { ModuleMapPanel } from './module-map-panel.tsx';
import { type DivisionProgress, SituationOrgChart } from './org-chart-panel.tsx';
import { PlanPanel } from './plan-panel.tsx';
import {
  contractProgress,
  fillModuleRegions,
  formatEta,
  groupChecklist,
  initialSituation,
  reduceSituation,
  type SituationState,
  workingCount,
} from './situation-model.ts';

/** The app's experience level (round-12 userMode): gates raw-path detail. */
export type SituationUserMode = 'user' | 'power';

export interface SituationRoomSurfaceProps {
  state: SituationState;
  /** Open the current best artifact ("peek at what we have so far"). */
  onPeek?: (artifact: ArtifactRef) => void;
  /** Power users see file paths + line deltas; everyone else the calm view. */
  userMode?: SituationUserMode;
  /** Clicking a worker routes its live stream to the app (left chat area). */
  onSelectNode?: (node: OrgNodeView) => void;
  selectedNodeId?: string;
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
type SectionId = 'team' | 'feed' | 'files' | 'plan';

/** Below this room width the plan restacks from the side rail into the column. */
const STACK_WIDTH = 640;
/** Below this room width the heavier sections auto-collapse (toggle wins). */
const TIGHT_WIDTH = 460;

export function SituationRoomSurface({
  state,
  onPeek,
  userMode = 'user',
  onSelectNode,
  selectedNodeId,
  className,
}: SituationRoomSurfaceProps) {
  const progress = contractProgress(state);
  const live = LIVE_STATUSES.has(state.status);
  const eta = live ? formatEta(state.eta) : '';
  const peekTarget = latestArtifact(state);

  const divisionProgress: DivisionProgress = Object.fromEntries(
    groupChecklist(state.checklist).map((g) => [g.name, { done: g.done, total: g.items.length }]),
  );

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
    const auto = id === 'files' || id === 'plan' ? !tight : true;
    return secOverride[id] ?? auto;
  };
  const toggleSec = (id: SectionId) => {
    const next = !secOpen(id);
    setSecOverride((prev) => ({ ...prev, [id]: next }));
  };

  // Honest live summaries for collapsed (and quiet) section headers.
  const busy = workingCount(state.chart);
  const teamSummary = busy > 0 ? `${busy} at work` : undefined;
  const latestActivity = state.activities[state.activities.length - 1];
  const feedSummary = !secOpen('feed') && latestActivity ? latestActivity.summary : undefined;
  const filesSummary = state.files.length > 0 ? `${state.files.length} files` : undefined;
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
            id="team"
            title="The team"
            summary={teamSummary}
            live={busy > 0}
            open={secOpen('team')}
            onToggle={toggleSec}
          >
            <SituationOrgChart
              chart={state.chart}
              progress={divisionProgress}
              userMode={userMode}
              onSelectNode={onSelectNode}
              selectedNodeId={selectedNodeId}
            />
          </RoomSection>
          <RoomSection
            id="feed"
            title="Live activity"
            summary={feedSummary}
            open={secOpen('feed')}
            onToggle={toggleSec}
          >
            <ActivityFeed state={state} userMode={userMode} />
          </RoomSection>
          <RoomSection
            id="files"
            title={userMode === 'power' ? 'The files' : 'The work'}
            summary={filesSummary}
            open={secOpen('files')}
            onToggle={toggleSec}
          >
            <ModuleMapPanel
              regions={fillModuleRegions(state)}
              variant={userMode}
              progress={divisionProgress}
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
// Activity feed — the lower-third ticker of visible work
// ---------------------------------------------------------------------------

const FEED_LINES = 4;

function activityIcon(kind: Activity['kind']) {
  switch (kind) {
    case 'file-touch':
      return <IconFile size={11} />;
    case 'tool-call':
      return <IconTerminal size={11} />;
    case 'message':
      return <IconChat size={11} />;
    case 'consult':
      return <IconPuzzle size={11} />;
    case 'note':
      return <IconSparkles size={11} />;
  }
}

/** Non-power users never see raw paths — file lines read as plain activity. */
function feedText(activity: Activity, userMode: SituationUserMode): string {
  if (userMode === 'power' || activity.kind !== 'file-touch' || activity.path === undefined) {
    return activity.summary;
  }
  switch (activity.phase) {
    case 'start':
      return 'started a new file';
    case 'progress':
      return 'writing…';
    default:
      return 'finished a file';
  }
}

function ActivityFeed({ state, userMode }: { state: SituationState; userMode: SituationUserMode }) {
  // Stable identity by absolute stream sequence: old lines keep their element
  // (they only dim/shift); the newest mounts and slides in.
  const tail = state.activities.slice(-FEED_LINES);
  const firstSeq = state.activityCount - tail.length;
  const lines = tail.map((activity, i) => ({ activity, seq: firstSeq + i }));
  const nameOf = (nodeId?: string) =>
    nodeId ? state.chart.nodes.find((n) => n.id === nodeId)?.name : undefined;
  return (
    <div className="pd-sitroom-feed" aria-live="polite">
      {lines.map((line) => {
        const name = nameOf(line.activity.nodeId);
        return (
          <div
            className="pd-sitroom-feed-line"
            key={line.seq}
            data-age={state.activityCount - 1 - line.seq}
          >
            <span
              className="pd-sitroom-feed-icon"
              data-kind={line.activity.kind}
              aria-hidden="true"
            >
              {activityIcon(line.activity.kind)}
            </span>
            {name !== undefined ? <span className="pd-sitroom-feed-node">{name}</span> : null}
            <span className="pd-sitroom-feed-text">{feedText(line.activity, userMode)}</span>
          </div>
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
    />
  );
}
