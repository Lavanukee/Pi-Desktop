/**
 * The situation-room state model (docs/harness-architecture.md §11).
 *
 * A pure fold over the {@link CoordinationEvent} stream: the surface renders
 * EXACTLY what the engine said, nothing invented. Checklist checks come from
 * contract state, the ETA is the engine's honest range, files light up only on
 * real `file-touch` activities. Keeping the fold pure (no timers, no React)
 * makes the whole situation room unit-testable by replaying a scripted run.
 *
 * Renderer-safe: type-only imports of the neutral coordination DTOs (the one
 * boundary the UI is allowed to know — RENDERER-BARREL rule).
 */

import type {
  Activity,
  ArtifactRef,
  ChecklistItem,
  CoordinationEvent,
  EngineStatus,
  EtaRange,
  ExerciseSessionView,
  OrgChartView,
  OrgNodeView,
  TaskResult,
} from '@pi-desktop/coordination';

/** How many activity lines the feed keeps (the lower-third shows the tail). */
const ACTIVITY_CAP = 120;

/** How many live-action rows the fold retains (the surface renders a tail). */
const ACTION_FEED_CAP = 14;

/**
 * One row of the "Live activity" feed: an AREA doing ONE thing, in real time —
 * `Core Engine · Writing src/engine/renderer.ts`, `Pi · thinking…`. Rows open
 * while the action is happening (the surface shows a spinner) and close when it
 * finishes or the node's action changes (the spinner settles to a done check and
 * the stack slides up). Driven by the org chart's per-node `currentAction`, with
 * the activity stream filling in for engines that don't carry live actions.
 */
export interface ActionFeedRow {
  /** Monotonic stream sequence — stable row identity for enter/shift motion. */
  readonly seq: number;
  readonly nodeId: string;
  /** The user-facing area/worker label ("Core Engine", "Pi"). */
  readonly area: string;
  /** What it is doing / did ("thinking", "Writing src/menu.ts", "Ran: pnpm test"). */
  readonly action: string;
  /** False while the action is live (spinner); true once settled (done check). */
  readonly done: boolean;
}

/**
 * One file the run has touched, deduplicated by path. `touches` counts repeat
 * writes; `lastTouch` drives the "this file just landed" flash (fresh = shiny).
 * `active` is true between a `start` phase and its `end` — the file is being
 * worked on RIGHT NOW (it lights up in the map). `added`/`removed` accumulate
 * the engine-reported line deltas; `lastDelta*` carry the latest chunk for the
 * live +N/−N flash.
 */
export interface FileTouchView {
  readonly path: string;
  /** Node that last touched it, when attributable. */
  readonly nodeId?: string;
  readonly touches: number;
  /** Epoch millis of the latest touch. */
  readonly lastTouch: number;
  /** The file is being edited right now (between phase start and end). */
  readonly active: boolean;
  /** Cumulative lines added across all touches (0 when never reported). */
  readonly added: number;
  /** Cumulative lines removed across all touches (0 when never reported). */
  readonly removed: number;
  /** The latest chunk's deltas, for the live flash (absent until reported). */
  readonly lastDeltaAdded?: number;
  readonly lastDeltaRemoved?: number;
}

/** Everything the situation room renders, folded from the event stream. */
export interface SituationState {
  readonly status: EngineStatus;
  readonly statusDetail?: string;
  readonly chart: OrgChartView;
  /** Rolling activity feed, oldest → newest, capped at {@link ACTIVITY_CAP}. */
  readonly activities: readonly Activity[];
  /**
   * Total activities EVER seen (not capped). `activityCount - activities.length
   * + i` is a stable stream sequence for row identity in the feed.
   */
  readonly activityCount: number;
  /** Artifacts in arrival order; the LAST one is "what we have so far". */
  readonly artifacts: readonly ArtifactRef[];
  readonly checklist: readonly ChecklistItem[];
  readonly eta?: EtaRange;
  /** Files touched so far, in first-touch order (the map fills in). */
  readonly files: readonly FileTouchView[];
  /**
   * The live-action rows ("Area · current action"), oldest → newest, capped at
   * {@link ACTION_FEED_CAP}. Open rows (done=false) are actions happening RIGHT
   * NOW; the newest rows sit at the bottom and finished rows slide up.
   */
  readonly actionFeed: readonly ActionFeedRow[];
  /** Monotonic sequence for {@link ActionFeedRow.seq} (row identity). */
  readonly actionSeq: number;
  /**
   * The most recent exercise session (browse / test / run). The surface slides
   * the activity panel in while its status is `running` and settles it away on
   * a terminal status (kept, not cleared, so the exit can animate).
   */
  readonly exercise?: ExerciseSessionView;
  /** Set by the terminal event; the room settles into its "shipped" pose. */
  readonly result?: TaskResult;
}

/** The empty room: no corporation yet, nothing to draw but the solo agent. */
export function initialSituation(taskId = ''): SituationState {
  return {
    status: 'starting',
    chart: { taskId, nodes: [], edges: [] },
    activities: [],
    activityCount: 0,
    artifacts: [],
    checklist: [],
    files: [],
    actionFeed: [],
    actionSeq: 0,
  };
}

function foldFileTouch(
  files: readonly FileTouchView[],
  activity: Activity,
): readonly FileTouchView[] {
  const path = activity.path;
  if (!path) return files;
  // Absent phase = a single completed touch (older engines): never active.
  const active = activity.phase === 'start' || activity.phase === 'progress';
  const added = activity.linesAdded ?? 0;
  const removed = activity.linesRemoved ?? 0;
  const hasDelta = activity.linesAdded !== undefined || activity.linesRemoved !== undefined;
  const existing = files.findIndex((f) => f.path === path);
  if (existing === -1) {
    return [
      ...files,
      {
        path,
        nodeId: activity.nodeId,
        touches: 1,
        lastTouch: activity.timestamp,
        active,
        added,
        removed,
        ...(hasDelta ? { lastDeltaAdded: added, lastDeltaRemoved: removed } : {}),
      },
    ];
  }
  const next = files.slice();
  const prev = next[existing];
  if (!prev) return files;
  next[existing] = {
    path,
    nodeId: activity.nodeId ?? prev.nodeId,
    touches: prev.touches + 1,
    lastTouch: activity.timestamp,
    active,
    added: prev.added + added,
    removed: prev.removed + removed,
    ...(hasDelta
      ? { lastDeltaAdded: added, lastDeltaRemoved: removed }
      : {
          ...(prev.lastDeltaAdded !== undefined ? { lastDeltaAdded: prev.lastDeltaAdded } : {}),
          ...(prev.lastDeltaRemoved !== undefined
            ? { lastDeltaRemoved: prev.lastDeltaRemoved }
            : {}),
        }),
  };
  return next;
}

/** The user-facing AREA label for a feed row: a builder reports under its parent
 * area's name; everyone else under its own ("Pi", "Core Engine"). */
function areaLabelOf(chart: OrgChartView, node: OrgNodeView): string {
  if ((node.role === 'engineer' || node.role === 'division-head') && node.parentId !== undefined) {
    return chart.nodes.find((n) => n.id === node.parentId)?.name ?? node.name;
  }
  return node.name;
}

/** Index of a node's OPEN action row (its latest, still-live row), or -1. */
function openRowIndex(feed: readonly ActionFeedRow[], nodeId: string): number {
  for (let i = feed.length - 1; i >= 0; i -= 1) {
    const row = feed[i];
    if (row !== undefined && row.nodeId === nodeId && !row.done) return i;
  }
  return -1;
}

/** Settle a row (spinner → done check); returns the same array when already done. */
function closeRow(feed: readonly ActionFeedRow[], index: number): readonly ActionFeedRow[] {
  const row = feed[index];
  if (row === undefined || row.done) return feed;
  const next = feed.slice();
  next[index] = { ...row, done: true };
  return next;
}

/** The action-feed slice of the fold (kept out of reduceSituation for clarity). */
interface ActionFold {
  readonly actionFeed: readonly ActionFeedRow[];
  readonly actionSeq: number;
}

/**
 * Fold one org-chart snapshot into the live-action rows: every working node with
 * a `currentAction` keeps exactly one OPEN row (a changed action closes the old
 * row and opens a fresh one at the bottom); a node that stopped working closes
 * its open row. Pure; returns the incoming slices when nothing changed.
 */
function foldChartActions(state: SituationState, chart: OrgChartView): ActionFold {
  let feed: readonly ActionFeedRow[] = state.actionFeed;
  let seq = state.actionSeq;
  const workingIds = new Set(chart.nodes.filter((n) => n.state === 'working').map((n) => n.id));
  // Settle rows whose node is no longer running.
  for (let i = 0; i < feed.length; i += 1) {
    const row = feed[i];
    if (row !== undefined && !row.done && !workingIds.has(row.nodeId)) feed = closeRow(feed, i);
  }
  // Open/refresh a row per working node with a live action.
  for (const node of chart.nodes) {
    if (node.state !== 'working' || node.currentAction === undefined) continue;
    const open = openRowIndex(feed, node.id);
    if (open !== -1 && feed[open]?.action === node.currentAction) continue;
    if (open !== -1) feed = closeRow(feed, open);
    feed = [
      ...feed,
      {
        seq: seq,
        nodeId: node.id,
        area: areaLabelOf(chart, node),
        action: node.currentAction,
        done: false,
      },
    ];
    seq += 1;
  }
  if (feed === state.actionFeed) return { actionFeed: state.actionFeed, actionSeq: seq };
  return { actionFeed: feed.slice(-ACTION_FEED_CAP), actionSeq: seq };
}

/**
 * Fold one activity into the live-action rows — the fill-in source for engines
 * (and run phases) whose charts don't carry `currentAction`. Only a node the
 * CURRENT chart shows as `working` updates its row (honest: never a row for a
 * settled node). A terminal file-touch (`phase: 'end'`) only SETTLES the node's
 * open row — finishing a file is the end of an action, not a new one.
 */
function foldActivityAction(state: SituationState, activity: Activity): ActionFold {
  const unchanged: ActionFold = { actionFeed: state.actionFeed, actionSeq: state.actionSeq };
  const nodeId = activity.nodeId;
  if (nodeId === undefined) return unchanged;
  const node = state.chart.nodes.find((n) => n.id === nodeId);
  if (node === undefined || node.state !== 'working') return unchanged;
  let feed: readonly ActionFeedRow[] = state.actionFeed;
  let seq = state.actionSeq;
  const open = openRowIndex(feed, nodeId);
  if (activity.kind === 'file-touch' && activity.phase === 'end') {
    if (open === -1) return unchanged;
    return { actionFeed: closeRow(feed, open), actionSeq: seq };
  }
  if (activity.summary.trim() === '') return unchanged;
  if (open !== -1 && feed[open]?.action === activity.summary) return unchanged;
  if (open !== -1) feed = closeRow(feed, open);
  feed = [
    ...feed,
    {
      seq: seq,
      nodeId,
      area: areaLabelOf(state.chart, node),
      action: activity.summary,
      done: false,
    },
  ];
  seq += 1;
  return { actionFeed: feed.slice(-ACTION_FEED_CAP), actionSeq: seq };
}

/** Every open action row settles when the run reaches a terminal state. */
function settleActionFeed(feed: readonly ActionFeedRow[]): readonly ActionFeedRow[] {
  if (feed.every((row) => row.done)) return feed;
  return feed.map((row) => (row.done ? row : { ...row, done: true }));
}

/**
 * Fold one event into the state. Pure — returns a new state, never mutates.
 * Unknown-at-runtime event types fall through unchanged (forward-compatible
 * with engines that emit more than the spec §1 set).
 */
export function reduceSituation(state: SituationState, event: CoordinationEvent): SituationState {
  switch (event.type) {
    case 'status':
      return { ...state, status: event.status, statusDetail: event.detail };
    case 'org-chart':
      return { ...state, chart: event.chart, ...foldChartActions(state, event.chart) };
    case 'activity': {
      const activities = [...state.activities, event.activity].slice(-ACTIVITY_CAP);
      const files =
        event.activity.kind === 'file-touch'
          ? foldFileTouch(state.files, event.activity)
          : state.files;
      return {
        ...state,
        activities,
        activityCount: state.activityCount + 1,
        files,
        ...foldActivityAction(state, event.activity),
      };
    }
    case 'artifact':
      return { ...state, artifacts: [...state.artifacts, event.artifact] };
    case 'checklist':
      return { ...state, checklist: event.items };
    case 'eta':
      return { ...state, eta: event.eta };
    case 'permission':
      // The floating permission prompt is app chrome, not situation-room canvas
      // content; the room ignores it (the app answers via respondToPermission).
      return state;
    case 'exercise':
      return { ...state, exercise: event.session };
    case 'done':
      return {
        ...state,
        status: statusForOutcome(event.result),
        result: event.result,
        actionFeed: settleActionFeed(state.actionFeed),
      };
    default:
      return state;
  }
}

function statusForOutcome(result: TaskResult): EngineStatus {
  if (result.outcome === 'completed') return 'done';
  if (result.outcome === 'aborted') return 'aborted';
  return 'error';
}

// ---------------------------------------------------------------------------
// Derived readings (pure selectors the surface renders from)
// ---------------------------------------------------------------------------

/** Contract progress: done vs total, straight from checklist state. */
export interface ContractProgress {
  readonly done: number;
  readonly total: number;
}

export function contractProgress(state: SituationState): ContractProgress {
  const total = state.checklist.length;
  let done = 0;
  for (const item of state.checklist) if (item.state === 'done') done += 1;
  return { done, total };
}

/** Checklist rows grouped by division, preserving first-seen group order. */
export interface ChecklistGroup {
  readonly name: string;
  readonly items: readonly ChecklistItem[];
  readonly done: number;
}

export function groupChecklist(items: readonly ChecklistItem[]): readonly ChecklistGroup[] {
  const order: string[] = [];
  const byName = new Map<string, ChecklistItem[]>();
  for (const item of items) {
    const name = item.group ?? 'Plan';
    let bucket = byName.get(name);
    if (!bucket) {
      bucket = [];
      byName.set(name, bucket);
      order.push(name);
    }
    bucket.push(item);
  }
  return order.map((name) => {
    const groupItems = byName.get(name) ?? [];
    return {
      name,
      items: groupItems,
      done: groupItems.filter((i) => i.state === 'done').length,
    };
  });
}

/**
 * Cross-division wait: the groups (other than the row's own) whose contracts
 * this row still waits on — the visible cross-division dependency edge.
 */
export function crossGroupWaits(
  item: ChecklistItem,
  all: readonly ChecklistItem[],
): readonly string[] {
  if (!item.dependsOn || item.dependsOn.length === 0) return [];
  const byId = new Map(all.map((i) => [i.id, i]));
  const waits: string[] = [];
  for (const depId of item.dependsOn) {
    const dep = byId.get(depId);
    if (!dep || dep.state === 'done') continue;
    const depGroup = dep.group ?? 'Plan';
    const ownGroup = item.group ?? 'Plan';
    if (depGroup !== ownGroup && !waits.includes(depGroup)) waits.push(depGroup);
  }
  return waits;
}

/** Files grouped under their owning module region (longest-prefix match). */
export interface ModuleRegionFill {
  readonly path: string;
  readonly owner: string;
  readonly purpose?: string;
  readonly files: readonly FileTouchView[];
}

export function fillModuleRegions(state: SituationState): readonly ModuleRegionFill[] {
  const modules = state.chart.modules ?? [];
  const regions = modules.map((m) => ({
    path: m.path,
    owner: m.owner,
    purpose: m.purpose,
    files: [] as FileTouchView[],
  }));
  // Longest-prefix match so nested regions (if an engine emits them) win.
  const sorted = [...regions].sort((a, b) => b.path.length - a.path.length);
  for (const file of state.files) {
    const region = sorted.find((r) => file.path.startsWith(r.path));
    if (region) region.files.push(file);
  }
  return regions;
}

// ---------------------------------------------------------------------------
// Follow-live: which node the left pane should watch (never blank)
// ---------------------------------------------------------------------------

/** Chart tier of a role — smaller is higher in the tree (the "top-most" order). */
function tierOf(role: OrgNodeView['role']): number {
  switch (role) {
    case 'solo':
    case 'ceo':
      return 0;
    case 'manager':
      return 1;
    case 'specialist':
      return 2;
    case 'division':
    case 'division-head':
      return 3;
    case 'engineer':
      return 4;
  }
}

/**
 * The node the left pane should FOLLOW right now (the never-blank auto-select):
 * the TOP-MOST node actually running — the lead forming the vision first, then
 * the planning tier, then the active builders. Sticky by design:
 *
 *  - while the currently-followed node is still `working`, a SIBLING starting
 *    up does not steal the pane (no lateral hopping between parallel builders);
 *    only a node HIGHER in the tree going live pulls the view up;
 *  - when nothing is running (gaps between turns, the run settling), the
 *    previously-followed node is kept — the pane never goes blank mid-run.
 *
 * Pure: same chart + same current id → same answer.
 */
export function followTarget(chart: OrgChartView, currentId?: string): OrgNodeView | undefined {
  const current = currentId !== undefined ? chart.nodes.find((n) => n.id === currentId) : undefined;
  const working = chart.nodes.filter((n) => n.state === 'working');
  if (working.length === 0) return current;
  // Follow the DEEPEST working node — the one actually producing output (an
  // engineer streaming code, or a manager mid-turn), not a lead that stays
  // "working" while it idly coordinates. This keeps the chat streaming live output
  // the whole run instead of sitting on the CEO's finished turn. (Before promotion
  // the only worker IS the CEO/root, so it still leads with the original model.)
  let best = working[0] as OrgNodeView;
  for (const node of working) {
    if (tierOf(node.role) > tierOf(best.role)) best = node;
  }
  // Sticky: stay on the current node unless something strictly DEEPER went live, so
  // the view doesn't thrash between peers but does descend into the active producer.
  if (current?.state === 'working' && tierOf(current.role) >= tierOf(best.role)) return current;
  return best;
}

/** How many nodes are actually running — the collapsed-section live summary. */
export function workingCount(chart: OrgChartView): number {
  return chart.nodes.filter((n) => n.state === 'working').length;
}

/** The honest ETA line: a range, never a countdown. Empty until one arrives. */
export function formatEta(eta: EtaRange | undefined): string {
  if (!eta) return '';
  const low = Math.max(0, Math.round(eta.lowMinutes));
  const high = Math.max(low, Math.round(eta.highMinutes));
  if (high <= 1) return 'under a minute left';
  if (low === high) return `~${high} min left`;
  return `~${low}–${high} min left`;
}
