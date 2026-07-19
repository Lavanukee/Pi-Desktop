/**
 * Renderer ↔ main bridge for the EXPERIMENTAL coordination harness (CorpEngine).
 * The engine runs in the main process; the renderer drives it over the `corp:*`
 * IPC channels and reconstructs a per-task `AsyncIterable<CoordinationEvent>` from
 * the `corp:event` stream (the situation room folds it). Gated behind the
 * production-harness flag — nothing here runs unless the flag / env override is on.
 *
 * A single module-level subscription buffers `corp:event`s by taskId, so events
 * that race ahead of `corp:start`'s response are never lost: a fresh consumer
 * flushes the buffer, then tails live events to the terminal `done`.
 */
import type {
  CoordinationEvent,
  OrgChartView,
  ProductPeek,
  TaskContext,
  WorkerTranscriptView,
} from '@pi-desktop/coordination';

/** A minimal single-consumer async iterable the situation room drains. */
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

/** Per-task inbox: events queued (pre-attach) or forwarded to a live stream. */
interface TaskInbox {
  queue: CoordinationEvent[];
  stream: PushStream<CoordinationEvent> | null;
  ended: boolean;
}

const inboxes = new Map<string, TaskInbox>();
let connected = false;

function inboxFor(taskId: string): TaskInbox {
  let inbox = inboxes.get(taskId);
  if (inbox === undefined) {
    inbox = { queue: [], stream: null, ended: false };
    inboxes.set(taskId, inbox);
  }
  return inbox;
}

/** Install the single `corp:event` subscription. Idempotent; call once at boot. */
export function connectCorp(): void {
  if (connected) return;
  connected = true;
  window.piDesktop.onEvent('corp:event', ({ taskId, event }) => {
    const inbox = inboxFor(taskId);
    if (inbox.stream !== null) {
      inbox.stream.push(event);
      if (event.type === 'done') {
        inbox.stream.end();
        inboxes.delete(taskId);
      }
    } else {
      inbox.queue.push(event);
      if (event.type === 'done') inbox.ended = true;
    }
  });
}

/** A live handle the situation room consumes (same shape as `TaskHandle`). */
export interface CorpTaskHandle {
  readonly taskId: string;
  readonly events: AsyncIterable<CoordinationEvent>;
}

/**
 * Start a coordination task in main and return a handle whose `events` replays any
 * buffered events then tails live ones to `done`. Wrap in `replayableEvents()`
 * before handing to the situation tab so a tab-switch remount rebuilds instantly.
 */
export async function startCorpTask(prompt: string, ctx?: TaskContext): Promise<CorpTaskHandle> {
  connectCorp();
  const { taskId } = await window.piDesktop.invoke('corp:start', {
    prompt,
    ...(ctx ? { ctx } : {}),
  });
  const inbox = inboxFor(taskId);
  const stream = new PushStream<CoordinationEvent>();
  // Flush anything that raced ahead of this response, then attach for live tail.
  for (const event of inbox.queue) stream.push(event);
  inbox.queue = [];
  if (inbox.ended) {
    stream.end();
    inboxes.delete(taskId);
  } else {
    inbox.stream = stream;
  }
  return { taskId, events: stream };
}

/** Stop a running corp task (its stream ends with an aborted `done`). */
export async function abortCorpTask(taskId: string): Promise<void> {
  await window.piDesktop.invoke('corp:abort', { taskId }).catch(() => undefined);
}

/** Mid-run steering to the lead. Fire-and-forget. */
export async function steerCorpTask(taskId: string, text: string): Promise<void> {
  await window.piDesktop.invoke('corp:steer', { taskId, text }).catch(() => undefined);
}

/** A follow-up question ANSWERED by the CEO from its retained context (A1/A4) — not a
 * new run. Returns the CEO's reply (an honest fallback line on any error). */
export async function askCorpTask(taskId: string, question: string): Promise<string> {
  return window.piDesktop
    .invoke('corp:ask', { taskId, question })
    .then((r) => r.answer)
    .catch(() => 'I hit a snag answering that — give me a moment and try again.');
}

/** Answer a surfaced permission request. */
export async function respondCorpPermission(
  taskId: string,
  requestId: string,
  granted: boolean,
): Promise<void> {
  await window.piDesktop
    .invoke('corp:respond-permission', { taskId, requestId, granted })
    .catch(() => undefined);
}

/** A synchronous-ish org-chart snapshot (situation-room bootstrap). */
export async function getCorpOrgChart(taskId: string): Promise<OrgChartView | null> {
  const res = await window.piDesktop
    .invoke('corp:get-org-chart', { taskId })
    .catch(() => ({ chart: null }));
  return res.chart;
}

/** The REAL captured turn stream for one node (the click-through), or null. */
export async function fetchWorkerTranscript(
  taskId: string,
  nodeId: string,
): Promise<WorkerTranscriptView | null> {
  const res = await window.piDesktop
    .invoke('corp:worker-transcript', { taskId, nodeId })
    .catch(() => ({ transcript: null }));
  return res.transcript;
}

/** "Peek at what we have so far" — a live snapshot of the in-progress product tree
 * (real files), or null when the task is unknown/ended. */
export async function peekCorpTask(taskId: string): Promise<ProductPeek | null> {
  const res = await window.piDesktop.invoke('corp:peek', { taskId }).catch(() => ({ peek: null }));
  return res.peek;
}
