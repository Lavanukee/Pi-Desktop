/**
 * `@pi-desktop/coordination` — the swappable **CoordinationEngine** boundary
 * (docs/harness-architecture.md §1).
 *
 * This is the ONE interface the UI depends on. The corporation harness, a plain
 * "solo pi" agent, an opencode adapter, or a user's BYO harness all implement
 * it, and the UI subscribes to the events without ever knowing which engine
 * produced them:
 *
 * ```
 *   UI  ──depends on──▶  CoordinationEngine  ◀──implements──  { corp | solo | opencode | BYO }
 * ```
 *
 * **Renderer-safe by construction.** Everything here is plain DTOs + a typed
 * interface — no `node:*`, no value-imports of the harness/inference/gen-service
 * barrels. The renderer (apps/desktop/src) may value-import this root, or take
 * these types over IPC, without leaking a Node barrel into the browser bundle
 * (the RENDERER-BARREL rule). Engine implementations live behind subpaths (e.g.
 * `@pi-desktop/coordination/solo`) that the renderer never imports.
 *
 * **Engine-agnostic on purpose.** {@link OrgChartView} and the event DTOs are a
 * NEUTRAL projection, not our harness's internal on-disk `OrgChart`
 * (`@pi-desktop/harness/corp`). An opencode/BYO adapter must be able to produce
 * these without adopting our serialization; our corp engine maps its richer
 * internal model *into* this view. See docs/coordination-engine.md for the
 * today's-flow mapping and the Phase-2 rewire checklist.
 *
 * Phase 1 = the stable interface + DTOs + the {@link SoloEngine} skeleton (proof
 * that the interface is implementable). No role behaviors, promotion, or
 * corporation flow — that is Phase 2.
 */

// ---------------------------------------------------------------------------
// Task inputs
// ---------------------------------------------------------------------------

/**
 * The CEO's disposition on an ambiguous request (spec §4), a user setting asked
 * at onboarding:
 * - `ask` — surface a few concrete options before doing anything (default).
 * - `interpret` — synthesize an interpretation that *becomes* the task.
 */
export type CeoMode = 'ask' | 'interpret';

/**
 * Review thoroughness — the user-facing "effort" dial (spec §2). Kept as a small
 * neutral union so the boundary stays decoupled from any one engine's effort
 * model; the corp engine maps this onto its own review/consult aggressiveness.
 */
export type EffortLevel = 'low' | 'medium' | 'high';

/**
 * Ambient context for a task. All optional: a bare `startTask(prompt)` is valid
 * (the solo path). The engine treats absent fields as its own sensible defaults.
 */
export interface TaskContext {
  /**
   * The owning project (a directory feature): its org chart persists at the
   * project level and is shared across the project's chats (spec §5). Absent for
   * an ephemeral, projectless chat.
   */
  readonly projectId?: string;
  /** Working directory the task runs against (where git isolation applies). */
  readonly cwd?: string;
  /** Review thoroughness for this task. */
  readonly effort?: EffortLevel;
  /** CEO disposition for ambiguous requests. */
  readonly ceoMode?: CeoMode;
  /**
   * Attached images as data URIs (`data:<mime>;base64,<data>`) — same shape the
   * composer already pushes for user messages, so live and rehydrated inputs
   * render identically.
   */
  readonly images?: readonly string[];
}

// ---------------------------------------------------------------------------
// Task handle
// ---------------------------------------------------------------------------

/**
 * The token returned by {@link CoordinationEngine.startTask}. It is available
 * synchronously (so the UI can {@link CoordinationEngine.steer} / abort with no
 * seam the instant a task begins) and carries the task's event stream.
 */
export interface TaskHandle {
  /** Stable id for this run (used to correlate events, steer, abort, resume). */
  readonly taskId: string;
  /**
   * The task's events as an async iterable — `for await (const e of handle.events)`.
   * A single pass drives to a terminal {@link DoneEvent}. Engines that need
   * multiple independent subscribers fan out at the host/IPC layer; the boundary
   * only promises one ordered stream per handle.
   */
  readonly events: AsyncIterable<CoordinationEvent>;
}

// ---------------------------------------------------------------------------
// Org-chart view (the situation-room backbone, neutral projection — spec §5/§11)
// ---------------------------------------------------------------------------

/**
 * A participant's role in the neutral chart view. Mirrors the corp roles (spec
 * §4) plus `solo`: the pre-promotion single agent that IS the whole chart before
 * a corporation exists.
 */
export type OrgNodeRole =
  | 'solo'
  | 'ceo'
  | 'manager'
  | 'division'
  | 'division-head'
  | 'engineer'
  | 'specialist';

/** Live state of a node (the situation room pulses `working` nodes). */
export type OrgNodeState = 'idle' | 'working' | 'blocked' | 'done' | 'retired';

/** One node in the neutral org-chart view. */
export interface OrgNodeView {
  readonly id: string;
  readonly role: OrgNodeRole;
  /** Human-readable name the situation room renders ("CEO", "Frontend", …). */
  readonly name: string;
  /** Parent node id; absent for the root (CEO / solo). */
  readonly parentId?: string;
  readonly state: OrgNodeState;
  /**
   * For an actively-running (`working`) node, the CURRENT action right now —
   * "thinking", "Searching the web: dungeon references", "Writing src/menu.ts".
   * Lets the situation room show `area · current action` live per node, so the
   * tree reflects what each worker is doing this instant, not just that it is
   * busy. Absent for a node that is not producing a live action (idle / done /
   * blocked, or between actions). Additive: engines without a live action omit it.
   */
  readonly currentAction?: string;
}

/**
 * A hierarchy edge for drawing the tree (`from` = parent, `to` = child). Kept
 * explicit (rather than only via {@link OrgNodeView.parentId}) so a renderer can
 * draw connectors straight from the edge list, and so cross-cutting specialist
 * links can be added later without overloading parentId.
 */
export interface OrgEdgeView {
  readonly from: string;
  readonly to: string;
}

/**
 * Neutral view of one module-map region (spec "Integration layer"): a canonical
 * directory/file region ONE division owns. The situation room's file map draws
 * these as the project skeleton and lights files up inside them as
 * {@link Activity} `file-touch` events land. A neutral projection of the corp
 * engine's richer `ModuleEntry` (`@pi-desktop/harness` corp/org-chart) — any
 * engine that has a module layout can produce it.
 */
export interface ModuleRegionView {
  /** Canonical path, normally a directory namespace ("src/engine/"). */
  readonly path: string;
  /** The owning division, by display name ("Core Engine"). */
  readonly owner: string;
  /** What lives here — the division's charter for this path. */
  readonly purpose?: string;
}

/**
 * Neutral view of a cross-division interface seam (spec "Integration layer"):
 * a typed interface one division exposes for others to consume. The situation
 * room uses these to show WHERE divisions connect (the cross-division edges of
 * the plan). Projection of the corp engine's `InterfaceHandle`.
 */
export interface InterfaceSeamView {
  /** Handle name consumers reference ("GameState"). */
  readonly name: string;
  /** The exposing division, by display name. */
  readonly exposedBy: string;
  /** The slot (file/module) where the interface is produced. */
  readonly path: string;
  /** Consuming divisions, by display name. */
  readonly consumedBy: readonly string[];
}

/**
 * The neutral, renderable snapshot of the corporation (spec §5/§11). ANY engine
 * can produce this; our corp engine maps its on-disk `OrgChart` into it.
 * Returned synchronously by {@link CoordinationEngine.getOrgChart} for a
 * situation-room bootstrap, and pushed incrementally via {@link OrgChartEvent}.
 */
export interface OrgChartView {
  readonly taskId: string;
  readonly nodes: readonly OrgNodeView[];
  readonly edges: readonly OrgEdgeView[];
  /**
   * The shared architecture's module map, once an architect (or equivalent)
   * has laid one out (spec "Integration layer"). Optional and additive: a solo
   * or pre-planning chart has none, and engines without a module concept simply
   * omit it. The situation room's file map renders from this.
   */
  readonly modules?: readonly ModuleRegionView[];
  /** The cross-division interface seams, when the engine knows them. */
  readonly interfaces?: readonly InterfaceSeamView[];
}

// ---------------------------------------------------------------------------
// Event payload DTOs
// ---------------------------------------------------------------------------

/**
 * Coarse run status for the header/status line (spec §1 `status`). Distinct from
 * per-node {@link OrgNodeState}: this is the whole task's phase.
 * - `starting` — accepted, spinning up.
 * - `planning` — CEO writing the vision / managers writing contracts + queue.
 * - `working` — engineers executing contracts.
 * - `reviewing` — review-at-merge / CEO sign-off memory phase (spec §8).
 * - `blocked` — awaiting a permission answer, an escalation, or a steer.
 * - `done` / `aborted` / `error` — terminal (accompanied by a {@link DoneEvent}).
 */
export type EngineStatus =
  | 'starting'
  | 'planning'
  | 'working'
  | 'reviewing'
  | 'blocked'
  | 'done'
  | 'aborted'
  | 'error';

/**
 * Lifecycle of a `file-touch` activity, so a UI can light a file up WHILE it is
 * being worked on (spec §11 live file map):
 * - `start` — the worker opened the file / began writing it.
 * - `progress` — a chunk landed (carries incremental line deltas).
 * - `end` — the worker finished with the file (final deltas).
 * Absent = a single completed touch (back-compatible with older engines).
 */
export type FileTouchPhase = 'start' | 'progress' | 'end';

/** A single line of visible work (spec §1 `activity`; §11 file-map + feed). */
export interface Activity {
  /** The node doing the work, if attributable (situation room highlights it). */
  readonly nodeId?: string;
  readonly kind: 'tool-call' | 'file-touch' | 'message' | 'consult' | 'note';
  /** Human-readable one-liner ("edited src/player.ts", "asked visual-critic"). */
  readonly summary: string;
  /** File path when the activity touched one (lights up the file map). */
  readonly path?: string;
  /** `file-touch` lifecycle; absent = a single completed touch. */
  readonly phase?: FileTouchPhase;
  /** Lines added in this touch/chunk, when the engine knows (live +N readout). */
  readonly linesAdded?: number;
  /** Lines removed in this touch/chunk, when the engine knows (live −N readout). */
  readonly linesRemoved?: number;
  /** Epoch millis. */
  readonly timestamp: number;
}

/**
 * A live "exercising the work" session (spec §11): the run is browsing docs,
 * running its own build, or executing a test pass — the moments the user should
 * SEE. The situation room slides in a prominent activity panel while one is
 * `running` and settles it away on a terminal status. Neutral and additive:
 * engines without such sessions simply never emit them.
 */
export interface ExerciseSessionView {
  readonly id: string;
  /** What kind of exercise: browsing, a test pass, or running the build. */
  readonly kind: 'browse' | 'test' | 'run';
  /** Headline the panel shows ("Playing the build"). */
  readonly title: string;
  readonly status: 'running' | 'passed' | 'failed' | 'ended';
  /** Sub-line detail ("checking the game loop", "214 checks · all passing"). */
  readonly detail?: string;
  /** The node exercising the work, if attributable. */
  readonly nodeId?: string;
}

/**
 * One file in a {@link ProductPeek} — a slot in the in-progress product tree,
 * with a bounded content preview so the situation room can render it inline.
 */
export interface ProductPeekFile {
  /** Path relative to the workspace root (the contract slot, `/`-separated). */
  readonly path: string;
  /** UTF-8 byte length of the produced file. */
  readonly bytes: number;
  /** The file's UTF-8 content, truncated to a preview bound when large. */
  readonly content: string;
  /** True when {@link content} was clipped (the file is larger than the bound). */
  readonly truncated: boolean;
}

/**
 * A live snapshot of the in-progress product tree — the material behind "peek at
 * what we have so far" (spec §11 the safety valve). Returned ON DEMAND while a task
 * is still running (never a mock/stub): a neutral projection any engine with a
 * workspace can produce by reading the current product tree. The situation room's
 * peek affordance renders this so the user can SEE the build going, mid-flight, and
 * steer. Empty {@link files} is honest — the product tree has nothing yet.
 */
export interface ProductPeek {
  readonly taskId: string;
  /** Every file currently in the product tree, path-sorted. */
  readonly files: readonly ProductPeekFile[];
  /** How many files the snapshot holds (may exceed the returned {@link files} when
   * capped) — the honest count for the header. */
  readonly fileCount: number;
  /** Total UTF-8 bytes across the product tree. */
  readonly totalBytes: number;
  /** Epoch millis the snapshot was taken. */
  readonly capturedAt: number;
}

/** A produced artifact — the "peek at what we have so far" material (spec §11). */
export interface ArtifactRef {
  readonly id: string;
  readonly title: string;
  readonly kind: 'file' | 'render' | 'html' | 'svg' | 'image' | 'test-result' | 'other';
  /** On-disk path if the artifact is file-backed. */
  readonly path?: string;
  /** Inline preview as a data URI (renders/images), when the engine has one. */
  readonly uri?: string;
  /** The producing node, if attributable. */
  readonly nodeId?: string;
  readonly timestamp: number;
}

/** The lifecycle a checklist row can show (a neutral view of contract status). */
export type ChecklistItemState =
  | 'queued'
  | 'ready'
  | 'in-progress'
  | 'in-review'
  | 'done'
  | 'blocked';

/**
 * One row of the checklist — the DAG made visible (spec §11). Driven DIRECTLY
 * from contract state; no model tool-call ticks a box. `group` is the division
 * name for the dropdown grouping; `dependsOn` lets the renderer show order.
 */
export interface ChecklistItem {
  /** The contract id this row reflects. */
  readonly id: string;
  readonly label: string;
  /** Division name for dropdown grouping ("Frontend", "Storyline", …). */
  readonly group?: string;
  readonly state: ChecklistItemState;
  readonly dependsOn?: readonly string[];
}

/**
 * An honest ETA — a RANGE that narrows as contracts complete (spec §11). Never a
 * fake precise countdown: a range reads as competence, a slipping countdown
 * reads as a lie.
 */
export interface EtaRange {
  readonly lowMinutes: number;
  readonly highMinutes: number;
  /** How much to trust the range yet (widens the decomposition is still forming). */
  readonly confidence?: 'low' | 'medium' | 'high';
}

/**
 * A request for the user's go-ahead (spec §9): the floating "Pi wants to use
 * git — Approve / Deny" prompt, or a flagged known-dangerous op. Answered with
 * {@link CoordinationEngine.respondToPermission} using {@link PermissionRequest.id}.
 */
export interface PermissionRequest {
  readonly id: string;
  readonly kind: 'git' | 'dangerous-op' | 'tool' | 'other';
  /** The headline the floating prompt shows. */
  readonly summary: string;
  /** The "What's this?" expansion. */
  readonly detail?: string;
  /** The concrete operation/command being gated, when there is one. */
  readonly command?: string;
}

/** How a task ended. */
export type TaskOutcome = 'completed' | 'aborted' | 'failed';

/** The terminal result handed back when a task ends. */
export interface TaskResult {
  readonly outcome: TaskOutcome;
  /** Short human summary of what shipped (or why it stopped). */
  readonly summary?: string;
  /** The artifacts the run produced (the deliverable set). */
  readonly artifacts?: readonly ArtifactRef[];
  /** Present when `outcome` is `failed`. */
  readonly error?: string;
}

// ---------------------------------------------------------------------------
// Worker transcript (the situation-room click-through, spec §11)
// ---------------------------------------------------------------------------

/**
 * The stylized leading "briefing" bubble for a worker's stream: what this node
 * was ASKED to do. A neutral projection any engine can produce; the situation
 * room's left-pane renders it as a task briefing (eyebrow + title + goal +
 * deliverables), visibly distinct from a normal user input.
 */
export interface WorkerBriefingView {
  readonly workerName: string;
  /** Plain-language role line ("Lead", "Area lead · Frontend", "Builder"). */
  readonly roleLine: string;
  /** The task headline ("Deliver the Frontend area"). */
  readonly title: string;
  /** Owned path/area, when the node has one ("src/ui/"). */
  readonly area?: string;
  readonly goal: string;
  readonly deliverables: readonly string[];
}

/**
 * One line of a worker's transcript, revealed at `at` ms into the run. A neutral
 * projection of the same {@link Activity} the room already folds — the
 * click-through renders these as messages / tool-step chains.
 *
 * Beyond the discrete {@link Activity} kinds, a line may be `'thinking'` (a
 * reasoning block, whose {@link text} grows while the model reasons) so the pane
 * can show a real "thinking…" state. For a tool step the line carries a human
 * {@link label} + {@link detail} ("Searched the web" + the query, "Reading" +
 * the file) so the pane names the ACTUAL tool instead of a generic "Used a
 * tool"; {@link text} still holds the raw tool name for icon mapping. A
 * `'message'` or `'thinking'` line with {@link streaming} `true` is the LIVE
 * growing tail — its {@link text} is still being produced token by token.
 */
export interface WorkerTranscriptLine {
  readonly at: number;
  readonly kind: Activity['kind'] | 'thinking';
  /** The line's text. For a streaming line it GROWS across reads (the live
   * assistant text / reasoning so far); for a tool step it is the raw tool name. */
  readonly text: string;
  /** File path when the line touched one (rendered as a file step). */
  readonly path?: string;
  /** Human verb for a tool/step line ("Searched the web", "Reading", "Ran"),
   * so the pane names the action instead of echoing a raw tool name. */
  readonly label?: string;
  /** Human detail for a tool/step line (the query, file, or command summary). */
  readonly detail?: string;
  /** True while this line is the LIVE growing tail: streaming assistant text
   * still generating, or an in-progress reasoning block. Cleared when the block
   * finishes. Lets the pane render the stream as live rather than settled. */
  readonly streaming?: boolean;
  /** Lines this file step added, when known — the live `+N` readout on a file
   * row (mirrors {@link Activity.linesAdded}). Set on a `file-touch` line. */
  readonly addedLines?: number;
  /** Lines this file step removed, when known — the live `−N` readout. */
  readonly removedLines?: number;
}

/**
 * A node's REAL captured turn stream (spec §11 click-through): the briefing plus
 * the ordered activity attributed to that node. Returned by an engine on demand
 * (e.g. over IPC) when the user clicks a node in the situation room; the app
 * routes it into the left chat area. Distinct from the live {@link Activity}
 * feed, which shows the whole run — this is one node's slice.
 */
export interface WorkerTranscriptView {
  readonly nodeId: string;
  readonly role: OrgNodeRole;
  readonly briefing: WorkerBriefingView;
  readonly lines: readonly WorkerTranscriptLine[];
  /**
   * The node is LIVE right now — its transcript has a streaming tail (assistant
   * text still generating, or an active reasoning block). Lets the pane show the
   * stream as live and keep polling; absent/false once the node settles.
   */
  readonly streaming?: boolean;
  /** The node's current action right now (mirrors {@link OrgNodeView.currentAction}):
   * "thinking", "Searching the web: …", "Writing src/menu.ts". */
  readonly currentAction?: string;
  /**
   * Context fullness of this node's live model session, 0..100, when the engine
   * knows it (measured at turn boundaries). Lets the app's context ring fill from
   * the RUN's real usage instead of sitting empty during a coordination task.
   */
  readonly contextPercent?: number;
}

// ---------------------------------------------------------------------------
// The event union (spec §1: status, org-chart, activity, artifact, checklist,
// eta, permission, done)
// ---------------------------------------------------------------------------

export interface StatusEvent {
  readonly type: 'status';
  readonly status: EngineStatus;
  /** Optional human detail for the status line. */
  readonly detail?: string;
}

/** A fresh snapshot of the org chart (the situation room re-renders on each). */
export interface OrgChartEvent {
  readonly type: 'org-chart';
  readonly chart: OrgChartView;
}

export interface ActivityEvent {
  readonly type: 'activity';
  readonly activity: Activity;
}

export interface ArtifactEvent {
  readonly type: 'artifact';
  readonly artifact: ArtifactRef;
}

/** The full current checklist (whole-list replace; it is small). */
export interface ChecklistEvent {
  readonly type: 'checklist';
  readonly items: readonly ChecklistItem[];
}

export interface EtaEvent {
  readonly type: 'eta';
  readonly eta: EtaRange;
}

export interface PermissionEvent {
  readonly type: 'permission';
  readonly request: PermissionRequest;
}

/**
 * An exercise-session update (spec §11 prominent activity panel). Emitted when
 * the run starts browsing / testing / running its own work, and again when the
 * session reaches a terminal status. Additive to the spec §1 set.
 */
export interface ExerciseEvent {
  readonly type: 'exercise';
  readonly session: ExerciseSessionView;
}

/**
 * A per-node LIVE activity delta — the token-level PUSH the situation room's
 * inline chat feed folds into a pi-style streaming block, so a watched agent
 * streams PER TOKEN exactly like the normal chat (never a chunky poll, never a
 * dead "Responding" gap). Additive to the spec §1 set: an engine without
 * token-level streaming simply never emits them, and a consumer that doesn't
 * know the type ignores it ({@link reduceSituation}'s `default`). The engine
 * ALSO keeps its per-node transcript accumulation ({@link WorkerTranscriptView})
 * for peek / late-join; this event is the additive real-time channel.
 *
 *  - `text` / `thinking` carry a streamed {@link delta} plus a {@link phase} so
 *    the accumulator opens a block (`start`), grows it (`delta`), and closes it
 *    (`end`) — mirroring the normal chat's `appendTextDelta`/`appendThinkingDelta`.
 *  - `tool` names a tool step the moment it starts ({@link toolName} for the
 *    icon; {@link label}/{@link detail} for the human phrasing; {@link path} when
 *    it touched a file).
 *  - `file` lights a live file edit — {@link path} plus the {@link addedLines} /
 *    {@link removedLines} that tick the +N/−N readout up in real time.
 */
export interface WorkerActivityEvent {
  readonly type: 'worker-activity';
  /** The node this delta belongs to — its accumulated block grows. */
  readonly nodeId: string;
  readonly kind: 'text' | 'thinking' | 'tool' | 'file';
  /** Streamed increment for a `text`/`thinking` block (a token or few). On
   * `start` it seeds the block; on `end` it may carry the authoritative full text. */
  readonly delta?: string;
  /** Block lifecycle for `text`/`thinking`: `start` opens, `delta` grows, `end` closes. */
  readonly phase?: 'start' | 'delta' | 'end';
  /** Raw tool name (`tool`) — the feed maps it to an icon. */
  readonly toolName?: string;
  /** Human verb for a `tool`/`file` step ("Searched the web", "Writing"). */
  readonly label?: string;
  /** Human detail for a `tool` step (the query / command / file). */
  readonly detail?: string;
  /** Captured RESULT text for a `tool` step (a bash command's output), CAPPED to a
   * recent tail — the live terminal mirror shows the command plus this output. A
   * bash step lands its command first (no `output`) then one or more `output`
   * updates as its result arrives; the accumulator replaces the row's output. */
  readonly output?: string;
  /** File path a `file`/`tool` step touched. */
  readonly path?: string;
  /** Lines this `file` chunk added / removed (the live +N/−N readout). */
  readonly addedLines?: number;
  readonly removedLines?: number;
}

/** Terminal event — always the last event on a stream. */
export interface DoneEvent {
  readonly type: 'done';
  readonly result: TaskResult;
}

/**
 * The event stream the UI subscribes to (spec §1). A discriminated union keyed
 * on `type`; a run is a sequence ending in exactly one {@link DoneEvent}.
 */
export type CoordinationEvent =
  | StatusEvent
  | OrgChartEvent
  | ActivityEvent
  | ArtifactEvent
  | ChecklistEvent
  | EtaEvent
  | PermissionEvent
  | ExerciseEvent
  | WorkerActivityEvent
  | DoneEvent;

/** Every event `type` discriminant, in the spec §1 order (+ additive ones). */
export const COORDINATION_EVENT_TYPES = [
  'status',
  'org-chart',
  'activity',
  'artifact',
  'checklist',
  'eta',
  'permission',
  'exercise',
  'worker-activity',
  'done',
] as const;

export type CoordinationEventType = (typeof COORDINATION_EVENT_TYPES)[number];

/** True when `v` is a known event discriminant. Pure, renderer-safe. */
export function isCoordinationEventType(v: unknown): v is CoordinationEventType {
  return typeof v === 'string' && (COORDINATION_EVENT_TYPES as readonly string[]).includes(v);
}

/**
 * True when `e` is the terminal event of a stream (a {@link DoneEvent}). Lets a
 * consumer/IPC layer detect end-of-stream without matching on `'done'` inline.
 */
export function isTerminalEvent(e: CoordinationEvent): e is DoneEvent {
  return e.type === 'done';
}

// ---------------------------------------------------------------------------
// The engine interface
// ---------------------------------------------------------------------------

/**
 * The stable, swappable coordination boundary (spec §1). Implementations: our
 * corporation harness, the {@link SoloEngine} (a plain solo agent — "the
 * corporation that hasn't grown yet"), and future opencode / BYO adapters.
 *
 * The method surface is the spec §1 draft — `startTask`, `steer`, `abort`,
 * `getOrgChart`, plus the event stream — with one completion:
 * {@link respondToPermission}, the answer side of the `permission` event (a
 * request event is only meaningful with a way to answer it).
 */
export interface CoordinationEngine {
  /**
   * Begin a task. Returns a {@link TaskHandle} SYNCHRONOUSLY (the caller can
   * steer/abort immediately); work and events proceed on the handle's stream.
   */
  startTask(prompt: string, ctx?: TaskContext): TaskHandle;

  /**
   * Mid-run guidance with no seam (spec §1/§9): delivered to the CEO (or the
   * solo agent) as steering, never a faked user turn. Fire-and-forget.
   */
  steer(handle: TaskHandle, text: string): void;

  /** Stop the task. The stream ends with a `done` event, `outcome: 'aborted'`. */
  abort(handle: TaskHandle): void;

  /**
   * A synchronous snapshot of the current org chart for the situation room
   * (spec §1/§11). Live changes also arrive as {@link OrgChartEvent}s; this is
   * the bootstrap/read-back. Returns an empty-node view for an unknown handle.
   */
  getOrgChart(handle: TaskHandle): OrgChartView;

  /**
   * Answer a {@link PermissionRequest} previously surfaced via a `permission`
   * event, by its {@link PermissionRequest.id}. Completes the spec §1 draft's
   * request/response round-trip. Fire-and-forget.
   */
  respondToPermission(handle: TaskHandle, requestId: string, granted: boolean): void;
}
