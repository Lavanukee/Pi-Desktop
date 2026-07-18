/**
 * `@pi-desktop/coordination/corp` — the REAL {@link CorpEngine}: the corporation
 * harness behind the {@link CoordinationEngine} boundary (docs/harness-architecture
 * spec §1/§11).
 *
 * It runs the harness orchestrator {@link runCorp} (promotion → architect →
 * managers → dispatch → completion → CEO review → revise → escalation) behind the
 * injected {@link CorpChatFn} model seam, and MAPS the run's progress — observed by
 * wrapping that seam and parsing each role turn with the harness's own parsers —
 * into the neutral {@link CoordinationEvent} stream the situation room folds:
 * status/phase, an incrementally-grown org chart (promotion → CEO + divisions;
 * architect → the module map + interface seams; managers → engineer nodes),
 * activity as workers produce files, a checklist driven from contract state, an
 * honest narrowing ETA, and a terminal `done` carrying the CEO verdict. It also
 * accumulates a per-node transcript so a clicked worker routes its REAL turn
 * stream into the app (the spec §11 click-through), via {@link getWorkerTranscript}.
 *
 * The model call is INJECTED (a real llama-server `/v1/chat/completions` seam in
 * the desktop main process; a deterministic mock in tests/smoke), so this engine
 * never touches the network and needs no live server to be exercised. The budget /
 * robustness guards live inside {@link runCorp} — a misbehaving model always
 * terminates — so this engine only observes; it never has to bound the run itself.
 *
 * NODE-SIDE ONLY (engines run in the Electron main process); the renderer never
 * imports this subpath — it consumes the neutral DTOs from the package root over
 * IPC (the RENDERER-BARREL rule). `@pi-desktop/harness/corp` pulls in `node:fs`,
 * so keeping this behind a subpath (not re-exported from the root) is what keeps
 * the browser bundle clean.
 */

import {
  type Architecture,
  type Contract,
  type CorpChatFn,
  type CorpChatMessage,
  type CorpChatRequest,
  type CorpChatResult,
  type CorpRunResult,
  makeNodeWorkspaceFs,
  makeNodeWorkspaceReadFs,
  parseArchitecture,
  parseCreateHierarchyArgs,
  parseEngineerOutput,
  parseManagerContracts,
  type RoleAgentActivity,
  type RoleAgentRunInput,
  type RoleAgentRunOutput,
  type RunRoleAgentFn,
  runCorp,
  type WorkspaceFs,
  type WorkspaceReadFs,
} from '@pi-desktop/harness/corp';
import type {
  Activity,
  ArtifactRef,
  ChecklistItem,
  ChecklistItemState,
  CoordinationEngine,
  CoordinationEvent,
  EngineStatus,
  EtaRange,
  InterfaceSeamView,
  ModuleRegionView,
  OrgChartView,
  OrgEdgeView,
  OrgNodeRole,
  OrgNodeState,
  OrgNodeView,
  ProductPeek,
  ProductPeekFile,
  TaskContext,
  TaskHandle,
  TaskResult,
  WorkerActivityEvent,
  WorkerBriefingView,
  WorkerTranscriptLine,
  WorkerTranscriptView,
} from '../index.js';

// ---------------------------------------------------------------------------
// A minimal single-producer/single-consumer async iterable (same shape as the
// SoloEngine's — self-contained so the boundary carries no runtime baggage).
// ---------------------------------------------------------------------------

class PushStream<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = [];
  private readonly waiters: Array<(r: IteratorResult<T>) => void> = [];
  private ended = false;

  push(value: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.buffer.push(value);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const buffered = this.buffer.shift();
        if (buffered !== undefined) return Promise.resolve({ value: buffered, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Workspace seam factory (injected — the engine never picks the fs itself)
// ---------------------------------------------------------------------------

/** The three fs seams {@link runCorp} needs, for one task. */
export interface CorpWorkspace {
  readonly fs: WorkspaceFs;
  readonly readFs: WorkspaceReadFs;
  readonly workspace: string;
  /** Optional teardown (remove a temp dir) once the run ends. */
  readonly cleanup?: () => void;
}

/** An in-memory workspace — no disk, for tests + the non-model smoke. */
export function createMemoryWorkspace(root = '/corp-run'): CorpWorkspace {
  const store = new Map<string, string>();
  return {
    workspace: root,
    fs: {
      writeFile: (path, content) => {
        store.set(path, content);
      },
    },
    readFs: {
      readFile: (path) => store.get(path),
      listFiles: (dir) => [...store.keys()].filter((p) => p.startsWith(dir)),
    },
  };
}

/** A real-disk workspace under `root/<taskId>` (the desktop main process uses this). */
export function createNodeWorkspaceFactory(root: string): (taskId: string) => CorpWorkspace {
  return (taskId) => ({
    fs: makeNodeWorkspaceFs(),
    readFs: makeNodeWorkspaceReadFs(),
    // A plain join without importing node:path (kept dependency-light here).
    workspace: `${root.replace(/\/+$/, '')}/${taskId}`,
  });
}

// ---------------------------------------------------------------------------
// Engine options
// ---------------------------------------------------------------------------

export interface CorpEngineOptions {
  /** The injected model seam — a real llama-server client, or a mock. */
  readonly chat: CorpChatFn;
  /**
   * The role-agent seam (pi-agnostic). When provided (the desktop main process
   * adapts `electron/corp/role-agent.ts`), the ENGINEER role runs as a real
   * agentic loop with file + bash tools; when omitted, engineers fall back to the
   * chat seam. Passed straight through to {@link runCorp}.
   */
  readonly runRoleAgent?: RunRoleAgentFn;
  /** Per-task fs seams (defaults to an in-memory workspace when omitted). */
  readonly workspaceFor?: (taskId: string) => CorpWorkspace;
  /** Dispatch at most this many engineers (passed to runCorp). */
  readonly limit?: number;
  /** Run up to this many engineer jobs concurrently, bounded by the contract DAG
   * (passed to runCorp; default 1 = sequential). */
  readonly concurrency?: number;
  /** CEO revise cycle cap (passed to runCorp; default 1). */
  readonly maxRevisions?: number;
  /** Base generation cap for judgment turns (passed to runCorp). */
  readonly maxTokens?: number;
  /** Global backstop caps (passed to runCorp). */
  readonly maxTurns?: number;
  readonly maxWallClockMs?: number;
  /** Clock seam (deterministic tests). Defaults to `Date.now`. */
  readonly now?: () => number;
}

// ---------------------------------------------------------------------------
// Per-task runtime — the observed state the event mapping grows
// ---------------------------------------------------------------------------

interface DivisionRuntime {
  readonly id: string;
  readonly name: string;
  module?: string;
}

interface ContractRuntime {
  readonly id: string;
  readonly nodeId: string;
  readonly title: string;
  readonly slot: string;
  readonly divisionId: string;
  readonly divisionName: string;
  readonly dependsOn: readonly string[];
  state: ChecklistItemState;
}

/**
 * The INTERNAL mutable mirror of a {@link WorkerTranscriptLine}: the engine grows
 * a streaming line's `text` in place as deltas arrive (and flips `streaming` off
 * when the block ends), which the `readonly` DTO forbids. Structurally assignable
 * to `WorkerTranscriptLine`, so {@link CorpEngine.getWorkerTranscript} returns the
 * same objects as the readonly view — no copy at the boundary.
 */
interface LiveLine {
  at: number;
  kind: WorkerTranscriptLine['kind'];
  text: string;
  path?: string;
  label?: string;
  detail?: string;
  streaming?: boolean;
}

interface CorpRuntime {
  readonly taskId: string;
  readonly task: string;
  readonly stream: PushStream<CoordinationEvent>;
  readonly workspace: CorpWorkspace;
  readonly startedAt: number;
  finished: boolean;
  aborted: boolean;
  status: EngineStatus;
  promoted: boolean;
  ceoName: string;
  divisions: DivisionRuntime[];
  contracts: ContractRuntime[];
  modules: ModuleRegionView[];
  interfaces: InterfaceSeamView[];
  readonly nodeState: Map<string, OrgNodeState>;
  readonly lines: Map<string, LiveLine[]>;
  /** Per-node CURRENT action right now ("thinking", "Searching the web: …",
   * "Writing src/menu.ts"), surfaced on the working org node + the transcript;
   * cleared the moment the node leaves `working`. */
  readonly currentAction: Map<string, string>;
  /** Per-node live context fullness (0..100), from the role agent's turn-boundary
   * records — the app's context ring fills from this during a run. Kept after a
   * node settles (an honest last reading), cleared only with the task. */
  readonly contextPercent: Map<string, number>;
  /** The OPEN streaming transcript line per node (assistant text OR reasoning),
   * mutated in place as deltas land; removed when the block ends. */
  readonly openStream: Map<string, { line: LiveLine; kind: 'message' | 'thinking' }>;
  /** Nodes whose streamed assistant text became a finalized `message` line — so
   * the chat-path preview line is not appended as a duplicate. */
  readonly streamedMessage: Set<string>;
  /** Manager attribution cursor (managers run one division at a time, in order). */
  mgrCursor: number;
  mgrRetryPending: boolean;
  /** Paths already surfaced as an {@link ArtifactRef} (dedup — one artifact per
   * distinct produced file, so the peek affordance points at each in turn). */
  readonly liveWrittenPaths: Set<string>;
  /** Monotonic counter for stable per-task artifact ids. */
  artifactSeq: number;
  result?: CorpRunResult;
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function firstLine(text: string): string {
  const line =
    text
      .split('\n')
      .find((l) => l.trim().length > 0)
      ?.trim() ?? 'Task';
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'x'
  );
}

/** Extract the first balanced `{…}` JSON object from `text` (string-aware scan).
 * Mirrors runCorp's private helper so promotion can be detected from the reply. */
function firstJsonObject(text: string | undefined): Record<string, unknown> | undefined {
  if (typeof text !== 'string') return undefined;
  const start = text.indexOf('{');
  if (start === -1) return undefined;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try {
        const parsed: unknown = JSON.parse(text.slice(start, i + 1));
        return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : undefined;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** Detect a promotion from the worker reply — a tool call or a JSON object. */
function detectDivisions(result: CorpChatResult): readonly string[] | undefined {
  for (const call of result.toolCalls ?? []) {
    const decoded =
      typeof call.arguments === 'string' ? firstJsonObject(call.arguments) : call.arguments;
    const parsed = parseCreateHierarchyArgs(decoded);
    if (parsed !== undefined) return parsed.divisions.map((d) => d.name);
  }
  const parsed = parseCreateHierarchyArgs(firstJsonObject(result.content));
  return parsed?.divisions.map((d) => d.name);
}

function preview(text: string, max = 400): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** Humanize a raw tool name for the neutral fallback ("run_python" → "run python"). */
function humanizeToolName(name: string): string {
  const words = name.replace(/[_-]+/g, ' ').trim();
  return words.length > 0 ? words : name;
}

/**
 * The ONE place the corp names a tool for a person: a resolved tool name (+ the
 * arg detail the app extracted) → a human {@link label}/{@link detail} for the
 * transcript line PLUS a one-line {@link summary} for the feed + the node's
 * current action. This is what turns a generic "Used a tool" into "Searched the
 * web: <query>" / "Reading <file>" / "Ran: <cmd>". Neutral + pure; `write`/`edit`
 * never reach here (they light the file map via the file-write path). Falls back
 * to a humanized name for an unknown tool — never a mislabeled file read.
 */
export function describeTool(
  toolName: string,
  detail: string | undefined,
  path: string | undefined,
): { label: string; detail?: string; summary: string } {
  const d = detail ?? path;
  const withDetail = (
    label: string,
    sep = ' ',
  ): { label: string; detail?: string; summary: string } =>
    d !== undefined
      ? { label, detail: d, summary: `${label}${sep}${d}` }
      : { label, summary: label };
  switch (toolName) {
    case 'web_search':
    case 'search':
    case 'search_web':
      return withDetail('Searched the web', ': ');
    case 'web_fetch':
    case 'fetch':
      return withDetail('Fetched a page', ': ');
    case 'read':
    case 'cat':
    case 'view':
      return d !== undefined
        ? { label: 'Reading', detail: d, summary: `Reading ${d}` }
        : { label: 'Reading', summary: 'Reading a file' };
    case 'bash':
    case 'shell':
    case 'run':
    case 'exec':
      return d !== undefined
        ? { label: 'Ran', detail: d, summary: `Ran: ${d}` }
        : { label: 'Ran', summary: 'Ran a command' };
    case 'grep':
    case 'find':
    case 'glob':
    case 'rg':
      return d !== undefined
        ? { label: 'Searched the code', detail: d, summary: `Searched the code: ${d}` }
        : { label: 'Searched the code', summary: 'Searched the code' };
    case 'ls':
    case 'list':
      return { label: 'Looked around', summary: 'Looked around the project' };
    case 'tool':
      // The nameless fallback — never the meaningless "Used a tool": say the
      // honest minimum ("Running a step"), with the arg detail when there is one.
      return d !== undefined
        ? { label: 'Running a step', detail: d, summary: `Running a step: ${d}` }
        : { label: 'Running a step', summary: 'Running a step' };
    default: {
      const nm = humanizeToolName(toolName);
      return d !== undefined
        ? { label: `Used ${nm}`, detail: d, summary: `Used ${nm}: ${d}` }
        : { label: `Used ${nm}`, summary: `Used ${nm}` };
    }
  }
}

const CEO_NODE = 'ceo';
const SOLO_NODE = 'solo';
const ARCHITECT_NODE = 'architect';

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

let taskSeq = 0;
function nextTaskId(): string {
  taskSeq += 1;
  return `corp-${Date.now().toString(36)}-${taskSeq.toString(36)}`;
}

/**
 * The corporation harness as a {@link CoordinationEngine}. One instance can drive
 * many tasks (keyed by taskId); each `startTask` returns a handle synchronously and
 * runs {@link runCorp} in the background, streaming mapped events on the handle.
 */
export class CorpEngine implements CoordinationEngine {
  private readonly tasks = new Map<string, CorpRuntime>();

  constructor(private readonly opts: CorpEngineOptions) {}

  startTask(prompt: string, _ctx?: TaskContext): TaskHandle {
    const taskId = nextTaskId();
    const now = this.opts.now ?? Date.now;
    const workspace = (this.opts.workspaceFor ?? (() => createMemoryWorkspace()))(taskId);
    const rt: CorpRuntime = {
      taskId,
      task: prompt,
      stream: new PushStream<CoordinationEvent>(),
      workspace,
      startedAt: now(),
      finished: false,
      aborted: false,
      status: 'starting',
      promoted: false,
      ceoName: 'Pi',
      divisions: [],
      contracts: [],
      modules: [],
      interfaces: [],
      nodeState: new Map(),
      lines: new Map(),
      currentAction: new Map(),
      contextPercent: new Map(),
      openStream: new Map(),
      streamedMessage: new Set(),
      mgrCursor: 0,
      mgrRetryPending: false,
      liveWrittenPaths: new Set(),
      artifactSeq: 0,
    };
    this.tasks.set(taskId, rt);

    // Opening burst: a solo chart + an honest low-confidence ETA.
    this.emit(rt, { type: 'status', status: 'starting' });
    this.emit(rt, { type: 'org-chart', chart: this.buildChart(rt) });
    this.emit(rt, { type: 'eta', eta: { lowMinutes: 2, highMinutes: 12, confidence: 'low' } });
    this.emit(rt, {
      type: 'checklist',
      items: [{ id: 'task', label: firstLine(prompt), group: 'Task', state: 'in-progress' }],
    });

    // Run the harness in the background behind the observing seam.
    void runCorp({
      task: prompt,
      chat: this.observingChat(rt),
      // On the AGENT path the harness runs every role through the role-agent seam
      // (chat is never called), so the engine WRAPS the seam to (a) drive the same
      // org-chart/checklist state observePre/observePost build from a chat reply and
      // (b) stream LIVE activity from each turn (spec §11) — a mid-work file-touch,
      // a per-turn node pulse — as it happens, not only at contract termination.
      ...(this.opts.runRoleAgent !== undefined
        ? { runRoleAgent: this.observingRunRoleAgent(rt) }
        : {}),
      fs: workspace.fs,
      readFs: workspace.readFs,
      workspace: workspace.workspace,
      ...(this.opts.limit !== undefined ? { limit: this.opts.limit } : {}),
      ...(this.opts.concurrency !== undefined ? { concurrency: this.opts.concurrency } : {}),
      ...(this.opts.maxRevisions !== undefined ? { maxRevisions: this.opts.maxRevisions } : {}),
      ...(this.opts.maxTokens !== undefined ? { maxTokens: this.opts.maxTokens } : {}),
      ...(this.opts.maxTurns !== undefined ? { maxTurns: this.opts.maxTurns } : {}),
      ...(this.opts.maxWallClockMs !== undefined
        ? { maxWallClockMs: this.opts.maxWallClockMs }
        : {}),
      ...(this.opts.now !== undefined ? { now: this.opts.now } : {}),
    })
      .then((result) => this.finish(rt, result))
      .catch((err) => this.finishError(rt, err));

    return { taskId, events: rt.stream };
  }

  /**
   * Start a task that terminates IMMEDIATELY because no model is available —
   * WITHOUT running the harness (no fake progress, no hollow run). Emits a clear
   * terminal state: a retired solo chart, a `status: 'error'`, and a `done`
   * carrying `message` as the user-meaningful error, so the situation room shows
   * an honest "the model isn't available" instead of a run that does nothing.
   *
   * The desktop host uses this when it cannot find or start a local model server
   * (a missing model is a loud, honest failure — never a silent degrade).
   */
  startUnavailable(_prompt: string, message: string, _ctx?: TaskContext): TaskHandle {
    const taskId = nextTaskId();
    const stream = new PushStream<CoordinationEvent>();
    const result: TaskResult = { outcome: 'failed', summary: message, error: message };
    // Buffered before the caller subscribes; delivered in order on iteration,
    // then the stream ends. No runCorp is ever invoked.
    stream.push({ type: 'org-chart', chart: { taskId, nodes: [soloNode('retired')], edges: [] } });
    stream.push({ type: 'status', status: 'error', detail: message });
    stream.push({ type: 'done', result });
    stream.end();
    return { taskId, events: stream };
  }

  steer(handle: TaskHandle, text: string): void {
    const rt = this.tasks.get(handle.taskId);
    if (!rt || rt.finished) return;
    // No steer seam into the frozen runCorp — surface it as steering activity on
    // the lead (honest: it is recorded, not injected as a faked user turn).
    const nodeId = rt.promoted ? CEO_NODE : SOLO_NODE;
    this.addLine(rt, nodeId, 'note', `steer: ${text}`);
    this.emit(rt, activity(nodeId, 'note', `You steered: ${text}`));
  }

  abort(handle: TaskHandle): void {
    const rt = this.tasks.get(handle.taskId);
    if (!rt || rt.finished) return;
    rt.aborted = true;
    // The observing seam short-circuits every subsequent turn to empty, so the
    // background runCorp winds down cheaply; we terminate the stream now.
    this.terminate(rt, { outcome: 'aborted', summary: 'Task stopped.' }, 'aborted', 'retired');
  }

  getOrgChart(handle: TaskHandle): OrgChartView {
    const rt = this.tasks.get(handle.taskId);
    if (!rt) return { taskId: handle.taskId, nodes: [soloNode('idle')], edges: [] };
    return this.buildChart(rt);
  }

  respondToPermission(handle: TaskHandle, requestId: string, granted: boolean): void {
    const rt = this.tasks.get(handle.taskId);
    if (!rt || rt.finished) return;
    this.emit(
      rt,
      activity(CEO_NODE, 'note', `permission ${requestId}: ${granted ? 'granted' : 'denied'}`),
    );
  }

  /**
   * The REAL captured turn stream for a node (the spec §11 click-through). Returns
   * `undefined` for an unknown node or one that has produced no attributable
   * activity yet — the app falls back to a generated preview for those.
   */
  getWorkerTranscript(handle: TaskHandle, nodeId: string): WorkerTranscriptView | undefined {
    const rt = this.tasks.get(handle.taskId);
    if (!rt) return undefined;
    const node = this.buildChart(rt).nodes.find((n) => n.id === nodeId);
    if (node === undefined) return undefined;
    const lines = rt.lines.get(nodeId) ?? [];
    if (lines.length === 0) return undefined;
    // LIVE flag: an open stream, or any line still marked streaming — the pane
    // keeps polling and renders the tail as live rather than a settled log.
    const streaming = rt.openStream.has(nodeId) || lines.some((l) => l.streaming === true);
    const currentAction = rt.currentAction.get(nodeId);
    const contextPercent = rt.contextPercent.get(nodeId);
    return {
      nodeId,
      role: node.role,
      briefing: this.briefingFor(rt, node),
      lines,
      ...(streaming ? { streaming: true } : {}),
      ...(currentAction !== undefined ? { currentAction } : {}),
      ...(contextPercent !== undefined ? { contextPercent } : {}),
    };
  }

  // --- Observation ---------------------------------------------------------

  private observingChat(rt: CorpRuntime): CorpChatFn {
    return async (request: CorpChatRequest): Promise<CorpChatResult> => {
      // Aborted: never call the model again — bound the wind-down cost.
      if (rt.aborted || rt.finished) return { content: '' };
      try {
        this.observePre(rt, request);
      } catch {
        // observation must never break the run
      }
      const result = await this.opts.chat(request);
      try {
        this.observePost(rt, request, result);
      } catch {
        // ditto
      }
      return result;
    };
  }

  private observePre(
    rt: CorpRuntime,
    req: CorpChatRequest,
    engineerContract?: ContractRuntime,
  ): void {
    switch (req.purpose) {
      case 'vision':
        // The CEO's first turn — form the vision before anyone builds (spec §4).
        // Pre-promotion the solo node is what's shown, so attribute it there.
        this.setStatus(rt, 'planning');
        this.setNode(rt, SOLO_NODE, 'working');
        this.addLine(rt, SOLO_NODE, 'note', 'Forming the vision — deciding what to build and why.');
        this.emit(rt, activity(SOLO_NODE, 'note', 'Forming the vision'));
        break;
      case 'worker':
        this.setStatus(rt, 'planning');
        this.setNode(rt, SOLO_NODE, 'working');
        this.addLine(rt, SOLO_NODE, 'note', 'Reading the request and deciding how to approach it.');
        this.emit(rt, activity(SOLO_NODE, 'note', 'Reading the request'));
        break;
      case 'architect':
        this.setStatus(rt, 'planning');
        this.setNode(rt, ARCHITECT_NODE, 'working');
        this.addLine(
          rt,
          ARCHITECT_NODE,
          'note',
          'Laying out the structure and the seams between areas.',
        );
        this.emit(rt, activity(ARCHITECT_NODE, 'note', 'Laying out the project structure'));
        break;
      case 'manager': {
        this.setStatus(rt, 'planning');
        const div = rt.divisions[rt.mgrCursor];
        if (div !== undefined) {
          this.setNode(rt, div.id, 'working');
          this.addLine(rt, div.id, 'note', `Breaking the ${div.name} area into buildable tasks.`);
          this.emit(rt, activity(div.id, 'note', `Planning the ${div.name} work`));
        }
        break;
      }
      case 'engineer': {
        this.setStatus(rt, 'working');
        // On the AGENT path the caller resolves the contract ONCE at the run's
        // invocation boundary and threads it in, so pre/live/done all attribute to
        // the SAME node even under parallel dispatch; the chat path attributes here.
        const c = engineerContract ?? this.attributeEngineer(rt, req);
        if (c !== undefined) {
          this.setNode(rt, c.nodeId, 'working');
          if (c.state === 'queued' || c.state === 'ready') c.state = 'in-progress';
          this.addLine(
            rt,
            c.nodeId,
            'note',
            `Picking up ${c.title}. Reading the shared touch points first.`,
          );
          this.emit(rt, activity(c.nodeId, 'message', `Working on ${c.title}`));
          this.emitChecklist(rt);
        }
        break;
      }
      case 'ceo':
      case 'revise':
        this.setStatus(rt, 'reviewing');
        this.setNode(rt, CEO_NODE, 'working');
        this.addLine(
          rt,
          CEO_NODE,
          'note',
          req.purpose === 'revise'
            ? 'Sending fixes back to the team and re-checking.'
            : 'Reviewing the whole build against the original request.',
        );
        this.emit(rt, activity(CEO_NODE, 'note', 'Checking the work'));
        break;
      case 'rescope': {
        this.setStatus(rt, 'reviewing');
        const div = rt.divisions[Math.max(0, rt.mgrCursor - 1)];
        if (div !== undefined) {
          this.addLine(rt, div.id, 'note', 'Re-scoping a piece that came up short.');
          this.emit(rt, activity(div.id, 'note', 'Re-scoping a stuck piece'));
        }
        break;
      }
    }
  }

  private observePost(rt: CorpRuntime, req: CorpChatRequest, result: CorpChatResult): void {
    switch (req.purpose) {
      case 'worker': {
        const divisions = detectDivisions(result);
        if (divisions !== undefined && divisions.length > 0) {
          rt.promoted = true;
          this.setNode(rt, SOLO_NODE, 'done');
          this.setNode(rt, CEO_NODE, 'working');
          this.setNode(rt, ARCHITECT_NODE, 'idle');
          rt.divisions = divisions.map((name) => ({ id: `div-${slug(name)}`, name }));
          for (const d of rt.divisions) this.setNode(rt, d.id, 'idle');
          // Plain words, never org jargon: say what actually happens to the
          // user's project — more hands are joining, and these are the areas.
          this.addLine(
            rt,
            CEO_NODE,
            'message',
            `This needs more than one pair of hands — bringing in ${divisions.join(', ')}.`,
          );
          this.emit(rt, { type: 'org-chart', chart: this.buildChart(rt) });
        } else if (!rt.streamedMessage.has(SOLO_NODE)) {
          // On the AGENT path the model's answer already streamed into a live message
          // line — don't append a truncated duplicate. The chat/mock path (no stream)
          // still gets the preview.
          this.addLine(rt, SOLO_NODE, 'message', preview(result.content));
        }
        break;
      }
      case 'architect': {
        const arch = parseArchitecture(result.content ?? '');
        this.applyArchitecture(rt, arch);
        this.setNode(rt, ARCHITECT_NODE, 'done');
        this.emit(rt, { type: 'org-chart', chart: this.buildChart(rt) });
        break;
      }
      case 'manager': {
        const div = rt.divisions[rt.mgrCursor];
        const contracts = parseManagerContracts(result.content ?? '');
        const nonEmpty = contracts.length > 0;
        if (div !== undefined && nonEmpty) this.addContracts(rt, div, contracts);
        // Advance to the next division after a non-empty turn OR after the single
        // retry (empty twice) — mirrors runCorp's withRetryOnEmpty per division.
        if (nonEmpty || rt.mgrRetryPending) {
          rt.mgrCursor += 1;
          rt.mgrRetryPending = false;
        } else {
          rt.mgrRetryPending = true;
        }
        if (nonEmpty) {
          this.emitChecklist(rt);
          this.emit(rt, { type: 'org-chart', chart: this.buildChart(rt) });
          this.emitEta(rt);
        }
        // Once every division has planned, the build begins.
        if (rt.mgrCursor >= rt.divisions.length && rt.contracts.length > 0) {
          this.setStatus(rt, 'working');
        }
        break;
      }
      case 'engineer': {
        const c = this.attributeEngineer(rt, req);
        const content = parseEngineerOutput(result.content ?? '');
        if (c !== undefined && content.trim() !== '') {
          const added = content.split('\n').length;
          this.setNode(rt, c.nodeId, 'done');
          // DONE the instant the engineer submits, so the "X of N" progress ticks
          // up live (bug 1) rather than jumping from 0 only at the terminal reconcile.
          c.state = 'done';
          this.addLine(rt, c.nodeId, 'message', `Wrote ${c.slot} — done.`);
          this.emit(rt, fileTouch(c.nodeId, c.slot, added));
          this.emitChecklist(rt);
          this.emitEta(rt);
        }
        break;
      }
      default:
        break;
    }
  }

  /** Best-effort: match an engineer turn to its contract by id / slot / title in
   * the prompt text. Falls back to the first still-unfinished contract. */
  private attributeEngineer(rt: CorpRuntime, req: CorpChatRequest): ContractRuntime | undefined {
    const text = req.messages.map((m) => m.content).join('\n');
    for (const c of rt.contracts) {
      if (
        (c.id.length > 2 && text.includes(c.id)) ||
        (c.slot.length > 2 && text.includes(c.slot)) ||
        (c.title.length > 3 && text.includes(c.title))
      ) {
        return c;
      }
    }
    // Fallback (the prompt named no contract): the first one that is neither
    // finished NOR already mid-run — so several engineers dispatched in parallel
    // never collide on the same "first unfinished" and light a node that is not
    // the one actually running (bug 2). Only if every unfinished contract is
    // already 'working' do we fall back to any unfinished one.
    return (
      rt.contracts.find(
        (c) =>
          c.state !== 'done' && c.state !== 'in-review' && rt.nodeState.get(c.nodeId) !== 'working',
      ) ?? rt.contracts.find((c) => c.state !== 'done' && c.state !== 'in-review')
    );
  }

  // --- Role-agent observation (the AGENT path — spec §11 live activity) --------

  /**
   * Wrap the injected role-agent seam so each role turn drives the SAME neutral
   * state a chat reply would (promotion, architecture, contracts, engineer
   * completion) AND streams LIVE activity as it happens. Only installed when a seam
   * is injected (the desktop main process); the chat-fallback path is untouched.
   */
  private observingRunRoleAgent(rt: CorpRuntime): RunRoleAgentFn {
    return (input: RoleAgentRunInput): Promise<RoleAgentRunOutput> =>
      this.runRoleObserved(rt, input);
  }

  private async runRoleObserved(
    rt: CorpRuntime,
    input: RoleAgentRunInput,
  ): Promise<RoleAgentRunOutput> {
    const inner = this.opts.runRoleAgent;
    // Aborted / finished (or, defensively, no seam): short-circuit to an empty
    // recorded output WITHOUT calling the model — the same wind-down bound the
    // observing chat seam applies, so a background run terminates cheaply.
    if (inner === undefined || rt.aborted || rt.finished) {
      return { filesWritten: [], finalText: '', toolCalls: [], terminatedReason: 'error' };
    }

    // A CHAT-shaped request so the EXISTING observePre attribution/state logic (which
    // the agent path otherwise never reaches, chat being un-called there) drives the
    // org chart. `userPrompt` carries the contract/slot text engineer attribution needs.
    const messages: CorpChatMessage[] = [{ role: 'user', content: input.userPrompt }];
    // A chat-shaped request the observer reads for `purpose` + `messages` only;
    // thinking/maxTokens are unused here but the shape requires them.
    const syntheticReq: CorpChatRequest = {
      purpose: input.purpose,
      messages,
      thinking: input.thinking,
      maxTokens: input.maxTokens ?? 0,
    };

    // Resolve the engineer's contract ONCE, HERE at the runRoleAgent invocation
    // boundary, and thread the SAME contract through pre / live-activity / done. This
    // is what makes exactly the actively-running node light (bug 2) — parallel
    // engineer runs each claim their own contract instead of racing on the shared
    // "first unfinished" fallback — and lets the done propagation (bug 1) settle the
    // very node that was lit.
    const engineerContract =
      input.purpose === 'engineer' ? this.attributeEngineer(rt, syntheticReq) : undefined;

    try {
      this.observePre(rt, syntheticReq, engineerContract);
      // A per-role-turn pulse: broadcast the chart so the just-activated node shows
      // as `working` (the situation room pulses working nodes).
      this.emit(rt, { type: 'org-chart', chart: this.buildChart(rt) });
    } catch {
      // observation must never break the run
    }

    // The chart node this run's live activity attributes to (undefined for a role
    // with no node — e.g. an advisory reviewer; its tool steps still stream un-owned).
    const liveNodeId =
      engineerContract !== undefined
        ? engineerContract.nodeId
        : this.roleRunNodeId(rt, syntheticReq);
    const onActivity = (record: RoleAgentActivity): void => {
      try {
        this.mapRoleActivity(rt, liveNodeId, record);
      } catch {
        // ditto
      }
    };

    const out = await inner({ ...input, onActivity });

    try {
      if (input.purpose === 'engineer') {
        this.observeEngineerAgentDone(rt, out, engineerContract);
      } else {
        // Reuse observePost: a chat-shaped result carries the role's finalText as
        // content plus its recorded tool calls, so promotion / architecture /
        // manager-contracts parse identically to the chat path.
        this.observePost(rt, syntheticReq, { content: out.finalText, toolCalls: out.toolCalls });
      }
    } catch {
      // ditto
    }
    return out;
  }

  /** The chart node a role turn attributes its live activity to (mirrors the
   * observePre attribution), or `undefined` for a role with no chart node. */
  private roleRunNodeId(rt: CorpRuntime, req: CorpChatRequest): string | undefined {
    switch (req.purpose) {
      case 'vision':
      case 'worker':
        return rt.promoted ? CEO_NODE : SOLO_NODE;
      case 'architect':
        return ARCHITECT_NODE;
      case 'manager':
        return rt.divisions[rt.mgrCursor]?.id;
      case 'engineer':
        return this.attributeEngineer(rt, req)?.nodeId;
      case 'ceo':
      case 'revise':
        return CEO_NODE;
      case 'rescope':
        return rt.divisions[Math.max(0, rt.mgrCursor - 1)]?.id;
      default:
        return undefined; // review / consult — no chart node
    }
  }

  /**
   * Map ONE live {@link RoleAgentActivity} record onto the neutral event stream +
   * the node's live transcript (spec §11): the model's STREAMING assistant text and
   * reasoning grow the transcript token by token; a NAMED tool step ("Searched the
   * web: …", "Reading …") lands the instant it starts; a mid-work file-touch (+ an
   * artifact so peek enables) fires the instant a file is written. Each also updates
   * the node's CURRENT action, so the tree + feed show what it is doing right now.
   */
  private mapRoleActivity(
    rt: CorpRuntime,
    nodeId: string | undefined,
    record: RoleAgentActivity,
  ): void {
    if (rt.finished) return;
    switch (record.kind) {
      case 'file-write': {
        if (record.path === undefined || record.path === '') return;
        const rel = record.path;
        if (nodeId !== undefined) {
          this.closeStream(rt, nodeId); // the write ends any open text/reasoning tail
          // Light the map MID-work: an ACTIVE (phase 'progress') touch, so the region
          // shows as being written NOW; the role's completion settles it to 'end'.
          this.addLine(rt, nodeId, 'file-touch', `writing ${rel}`, {
            path: rel,
            label: 'Writing',
            detail: rel,
          });
          rt.currentAction.set(nodeId, `Writing ${rel}`);
          // PUSH the live file edit as a per-node worker-activity so the inline chat
          // feed lights the +N/−N readout in real time (mirrors the transcript line).
          this.emit(
            rt,
            workerActivity(nodeId, {
              kind: 'file',
              path: rel,
              label: 'Writing',
              ...(record.linesAdded !== undefined ? { addedLines: record.linesAdded } : {}),
            }),
          );
        }
        this.emit(rt, liveFileTouch(nodeId, rel, record.linesAdded));
        // The first sight of a path becomes an artifact so the peek button enables
        // and latestArtifact points at the newest file (peek() serves the real content).
        this.surfaceArtifact(rt, nodeId, rel);
        break;
      }
      case 'tool': {
        if (nodeId === undefined) return;
        this.closeStream(rt, nodeId); // a tool starting ends the preceding text tail
        const tool = record.toolName ?? 'tool';
        // Name the ACTUAL tool + its arg (bug 3, click-through): "Searched the web:
        // <query>", "Reading <file>", "Ran: <cmd>". `text` stays the raw tool name
        // (the pane maps it to the right icon); label + detail carry the phrasing.
        const desc = describeTool(tool, record.detail, record.path);
        this.addLine(rt, nodeId, 'tool-call', tool, {
          label: desc.label,
          ...(desc.detail !== undefined ? { detail: desc.detail } : {}),
          ...(record.path !== undefined ? { path: record.path } : {}),
        });
        rt.currentAction.set(nodeId, desc.summary);
        this.emit(rt, activity(nodeId, 'tool-call', desc.summary));
        // PUSH the named tool step so the inline chat feed lands the row live.
        this.emit(
          rt,
          workerActivity(nodeId, {
            kind: 'tool',
            toolName: tool,
            label: desc.label,
            ...(desc.detail !== undefined ? { detail: desc.detail } : {}),
            ...(record.path !== undefined ? { path: record.path } : {}),
          }),
        );
        break;
      }
      case 'thinking': {
        if (nodeId === undefined) return;
        // A real "thinking…" state: open/grow a reasoning line while the model
        // reasons, and set the current action + a single feed pulse on the open.
        this.streamInto(rt, nodeId, 'thinking', record);
        if (record.phase === 'start') {
          rt.currentAction.set(nodeId, 'thinking');
          this.emit(rt, activity(nodeId, 'note', 'thinking…'));
        }
        break;
      }
      case 'assistant-text': {
        if (nodeId === undefined) return;
        // The model producing text in real time — the transcript's live tail grows.
        this.streamInto(rt, nodeId, 'message', record);
        if (record.phase !== 'end') rt.currentAction.set(nodeId, 'Responding');
        break;
      }
      case 'turn-start': {
        if (nodeId !== undefined) {
          // The node is lit ONLY while its agent is mid-turn (bug 2) — the run's
          // completion boundary (observeEngineerAgentDone / observePost) settles it.
          this.setNode(rt, nodeId, 'working');
          if (record.contextPercent !== undefined) {
            rt.contextPercent.set(nodeId, record.contextPercent);
          }
          // NOTE: the redundant "— continued (turn N) —" divider is intentionally
          // NOT emitted — the streaming text/reasoning/tool lines already read as
          // continuous work, and the owner found the turn labels noise.
        }
        break;
      }
      case 'turn-end':
        if (nodeId !== undefined) {
          this.closeStream(rt, nodeId);
          if (record.contextPercent !== undefined) {
            rt.contextPercent.set(nodeId, record.contextPercent);
          }
        }
        break;
    }
  }

  /**
   * Grow the node's OPEN streaming transcript line (assistant text or reasoning)
   * from a {@link RoleAgentActivity} `start`/`delta`/`end`. `start` opens a fresh
   * streaming line (closing any prior tail); `delta` appends the increment in
   * place; `end` sets the final text and clears the streaming flag. Robust to a
   * missing `start` (a stray delta opens a line). The line objects are the SAME
   * ones {@link getWorkerTranscript} returns, so a poll mid-stream sees the tail
   * that has grown since the last read — proving live streaming, not "working…".
   */
  private streamInto(
    rt: CorpRuntime,
    nodeId: string,
    kind: 'message' | 'thinking',
    record: RoleAgentActivity,
  ): void {
    // PUSH the same delta the transcript line accumulates, as a per-node
    // worker-activity, so the inline chat feed grows this block PER TOKEN (the
    // real-time channel) while the transcript stays the peek/late-join record.
    this.emitStreamDelta(rt, nodeId, kind, record);
    if (record.phase === 'start') {
      this.closeStream(rt, nodeId);
      const line = this.addLine(rt, nodeId, kind, record.text ?? '', { streaming: true });
      rt.openStream.set(nodeId, { line, kind });
      return;
    }
    let open = rt.openStream.get(nodeId);
    if (open === undefined || open.kind !== kind) {
      this.closeStream(rt, nodeId);
      const line = this.addLine(rt, nodeId, kind, '', { streaming: true });
      open = { line, kind };
      rt.openStream.set(nodeId, open);
    }
    if (record.phase === 'delta') {
      open.line.text += record.delta ?? '';
      return;
    }
    // end
    if (record.text !== undefined && record.text.length > 0) open.line.text = record.text;
    open.line.streaming = false;
    rt.openStream.delete(nodeId);
    if (kind === 'message' && open.line.text.trim() !== '') rt.streamedMessage.add(nodeId);
  }

  /**
   * Emit ONE `worker-activity` for a streamed text/reasoning delta — the additive
   * per-token PUSH the renderer's accumulator folds into a pi-style block. Carries
   * the same `phase` + increment the transcript line grows from: `start` seeds the
   * block (with the record's initial text, usually empty), `delta` appends the
   * increment, `end` closes it (with the authoritative full text, so a provider
   * that only reports on `end` still lands the whole block). `message` → `text`.
   */
  private emitStreamDelta(
    rt: CorpRuntime,
    nodeId: string,
    kind: 'message' | 'thinking',
    record: RoleAgentActivity,
  ): void {
    const wkKind = kind === 'message' ? 'text' : 'thinking';
    const delta = record.phase === 'delta' ? record.delta : record.text;
    this.emit(
      rt,
      workerActivity(nodeId, {
        kind: wkKind,
        ...(record.phase !== undefined ? { phase: record.phase } : {}),
        ...(delta !== undefined && delta !== '' ? { delta } : {}),
      }),
    );
  }

  /** Close a node's open streaming line (flip its live flag off), if any. Idempotent. */
  private closeStream(rt: CorpRuntime, nodeId: string): void {
    const open = rt.openStream.get(nodeId);
    if (open !== undefined) {
      open.line.streaming = false;
      rt.openStream.delete(nodeId);
    }
  }

  /**
   * The AGENT engineer's completion (its files ARE its submission — there is no
   * reply to parse, unlike the chat path's observePost). `c` is the contract claimed
   * for THIS run at its invocation boundary (so completion settles the very node that
   * was lit). Two terminal outcomes:
   *  - COMPLETED (files harvested): mark the contract DONE the instant the engineer
   *    finishes, emit the checklist so the situation-room "X of N" ticks up live (bug
   *    1), and settle the node working → done (bug 2).
   *  - NO DELIVERABLE (declared unfulfillable / errored — zero files): the run is
   *    over, so the node must NOT stay lit (bug 2). Settle it dim (blocked) and mark
   *    the contract blocked so the honest denominator counts it finished-not-done;
   *    dispatch owns the real failure/skip cascade and finish() reconciles the rest.
   */
  private observeEngineerAgentDone(
    rt: CorpRuntime,
    out: RoleAgentRunOutput,
    c: ContractRuntime | undefined,
  ): void {
    if (c === undefined) return;
    if (out.filesWritten.length === 0) {
      this.setNode(rt, c.nodeId, 'blocked');
      c.state = 'blocked';
      this.addLine(rt, c.nodeId, 'note', `Finished without producing ${c.slot}.`);
      this.emitChecklist(rt);
      this.emit(rt, { type: 'org-chart', chart: this.buildChart(rt) });
      return;
    }
    this.setNode(rt, c.nodeId, 'done');
    c.state = 'done';
    for (const f of out.filesWritten) {
      this.addLine(rt, c.nodeId, 'message', `Wrote ${f.path} — done.`);
      this.emit(rt, endFileTouch(c.nodeId, f.path));
      this.surfaceArtifact(rt, c.nodeId, f.path);
    }
    this.emitChecklist(rt);
    this.emitEta(rt);
    this.emit(rt, { type: 'org-chart', chart: this.buildChart(rt) });
  }

  /** Emit an {@link ArtifactEvent} for a produced path the first time it appears
   * (deduped), so the situation room's "peek at what we have so far" affordance
   * enables and points at the in-progress product. */
  private surfaceArtifact(rt: CorpRuntime, nodeId: string | undefined, path: string): void {
    if (rt.liveWrittenPaths.has(path)) return;
    rt.liveWrittenPaths.add(path);
    rt.artifactSeq += 1;
    const artifact: ArtifactRef = {
      id: `peek-${rt.taskId}-${rt.artifactSeq}`,
      title: `Build so far — ${path}`,
      kind: 'file',
      path,
      ...(nodeId !== undefined ? { nodeId } : {}),
      timestamp: (this.opts.now ?? Date.now)(),
    };
    this.emit(rt, { type: 'artifact', artifact });
  }

  /**
   * A live snapshot of the in-progress product tree — the REAL "peek at what we
   * have so far" (spec §11), read on demand from the current workspace (never a
   * mock). Returns `null` for an unknown task; an empty file list is honest (the
   * product tree has nothing yet). The desktop host serves this over `corp:peek`.
   */
  peek(handle: TaskHandle): ProductPeek | null {
    const rt = this.tasks.get(handle.taskId);
    if (rt === undefined) return null;
    return buildProductPeek(rt, (this.opts.now ?? Date.now)());
  }

  private applyArchitecture(rt: CorpRuntime, arch: Architecture): void {
    rt.modules = arch.moduleMap.map((m) => ({
      path: m.path,
      owner: m.owner,
      ...(m.purpose ? { purpose: m.purpose } : {}),
    }));
    rt.interfaces = arch.interfaces.map((i) => ({
      name: i.name,
      exposedBy: i.exposedBy,
      path: i.path,
      consumedBy: [...i.consumedBy],
    }));
    // Attach each division its owned module directory (for the worker briefing).
    for (const d of rt.divisions) {
      const owned = arch.moduleMap.find((m) => m.owner === d.name);
      if (owned !== undefined) d.module = owned.path;
    }
  }

  private addContracts(
    rt: CorpRuntime,
    div: DivisionRuntime,
    contracts: readonly Contract[],
  ): void {
    for (const c of contracts) {
      if (rt.contracts.some((x) => x.id === c.id)) continue;
      rt.contracts.push({
        id: c.id,
        nodeId: `eng-${slug(c.id)}`,
        title: c.title || c.id,
        slot: c.slot || '',
        divisionId: div.id,
        divisionName: div.name,
        dependsOn: [...c.dependsOn],
        state: 'queued',
      });
      this.setNode(rt, `eng-${slug(c.id)}`, 'idle');
    }
  }

  // --- Termination ---------------------------------------------------------

  private finish(rt: CorpRuntime, result: CorpRunResult): void {
    if (rt.finished) return;
    rt.result = result;
    // Reconcile the checklist from the terminal state.
    const failed = new Set(result.failures.map((f) => f.contractId));
    for (const c of rt.contracts) {
      if (failed.has(c.id)) c.state = 'blocked';
      else if (c.state === 'in-review' || c.state === 'in-progress') c.state = 'done';
    }
    const outcome: TaskResult['outcome'] =
      result.terminatedReason === 'error' ? 'failed' : 'completed';
    const summary =
      result.ceoDecision?.notes ??
      (result.promoted
        ? `Delivered across ${result.divisions.length} area(s).`
        : (result.directAnswerPreview ?? 'Answered directly.'));
    const status: EngineStatus = outcome === 'failed' ? 'error' : 'done';
    this.terminate(rt, { outcome, summary }, status, 'done', failed);
  }

  private finishError(rt: CorpRuntime, err: unknown): void {
    if (rt.finished) return;
    const message = err instanceof Error ? err.message : String(err);
    this.terminate(rt, { outcome: 'failed', summary: message, error: message }, 'error', 'retired');
  }

  /** Emit the terminal org-chart + checklist + status + `done`, exactly once. */
  private terminate(
    rt: CorpRuntime,
    result: TaskResult,
    status: EngineStatus,
    finalNodeState: OrgNodeState,
    failedContracts?: ReadonlySet<string>,
  ): void {
    if (rt.finished) return;
    rt.finished = true;
    // The run is over: no node has a live action, and any dangling streaming tail is
    // settled (its live flag off) so a post-run transcript reads as a finished log.
    rt.currentAction.clear();
    for (const list of rt.lines.values())
      for (const line of list) if (line.streaming === true) line.streaming = false;
    rt.openStream.clear();
    // Settle every node (failed engineers retire; the rest reach finalNodeState).
    for (const key of rt.nodeState.keys()) rt.nodeState.set(key, finalNodeState);
    if (failedContracts !== undefined) {
      for (const c of rt.contracts) {
        if (failedContracts.has(c.id)) rt.nodeState.set(c.nodeId, 'retired');
      }
    }
    rt.status = status;
    this.emit(rt, { type: 'org-chart', chart: this.buildChart(rt) });
    this.emitChecklist(rt);
    this.emit(rt, { type: 'status', status });
    this.emit(rt, { type: 'done', result });
    rt.stream.end();
    try {
      rt.workspace.cleanup?.();
    } catch {
      // best-effort teardown
    }
  }

  // --- Emit helpers --------------------------------------------------------

  private emit(rt: CorpRuntime, event: CoordinationEvent): void {
    // Push unconditionally: the PushStream drops everything after `end()`, and the
    // terminal burst runs synchronously in `terminate` (before `end()`), so the
    // final org-chart / checklist / status / done all land. Late observation emits
    // from a winding-down background run push into an already-ended stream (no-op).
    rt.stream.push(event);
  }

  private setStatus(rt: CorpRuntime, status: EngineStatus): void {
    if (rt.finished || rt.status === status) return;
    rt.status = status;
    this.emit(rt, { type: 'status', status });
  }

  private setNode(rt: CorpRuntime, id: string, state: OrgNodeState): void {
    rt.nodeState.set(id, state);
    // A node that stops working has no current action and no live tail — clear both
    // so the tree/transcript never show a stale "thinking…" on a settled node.
    if (state !== 'working') {
      rt.currentAction.delete(id);
      this.closeStream(rt, id);
    }
  }

  private addLine(
    rt: CorpRuntime,
    nodeId: string,
    kind: LiveLine['kind'],
    text: string,
    extra?: { path?: string; label?: string; detail?: string; streaming?: boolean },
  ): LiveLine {
    const at = (this.opts.now ?? Date.now)() - rt.startedAt;
    const line: LiveLine = {
      at,
      kind,
      text,
      ...(extra?.path !== undefined ? { path: extra.path } : {}),
      ...(extra?.label !== undefined ? { label: extra.label } : {}),
      ...(extra?.detail !== undefined ? { detail: extra.detail } : {}),
      ...(extra?.streaming ? { streaming: true } : {}),
    };
    const list = rt.lines.get(nodeId) ?? [];
    list.push(line);
    rt.lines.set(nodeId, list);
    return line;
  }

  private emitChecklist(rt: CorpRuntime): void {
    this.emit(rt, { type: 'checklist', items: this.buildChecklist(rt) });
  }

  private emitEta(rt: CorpRuntime): void {
    const eta = this.computeEta(rt);
    if (eta !== undefined) this.emit(rt, { type: 'eta', eta });
  }

  private computeEta(rt: CorpRuntime): EtaRange | undefined {
    const total = rt.contracts.length;
    if (total === 0) return undefined;
    const done = rt.contracts.filter((c) => c.state === 'done' || c.state === 'in-review').length;
    const remaining = Math.max(0, total - done);
    const low = Math.max(1, Math.round(remaining * 0.25));
    const high = Math.max(low + 1, Math.round(remaining * 0.7) + 1);
    const confidence: EtaRange['confidence'] =
      done === 0 ? 'low' : done * 2 >= total ? 'high' : 'medium';
    return { lowMinutes: low, highMinutes: high, confidence };
  }

  // --- View builders -------------------------------------------------------

  /**
   * A division node is lit ('working') ONLY while one of its builders is mid-run
   * (bug 2) — NOT for the whole dispatch just because the manager's planning turn
   * once set it 'working'. Derived from its contracts: any builder currently
   * 'working' → 'working'; every contract done → 'done'; any blocked (and none
   * running) → 'blocked'; otherwise dim ('idle'). Before any contract exists the
   * manager is still planning, so the raw node state carries through (working during
   * that turn, idle otherwise).
   */
  private divisionState(
    rt: CorpRuntime,
    div: DivisionRuntime,
    raw: (id: string) => OrgNodeState,
  ): OrgNodeState {
    const contracts = rt.contracts.filter((c) => c.divisionId === div.id);
    if (contracts.length === 0) return raw(div.id);
    if (contracts.some((c) => rt.nodeState.get(c.nodeId) === 'working')) return 'working';
    if (contracts.every((c) => c.state === 'done')) return 'done';
    if (contracts.some((c) => c.state === 'blocked')) return 'blocked';
    return 'idle';
  }

  private buildChart(rt: CorpRuntime): OrgChartView {
    const nodes: OrgNodeView[] = [];
    const edges: OrgEdgeView[] = [];
    const state = (id: string): OrgNodeState => rt.nodeState.get(id) ?? 'idle';

    if (!rt.promoted) {
      nodes.push({ id: SOLO_NODE, role: 'solo', name: 'Pi', state: state(SOLO_NODE) });
    } else {
      nodes.push({ id: CEO_NODE, role: 'ceo', name: rt.ceoName, state: state(CEO_NODE) });
      if (rt.modules.length > 0 || rt.interfaces.length > 0) {
        nodes.push({
          id: ARCHITECT_NODE,
          role: 'specialist',
          name: 'Architecture',
          parentId: CEO_NODE,
          state: state(ARCHITECT_NODE),
        });
        edges.push({ from: CEO_NODE, to: ARCHITECT_NODE });
      }
      for (const d of rt.divisions) {
        nodes.push({
          id: d.id,
          role: 'division',
          name: d.name,
          parentId: CEO_NODE,
          state: this.divisionState(rt, d, state),
        });
        edges.push({ from: CEO_NODE, to: d.id });
      }
      for (const c of rt.contracts) {
        nodes.push({
          id: c.nodeId,
          role: 'engineer',
          name: c.title,
          parentId: c.divisionId,
          state: state(c.nodeId),
        });
        edges.push({ from: c.divisionId, to: c.nodeId });
      }
    }
    // Attach each WORKING node its live current action ("thinking", "Searching the
    // web: …", "Writing src/menu.ts") so the tree shows what each worker is doing
    // this instant. Only working nodes carry it — a settled node clears it (setNode).
    const withActions = nodes.map((n) => {
      const action = n.state === 'working' ? rt.currentAction.get(n.id) : undefined;
      return action !== undefined ? { ...n, currentAction: action } : n;
    });
    return {
      taskId: rt.taskId,
      nodes: withActions,
      edges,
      ...(rt.modules.length > 0 ? { modules: rt.modules } : {}),
      ...(rt.interfaces.length > 0 ? { interfaces: rt.interfaces } : {}),
    };
  }

  private buildChecklist(rt: CorpRuntime): ChecklistItem[] {
    if (rt.contracts.length === 0) {
      return [
        {
          id: 'task',
          label: firstLine(rt.task),
          group: 'Task',
          state: rt.finished ? 'done' : 'in-progress',
        },
      ];
    }
    return rt.contracts.map((c) => ({
      id: c.id,
      label: c.title,
      group: c.divisionName,
      state: c.state,
      ...(c.dependsOn.length > 0 ? { dependsOn: [...c.dependsOn] } : {}),
    }));
  }

  private briefingFor(rt: CorpRuntime, node: OrgNodeView): WorkerBriefingView {
    switch (node.role) {
      case 'solo':
      case 'ceo':
        return {
          workerName: node.name,
          roleLine: 'Lead',
          title: firstLine(rt.task),
          goal: rt.task,
          deliverables: ['a working result', 'reviewed before it ships'],
        };
      case 'specialist':
        return {
          workerName: node.name,
          roleLine: 'Architecture',
          title: 'Lay out the project structure',
          goal: 'Define the shared shape the whole team builds against: one directory region per area, and the typed seams between them.',
          deliverables: ['one region per area', 'the cross-area interface seams'],
        };
      case 'division':
      case 'division-head': {
        const div = rt.divisions.find((d) => d.id === node.id);
        return {
          workerName: node.name,
          roleLine: `Area lead · ${node.name}`,
          title: `Deliver the ${node.name} area`,
          ...(div?.module ? { area: div.module } : {}),
          goal: `Break ${node.name} into buildable tasks, keep the builders unblocked, and hold the area's shared touch points stable.`,
          deliverables: [
            `${node.name} complete`,
            'tasks sequenced by dependency',
            'hand-offs honored',
          ],
        };
      }
      default: {
        const c = rt.contracts.find((x) => x.nodeId === node.id);
        return {
          workerName: node.name,
          roleLine: c ? `Builder · ${c.divisionName}` : 'Builder',
          title: c ? `Build ${c.title}` : node.name,
          ...(c?.slot ? { area: c.slot } : {}),
          goal: c
            ? `Write ${c.slot} so this piece works end to end, keeping to the shared touch points.`
            : 'Build this piece of the project.',
          deliverables: c ? [c.slot, 'passes review'] : ['its piece of the build'],
        };
      }
    }
  }
}

// --- module-scope helpers ----------------------------------------------------

function soloNode(state: OrgNodeState): OrgNodeView {
  return { id: SOLO_NODE, role: 'solo' as OrgNodeRole, name: 'Pi', state };
}

function activity(nodeId: string, kind: Activity['kind'], summary: string): CoordinationEvent {
  return { type: 'activity', activity: { nodeId, kind, summary, timestamp: Date.now() } };
}

/** A per-node live delta PUSH ({@link WorkerActivityEvent}) — the real-time channel
 * the inline chat feed folds into a streaming block. `nodeId` is required (an
 * un-owned role's activity streams only into the transcript, never here). */
function workerActivity(
  nodeId: string,
  fields: Omit<WorkerActivityEvent, 'type' | 'nodeId'>,
): CoordinationEvent {
  return { type: 'worker-activity', nodeId, ...fields };
}

function fileTouch(nodeId: string, path: string, linesAdded: number): CoordinationEvent {
  return {
    type: 'activity',
    activity: {
      nodeId,
      kind: 'file-touch',
      summary: `wrote ${path}`,
      path,
      phase: 'end',
      linesAdded,
      timestamp: Date.now(),
    },
  };
}

/** A LIVE, mid-work file-touch (phase `progress`): the file map lights the region
 * as being written NOW. `nodeId` may be absent (an un-owned role's write). */
function liveFileTouch(
  nodeId: string | undefined,
  path: string,
  linesAdded: number | undefined,
): CoordinationEvent {
  return {
    type: 'activity',
    activity: {
      ...(nodeId !== undefined ? { nodeId } : {}),
      kind: 'file-touch',
      summary: `writing ${path}`,
      path,
      phase: 'progress',
      ...(linesAdded !== undefined ? { linesAdded } : {}),
      timestamp: Date.now(),
    },
  };
}

/** The terminal (phase `end`) file-touch for an AGENT engineer's produced file —
 * settles the map region from "being written" to "written". */
function endFileTouch(nodeId: string, path: string): CoordinationEvent {
  return {
    type: 'activity',
    activity: {
      nodeId,
      kind: 'file-touch',
      summary: `wrote ${path}`,
      path,
      phase: 'end',
      timestamp: Date.now(),
    },
  };
}

/** Paths a product peek never reports (junk a stray bash step might create). */
const PEEK_SKIP = /(?:^|\/)(?:node_modules|\.git|\.pi|\.cache|dist)(?:\/|$)/;
/** Bound the peek: files returned, and per-file preview chars (a snapshot, not a
 * full export — the whole tree can be large mid-build). */
const PEEK_MAX_FILES = 200;
const PEEK_MAX_FILE_CHARS = 64 * 1024;

/** UTF-8 byte length of a produced file (no node:Buffer dependency). */
function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** A `/`-separated path relative to the workspace root (strips the root prefix). */
function relativeTo(root: string, abs: string): string {
  const normRoot = root.replace(/[/\\]+$/, '');
  const normAbs = abs.replace(/\\/g, '/');
  const normRootFwd = normRoot.replace(/\\/g, '/');
  const rel = normAbs.startsWith(normRootFwd) ? normAbs.slice(normRootFwd.length) : normAbs;
  return rel.replace(/^\/+/, '');
}

/**
 * Read the CURRENT product tree out of a task's workspace into a neutral
 * {@link ProductPeek} — the real in-progress files (path + size + a bounded content
 * preview), sorted, junk-filtered, and capped. Pure aside from the injected read
 * seam; never throws (a failed list/read simply contributes nothing).
 */
function buildProductPeek(rt: CorpRuntime, capturedAt: number): ProductPeek {
  const root = rt.workspace.workspace;
  let absPaths: readonly string[];
  try {
    absPaths = rt.workspace.readFs.listFiles(root);
  } catch {
    absPaths = [];
  }
  const entries = absPaths
    .map((abs) => ({ abs, rel: relativeTo(root, abs) }))
    .filter(({ rel }) => rel !== '' && !PEEK_SKIP.test(rel))
    .sort((a, b) => a.rel.localeCompare(b.rel));

  const files: ProductPeekFile[] = [];
  let totalBytes = 0;
  let fileCount = 0;
  for (const { abs, rel } of entries) {
    let content: string | undefined;
    try {
      content = rt.workspace.readFs.readFile(abs);
    } catch {
      content = undefined;
    }
    if (content === undefined) continue;
    fileCount += 1;
    totalBytes += utf8Bytes(content);
    if (files.length >= PEEK_MAX_FILES) continue;
    const truncated = content.length > PEEK_MAX_FILE_CHARS;
    files.push({
      path: rel,
      bytes: utf8Bytes(content),
      content: truncated ? content.slice(0, PEEK_MAX_FILE_CHARS) : content,
      truncated,
    });
  }
  return { taskId: rt.taskId, files, fileCount, totalBytes, capturedAt };
}
