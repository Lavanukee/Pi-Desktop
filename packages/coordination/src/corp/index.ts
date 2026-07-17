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
  type CorpChatRequest,
  type CorpChatResult,
  type CorpRunResult,
  makeNodeWorkspaceFs,
  makeNodeWorkspaceReadFs,
  parseArchitecture,
  parseCreateHierarchyArgs,
  parseEngineerOutput,
  parseManagerContracts,
  type RunRoleAgentFn,
  runCorp,
  type WorkspaceFs,
  type WorkspaceReadFs,
} from '@pi-desktop/harness/corp';
import type {
  Activity,
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
  TaskContext,
  TaskHandle,
  TaskResult,
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
  readonly lines: Map<string, WorkerTranscriptLine[]>;
  /** Manager attribution cursor (managers run one division at a time, in order). */
  mgrCursor: number;
  mgrRetryPending: boolean;
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
      mgrCursor: 0,
      mgrRetryPending: false,
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
      ...(this.opts.runRoleAgent !== undefined ? { runRoleAgent: this.opts.runRoleAgent } : {}),
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
    return { nodeId, role: node.role, briefing: this.briefingFor(rt, node), lines };
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

  private observePre(rt: CorpRuntime, req: CorpChatRequest): void {
    switch (req.purpose) {
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
        const c = this.attributeEngineer(rt, req);
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
          this.addLine(rt, CEO_NODE, 'message', `Promoting to a team: ${divisions.join(', ')}.`);
          this.emit(rt, { type: 'org-chart', chart: this.buildChart(rt) });
        } else {
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
          c.state = 'in-review';
          this.addLine(rt, c.nodeId, 'message', `Wrote ${c.slot} — in review.`);
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
    return rt.contracts.find((c) => c.state !== 'done' && c.state !== 'in-review');
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
  }

  private addLine(rt: CorpRuntime, nodeId: string, kind: Activity['kind'], text: string): void {
    const at = (this.opts.now ?? Date.now)() - rt.startedAt;
    const list = rt.lines.get(nodeId) ?? [];
    list.push({ at, kind, text });
    rt.lines.set(nodeId, list);
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
          state: state(d.id),
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
    return {
      taskId: rt.taskId,
      nodes,
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
