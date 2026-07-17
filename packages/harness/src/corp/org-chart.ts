/**
 * The org-chart data model — the backbone of the coordination harness
 * (docs/harness-architecture.md §5).
 *
 * A single PER-PROJECT artifact (JSON on disk, see persistence.ts): the spine
 * everything reads/writes. The situation room renders it; a crashed run resumes
 * from it; the queue/DAG scheduler walks it. Phase 1 ships the types + guards
 * only — no behavior reads or mutates these yet (that's Phase 2).
 *
 * Design invariants carried by the shape itself:
 * - **The contract is law.** Whatever a worker thinks its purpose is, the typed
 *   {@link Contract} governs the work. Prompts are flavor; the contract decides.
 * - **Queue = dependency DAG.** {@link QueueEdge}s order contracts; managers
 *   queue, they don't start. Parallelism is always optional — edges express
 *   ordering, never a concurrency requirement.
 * - Contract state lives ON the contract ({@link Contract.status}); node state
 *   lives in {@link OrgChart.nodeStatus}. Nothing is duplicated.
 */

/**
 * The kinds of participant in the corporation (spec §4).
 *
 * - `ceo` — the promoted solo agent. Holds the vision; approves the final
 *   product; never writes code or contracts. Exactly one per chart.
 * - `manager` — the permanent block below the CEO. Writes contracts, owns the
 *   queue, proposes org mutations for CEO sign-off.
 * - `division` — a unit of work identity (Frontend, Storyline, …) created by
 *   the managers; carries a base system prompt from the predefined library.
 * - `division-head` — adaptive extra split inside a division when its work is
 *   still too large for engineers (manager → division-head → engineer).
 * - `engineer` — an L2 worker holding ONE contract + its files + type-only
 *   imports. Nothing else.
 * - `specialist` — registry entry callable from any level (advisory reviewers
 *   and heavy modality specialists); not routed through the hierarchy.
 */
export type NodeRole = 'ceo' | 'manager' | 'division' | 'division-head' | 'engineer' | 'specialist';

export const NODE_ROLES: readonly NodeRole[] = [
  'ceo',
  'manager',
  'division',
  'division-head',
  'engineer',
  'specialist',
];

export function isNodeRole(v: unknown): v is NodeRole {
  return typeof v === 'string' && (NODE_ROLES as readonly string[]).includes(v);
}

/**
 * Live state of one node, kept in {@link OrgChart.nodeStatus} (NOT on the node,
 * so the structural chart and the volatile state serialize/diff independently).
 * - `idle` — exists, nothing assigned/running.
 * - `working` — its worker is mid-turn (situation room pulses this).
 * - `blocked` — waiting on a dependency, a consult, or an escalation answer.
 * - `done` — all of its contracts merged; kept for the record until pruned.
 * - `retired` — removed by an org-chart mutation (kept for resume/history).
 */
export type NodeStatus = 'idle' | 'working' | 'blocked' | 'done' | 'retired';

export const NODE_STATUSES: readonly NodeStatus[] = [
  'idle',
  'working',
  'blocked',
  'done',
  'retired',
];

export function isNodeStatus(v: unknown): v is NodeStatus {
  return typeof v === 'string' && (NODE_STATUSES as readonly string[]).includes(v);
}

/** One participant in the corporation. */
export interface OrgNode {
  /** Stable unique id (used by contracts, edges, branches, status). */
  readonly id: string;
  readonly role: NodeRole;
  /** Human-readable name the situation room renders ("Frontend", "CEO", …). */
  readonly name: string;
  /**
   * Parent node id (undefined for the CEO root). Managers hang off the CEO,
   * divisions off the manager block, engineers off their division (or
   * division-head). Specialists are parentless registry entries — callable from
   * any level, not routed through the hierarchy.
   */
  readonly parentId?: string;
  /**
   * Which predefined library prompt seeds this node's system prompt: a role id
   * or division archetype id from the prompt library (prompts.ts). Custom
   * divisions still reference the base they extend.
   */
  readonly promptId?: string;
  /**
   * A manager's LIGHT extension to the base prompt for a custom division
   * (appended, never replacing the base). Deliberately simple — it can never
   * cause failure, because the contract governs the work.
   */
  readonly promptExtension?: string;
}

/**
 * Lifecycle of one contract (spec §5). Transitions are Phase-2 behavior; the
 * states are fixed here:
 * `queued` → (prereqs clear) → `ready` → `in-progress` → `in-review` →
 * `merged`, with `unfulfillable` reachable from `in-progress` (returned upward
 * "unfulfillable, because X"; escalates exactly one level).
 */
export type ContractStatus =
  | 'queued'
  | 'ready'
  | 'in-progress'
  | 'in-review'
  | 'merged'
  | 'unfulfillable';

export const CONTRACT_STATUSES: readonly ContractStatus[] = [
  'queued',
  'ready',
  'in-progress',
  'in-review',
  'merged',
  'unfulfillable',
];

export function isContractStatus(v: unknown): v is ContractStatus {
  return typeof v === 'string' && (CONTRACT_STATUSES as readonly string[]).includes(v);
}

/**
 * The declared capability surface of a contract: exactly which tools the worker
 * may use and which imports (as types) its output may depend on. Everything
 * else is out of bounds — isolation is the point.
 */
export interface ContractAvailable {
  /** Tool names the worker gets (a preset subset, not "everything"). */
  readonly tools: readonly string[];
  /**
   * Import specifiers the output may depend on (type-only from the worker's
   * point of view — it sees signatures, not implementations).
   */
  readonly imports: readonly string[];
}

/**
 * A typed task spec — the unit of dispatch, and the LAW governing a worker
 * (spec §5). An engineer receives only its contract; contract granularity is
 * small and deliberate (100 few-minute sub-tasks beat 5 hour-long ones).
 */
export interface Contract {
  /** Stable unique id (referenced by queue edges + dependsOn). */
  readonly id: string;
  /** Short human title ("Player movement controller"). */
  readonly title: string;
  /** The node responsible for fulfilling this contract. */
  readonly ownerNodeId: string;
  /**
   * What the worker receives, as a typed description (input types + any seed
   * material). Serialized prose/typed-signature text in Phase 1; the concrete
   * schema of contract bodies is a Phase-2 build detail.
   */
  readonly input: string;
  /** What the worker must produce, as a typed description (output types). */
  readonly output: string;
  /**
   * Where the output plugs in: the injection point in the wider program
   * (file/module/export the merged result must land in).
   */
  readonly slot: string;
  /** The declared tool + import surface. */
  readonly available: ContractAvailable;
  /**
   * What the work will be reviewed against — seeded BEFORE implementation so
   * the bar is fixed up front and reviews are evidence-grounded.
   */
  readonly reviewRubric: string;
  /** Contract ids that must be `merged` before this one becomes `ready`. */
  readonly dependsOn: readonly string[];
  /**
   * Free-form "anything not captured by the other fields" note the author (a
   * manager) may attach to a contract: a past approach that failed and should be
   * avoided, a special instruction, a constraint, a gotcha, a warning. Optional
   * and unstructured on purpose — the typed fields above still govern the work;
   * this is the escape hatch for the human-legible remainder.
   */
  readonly notes?: string;
  /**
   * Workspace placement, decided at division init (spec §9): `shared` works on
   * a branch of the common tree; `isolated` gets its own working directory to
   * avoid collisions. Undefined = engine default (shared).
   */
  readonly workspace?: 'shared' | 'isolated';
  readonly status: ContractStatus;
}

/**
 * One edge of the dependency DAG over contracts (spec §6): `from` must be
 * `merged` before `to` may start. A∥B→C is expressed as {A→C, B→C} with no
 * edge between A and B. Edges are derivable from {@link Contract.dependsOn};
 * the queue stores them explicitly so managers can read/edit the roadmap as a
 * first-class artifact and the checklist can render straight from it.
 */
export interface QueueEdge {
  /** Prerequisite contract id. */
  readonly from: string;
  /** Dependent contract id. */
  readonly to: string;
}

/**
 * Per-node git placement (spec §5, §9): every agent works on its own branch —
 * of the real repo (user approved git) or the hidden shadow repo (user denied).
 * Managers own the merges.
 */
export interface BranchRef {
  readonly nodeId: string;
  /** Branch name inside the (real or shadow) repo. */
  readonly branch: string;
  /** Working directory for `isolated`-workspace contracts, if one was made. */
  readonly worktreePath?: string;
}

/**
 * One canonical region of the module map (the integration layer, spec
 * "Integration layer"): a file or directory ONE division owns. The architect
 * lays these out up front — one clear area per division, no overlaps — so
 * divisions build against a shared structure instead of each inventing its own
 * (the real-qwen defect this fixes: three divisions each building a start-menu
 * at three different paths, which the exact-string slot detector reads as
 * "clean" because no two paths literally collide).
 */
export interface ModuleEntry {
  /**
   * Canonical path the division builds within — normally a DIRECTORY namespace
   * (e.g. `src/engine/`) the division fills with many distinct files, NOT a
   * single file. Kept a plain string; the trailing-slash directory convention is
   * carried by the architect prompt, not the type. (A single-file region traps a
   * division into piling every contract onto one slot — the real-qwen defect the
   * directory framing fixes.)
   */
  readonly path: string;
  /** The division (by name) that owns this region. */
  readonly owner: string;
  /** What lives here — the division's charter for this path. */
  readonly purpose: string;
}

/**
 * A cross-division SEAM (the integration layer): a typed interface one division
 * exposes for others to consume. This is the artifact that makes a real
 * cross-division dependency expressible — a consumer declares
 * `dependsOn: ['iface:<name>']` and the integrate pass (integrate.ts) rewrites
 * that handle to the concrete contract id in the {@link exposedBy} division that
 * produces {@link path}. Without it, divisions plan as siloed backlogs with ZERO
 * edges between them.
 */
export interface InterfaceHandle {
  /** The handle name consumers reference (e.g. "GameState"). */
  readonly name: string;
  /** The division (by name) that produces/owns this interface. */
  readonly exposedBy: string;
  /** The slot (file/module/export) where the interface is produced. */
  readonly path: string;
  /** A short typed summary of what the interface provides. */
  readonly summary: string;
  /** The divisions (by name) expected to consume it. */
  readonly consumedBy: readonly string[];
}

/**
 * The shared ARCHITECTURE (the integration layer): the canonical file/dir layout
 * (one region per division) plus the cross-division interface seams. Produced up
 * front by the architect step (corp/architect.ts) on the `intelligent` tier,
 * BEFORE managers write contracts, so every division builds against one map.
 * Optional on {@link OrgChart} — a solo/unplanned chart has none.
 */
export interface Architecture {
  /** The canonical module map — one clear region per division, no overlaps. */
  readonly moduleMap: readonly ModuleEntry[];
  /** The typed interfaces divisions expose for each other to consume. */
  readonly interfaces: readonly InterfaceHandle[];
}

/**
 * Overall run state of the chart. `solo` = no promotion happened (the chart may
 * exist with just a CEO-to-be); `running` = the corporation is executing;
 * `paused` = resumable snapshot (crash/quit); `done` = CEO signed off.
 */
export type OrgChartRunStatus = 'solo' | 'running' | 'paused' | 'done';

export const ORG_CHART_RUN_STATUSES: readonly OrgChartRunStatus[] = [
  'solo',
  'running',
  'paused',
  'done',
];

export function isOrgChartRunStatus(v: unknown): v is OrgChartRunStatus {
  return typeof v === 'string' && (ORG_CHART_RUN_STATUSES as readonly string[]).includes(v);
}

/**
 * The per-project org chart (spec §5). Persisted as JSON at the project level
 * and shared across the project's chats (projects group conversations that
 * share a working directory). This is what the situation room renders and what
 * a crashed run resumes from.
 */
export interface OrgChart {
  /** The owning project (a directory-feature id, stable per working dir). */
  readonly projectId: string;
  /** CEO, manager(s), divisions, division-heads, engineers, specialists. */
  readonly nodes: readonly OrgNode[];
  /** Typed task specs. Contract state lives on each contract. */
  readonly contracts: readonly Contract[];
  /** Dependency DAG over contracts (A∥B → C). */
  readonly queue: readonly QueueEdge[];
  /** Per-node git branch/worktree refs. */
  readonly branches: readonly BranchRef[];
  /** Overall run state. */
  readonly status: OrgChartRunStatus;
  /** Per-node live state, keyed by node id (absent node ⇒ `idle`). */
  readonly nodeStatus: Readonly<Record<string, NodeStatus>>;
  /**
   * The shared architecture every division builds against (the integration
   * layer). Absent on a solo/unplanned chart; set by the architect step before
   * managers write contracts, so cross-division interface handles resolve.
   */
  readonly architecture?: Architecture;
}

/** An empty chart for a project — the state before any promotion. */
export function emptyOrgChart(projectId: string): OrgChart {
  return {
    projectId,
    nodes: [],
    contracts: [],
    queue: [],
    branches: [],
    status: 'solo',
    nodeStatus: {},
  };
}

function isStringArray(v: unknown): v is readonly string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function isOrgNode(v: unknown): v is OrgNode {
  if (v === null || typeof v !== 'object') return false;
  const n = v as Record<string, unknown>;
  return (
    typeof n.id === 'string' &&
    isNodeRole(n.role) &&
    typeof n.name === 'string' &&
    (n.parentId === undefined || typeof n.parentId === 'string') &&
    (n.promptId === undefined || typeof n.promptId === 'string') &&
    (n.promptExtension === undefined || typeof n.promptExtension === 'string')
  );
}

export function isContract(v: unknown): v is Contract {
  if (v === null || typeof v !== 'object') return false;
  const c = v as Record<string, unknown>;
  const available = c.available as Record<string, unknown> | null | undefined;
  return (
    typeof c.id === 'string' &&
    typeof c.title === 'string' &&
    typeof c.ownerNodeId === 'string' &&
    typeof c.input === 'string' &&
    typeof c.output === 'string' &&
    typeof c.slot === 'string' &&
    available !== null &&
    typeof available === 'object' &&
    isStringArray(available.tools) &&
    isStringArray(available.imports) &&
    typeof c.reviewRubric === 'string' &&
    isStringArray(c.dependsOn) &&
    (c.notes === undefined || typeof c.notes === 'string') &&
    (c.workspace === undefined || c.workspace === 'shared' || c.workspace === 'isolated') &&
    isContractStatus(c.status)
  );
}

function isQueueEdge(v: unknown): v is QueueEdge {
  if (v === null || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  return typeof e.from === 'string' && typeof e.to === 'string';
}

function isBranchRef(v: unknown): v is BranchRef {
  if (v === null || typeof v !== 'object') return false;
  const b = v as Record<string, unknown>;
  return (
    typeof b.nodeId === 'string' &&
    typeof b.branch === 'string' &&
    (b.worktreePath === undefined || typeof b.worktreePath === 'string')
  );
}

function isNodeStatusMap(v: unknown): v is Readonly<Record<string, NodeStatus>> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  return Object.values(v).every(isNodeStatus);
}

/** Structural guard for a {@link ModuleEntry}. Pure. */
export function isModuleEntry(v: unknown): v is ModuleEntry {
  if (v === null || typeof v !== 'object') return false;
  const m = v as Record<string, unknown>;
  return typeof m.path === 'string' && typeof m.owner === 'string' && typeof m.purpose === 'string';
}

/** Structural guard for an {@link InterfaceHandle}. Pure. */
export function isInterfaceHandle(v: unknown): v is InterfaceHandle {
  if (v === null || typeof v !== 'object') return false;
  const h = v as Record<string, unknown>;
  return (
    typeof h.name === 'string' &&
    typeof h.exposedBy === 'string' &&
    typeof h.path === 'string' &&
    typeof h.summary === 'string' &&
    isStringArray(h.consumedBy)
  );
}

/** Structural guard for an {@link Architecture}. Pure. */
export function isArchitecture(v: unknown): v is Architecture {
  if (v === null || typeof v !== 'object') return false;
  const a = v as Record<string, unknown>;
  return (
    Array.isArray(a.moduleMap) &&
    a.moduleMap.every(isModuleEntry) &&
    Array.isArray(a.interfaces) &&
    a.interfaces.every(isInterfaceHandle)
  );
}

/**
 * Structural validation of a decoded JSON value as an {@link OrgChart}.
 * Shape-only (referential integrity — owner ids existing, DAG acyclicity — is
 * checked by callers via dag.ts where it matters). Pure.
 */
export function isOrgChart(v: unknown): v is OrgChart {
  if (v === null || typeof v !== 'object') return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.projectId === 'string' &&
    Array.isArray(c.nodes) &&
    c.nodes.every(isOrgNode) &&
    Array.isArray(c.contracts) &&
    c.contracts.every(isContract) &&
    Array.isArray(c.queue) &&
    c.queue.every(isQueueEdge) &&
    Array.isArray(c.branches) &&
    c.branches.every(isBranchRef) &&
    isOrgChartRunStatus(c.status) &&
    isNodeStatusMap(c.nodeStatus) &&
    (c.architecture === undefined || isArchitecture(c.architecture))
  );
}
