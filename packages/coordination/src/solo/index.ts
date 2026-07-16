/**
 * `@pi-desktop/coordination/solo` — the {@link SoloEngine} adapter skeleton
 * (docs/harness-architecture.md §1).
 *
 * The solo engine is what runs for small/simple tasks: a single agent, no
 * corporation. Per the spec it is the base case the corporation *grows from* —
 * "a trivial solo pi engine also implements this interface." This file proves
 * the {@link CoordinationEngine} interface is implementable and pins down the
 * exact seams where Phase 2 wires it to the real pi flow.
 *
 * SKELETON — the delegation to the live pi/harness flow is STUBBED. It does NOT
 * spawn pi, and it does NOT touch the app's live `pi-connect`/pi-main. Instead
 * it emits a small, representative, deterministic event stream so the boundary
 * is exercisable end-to-end (and unit-testable) today. Every place a real
 * implementation would call into `@pi-desktop/engine/main` (the `PiBridge`) or
 * `@pi-desktop/harness/corp` is marked `PHASE 2:` with the concrete target.
 *
 * Node-side only (engines run in the Electron main process); the renderer never
 * imports this subpath — it consumes the neutral DTOs from the package root over
 * IPC. This file therefore stays free of the RENDERER-BARREL concern by location.
 */

import type {
  Activity,
  CoordinationEngine,
  CoordinationEvent,
  OrgChartView,
  OrgNodeState,
  TaskContext,
  TaskHandle,
  TaskResult,
} from '../index.js';

/**
 * A minimal single-producer/single-consumer async iterable: the engine pushes
 * {@link CoordinationEvent}s in; a `for await` drains them. Buffers events
 * produced before iteration starts, and resolves a pending `next()` the instant
 * an event arrives. Self-contained (no deps) so the boundary carries no runtime
 * baggage. PHASE 2 keeps this exact shape but the pushes come from a `PiBridge`
 * event callback instead of the scripted stub below.
 */
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

/** Per-task bookkeeping the engine keeps in memory. */
interface SoloTask {
  readonly stream: PushStream<CoordinationEvent>;
  /** The current org-chart snapshot returned by {@link SoloEngine.getOrgChart}. */
  chart: OrgChartView;
  /** Set once a terminal `done` has been emitted; guards double-termination. */
  finished: boolean;
}

/**
 * A single, project-scoped id counter is enough for a skeleton (real ids will
 * come from the pi session / org-chart layer in Phase 2).
 */
let taskSeq = 0;

function nextTaskId(): string {
  taskSeq += 1;
  return `solo-${Date.now().toString(36)}-${taskSeq.toString(36)}`;
}

/** Build the solo chart: one node that IS the whole "corporation" pre-promotion. */
function soloChart(taskId: string, state: OrgNodeState): OrgChartView {
  return {
    taskId,
    nodes: [{ id: 'solo', role: 'solo', name: 'Solo agent', state }],
    edges: [],
  };
}

/**
 * A plain solo-agent implementation of {@link CoordinationEngine}. Phase 1
 * skeleton: it wires the interface shape and event flow; the actual model work
 * is stubbed (see the class-level note). Because the corporation is "the solo
 * engine that grew," this is also the promotion seam — Phase 2's
 * `create_production_hierarchy` swaps the corp engine in behind the same handle.
 */
export class SoloEngine implements CoordinationEngine {
  private readonly tasks = new Map<string, SoloTask>();

  startTask(prompt: string, ctx?: TaskContext): TaskHandle {
    const taskId = nextTaskId();
    const stream = new PushStream<CoordinationEvent>();
    const task: SoloTask = { stream, chart: soloChart(taskId, 'working'), finished: false };
    this.tasks.set(taskId, task);

    // PHASE 2: spawn / attach the pi child here and forward its events instead
    // of the scripted burst below:
    //   const bridge = new PiBridge(opts, (e) => this.translate(taskId, e));
    //   await bridge.ready();
    //   await bridge.prompt(prompt, { images: ctx?.images, ... });
    // The `PiBridge` (@pi-desktop/engine/main) already exposes prompt/steer/
    // abort/respondUi, so this class becomes a thin translator from
    // PiBridgeEvent → CoordinationEvent. See docs/coordination-engine.md.
    this.emitScriptedRun(task, prompt, ctx);

    return { taskId, events: stream };
  }

  steer(handle: TaskHandle, text: string): void {
    const task = this.tasks.get(handle.taskId);
    if (!task || task.finished) return;
    // PHASE 2: forward as no-seam steering → `PiBridge.steer(text)`.
    task.stream.push(activity({ kind: 'note', summary: `steer: ${text}` }));
  }

  abort(handle: TaskHandle): void {
    const task = this.tasks.get(handle.taskId);
    if (!task || task.finished) return;
    // PHASE 2: `PiBridge.abort()` (graceful) then `kill()` on timeout.
    this.finish(task, handle.taskId, { outcome: 'aborted', summary: 'Task aborted by user.' });
  }

  getOrgChart(handle: TaskHandle): OrgChartView {
    return this.tasks.get(handle.taskId)?.chart ?? soloChart(handle.taskId, 'idle');
  }

  respondToPermission(handle: TaskHandle, requestId: string, granted: boolean): void {
    const task = this.tasks.get(handle.taskId);
    if (!task || task.finished) return;
    // PHASE 2: map to the pi extension-UI answer channel →
    // `PiBridge.respondUi(requestId, answer)` (e.g. the git approve/deny prompt).
    task.stream.push(
      activity({
        kind: 'note',
        summary: `permission ${requestId}: ${granted ? 'granted' : 'denied'}`,
      }),
    );
  }

  /**
   * Emit a small, deterministic, representative run. This stands in for the real
   * pi turn: a `starting` → `working` → `done` arc with an honest ETA range and
   * a one-item checklist. The scripted burst is buffered synchronously; the
   * terminal `done` is scheduled on a microtask so a synchronous
   * {@link abort}/{@link steer} right after {@link startTask} still lands first.
   */
  private emitScriptedRun(task: SoloTask, prompt: string, ctx?: TaskContext): void {
    const { stream } = task;
    stream.push({ type: 'status', status: 'starting' });
    stream.push({ type: 'org-chart', chart: task.chart });
    stream.push({ type: 'eta', eta: { lowMinutes: 1, highMinutes: 5, confidence: 'low' } });
    stream.push({
      type: 'checklist',
      items: [
        {
          id: 'solo',
          label: firstLine(prompt),
          group: 'Solo',
          state: 'in-progress',
        },
      ],
    });
    stream.push({ type: 'status', status: 'working' });
    stream.push(
      activity({
        kind: 'note',
        summary:
          'SoloEngine skeleton: pi delegation is stubbed (Phase 2 wires PiBridge). ' +
          `effort=${ctx?.effort ?? 'default'}, mode=${ctx?.ceoMode ?? 'ask'}.`,
      }),
    );

    // The stubbed "work" completes on the next microtask (unless aborted first).
    queueMicrotask(() => {
      this.finish(task, task.chart.taskId, {
        outcome: 'completed',
        summary: 'Solo task complete (skeleton — no real work performed).',
        artifacts: [],
      });
    });
  }

  /** Emit the terminal `done` (with a final org-chart) exactly once. */
  private finish(task: SoloTask, taskId: string, result: TaskResult): void {
    if (task.finished) return;
    task.finished = true;
    const state: OrgNodeState = result.outcome === 'completed' ? 'done' : 'retired';
    task.chart = soloChart(taskId, state);
    task.stream.push({ type: 'org-chart', chart: task.chart });
    if (result.outcome === 'aborted') {
      task.stream.push({ type: 'status', status: 'aborted' });
    } else if (result.outcome === 'failed') {
      task.stream.push({ type: 'status', status: 'error' });
    } else {
      task.stream.push({ type: 'status', status: 'done' });
      task.stream.push({
        type: 'checklist',
        items: [{ id: 'solo', label: 'done', group: 'Solo', state: 'done' }],
      });
    }
    task.stream.push({ type: 'done', result });
    task.stream.end();
  }
}

/** Build an {@link Activity} event, timestamped now. */
function activity(a: Omit<Activity, 'timestamp'>): CoordinationEvent {
  return { type: 'activity', activity: { ...a, timestamp: Date.now() } };
}

/** First non-empty line of a prompt, trimmed for a checklist label. */
function firstLine(prompt: string): string {
  const line =
    prompt
      .split('\n')
      .find((l) => l.trim().length > 0)
      ?.trim() ?? 'Task';
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
}
