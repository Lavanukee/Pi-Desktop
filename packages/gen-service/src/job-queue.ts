/**
 * JobQueue — the supervised, unified-memory-budget-aware scheduler that the
 * Electron gen manager drives. It runs generation jobs parallel-or-queued:
 *
 *   - Light jobs (small image models) run up to `maxConcurrent` at once.
 *   - A HEAVY job (e.g. Qwen-Image ~24GB) runs EXCLUSIVELY — it waits for all
 *     running jobs to drain, then runs alone, and blocks new starts until it
 *     finishes. This is the "one heavy model at a time" unified-memory rule.
 *
 * FIFO within those constraints. Cancel works whether a job is still queued or
 * already running (running jobs are aborted via their AbortController → the
 * runner SIGKILLs the worker).
 *
 * The job RUNNER is injected so the queue unit-tests with a fake runner (no uv /
 * Python); production passes {@link GenServiceClient.run}.
 */
import { GenServiceClient } from './client.js';
import type { GenEvent, GenJob, GenOutput } from './protocol.js';

export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'canceled';

/** Runs a single job to completion. Rejects on error/abort. */
export type JobRunner = (
  job: GenJob,
  opts: {
    onEvent?: (event: GenEvent) => void;
    signal?: AbortSignal;
    extraWith?: readonly string[];
  },
) => Promise<GenOutput[]>;

export type JobQueueListener = (event: JobQueueEvent) => void;

/** Queue-level observability (distinct from per-job worker {@link GenEvent}s). */
export type JobQueueEvent =
  | { readonly type: 'status'; readonly jobId: string; readonly status: JobStatus }
  | { readonly type: 'event'; readonly jobId: string; readonly event: GenEvent };

export interface EnqueueOptions {
  /** Serialize this job exclusively (unified-memory budget). From catalog `heavy`. */
  readonly heavy?: boolean;
  /** Extra `uv --with` deps for the backend. */
  readonly extraWith?: readonly string[];
  /** Per-job worker event stream (progress/candidate/…). */
  readonly onEvent?: (event: GenEvent) => void;
}

export interface JobHandle {
  readonly id: string;
  /** Resolves with outputs on success; rejects on error/cancel. */
  readonly result: Promise<GenOutput[]>;
}

interface Entry {
  readonly job: GenJob;
  readonly heavy: boolean;
  readonly extraWith?: readonly string[];
  readonly onEvent?: (event: GenEvent) => void;
  readonly controller: AbortController;
  status: JobStatus;
  resolve(outputs: GenOutput[]): void;
  reject(err: Error): void;
}

export interface JobQueueOptions {
  /** Max simultaneous LIGHT jobs (default 2). Heavy jobs always run alone. */
  readonly maxConcurrent?: number;
  /** The runner (default = a {@link GenServiceClient}). */
  readonly runner?: JobRunner;
}

export class JobQueue {
  readonly #maxConcurrent: number;
  readonly #runner: JobRunner;
  readonly #listeners = new Set<JobQueueListener>();
  readonly #queue: Entry[] = [];
  readonly #entries = new Map<string, Entry>();
  readonly #running = new Set<string>();
  #runningHeavy = false;

  constructor(opts: JobQueueOptions = {}) {
    this.#maxConcurrent = Math.max(1, opts.maxConcurrent ?? 2);
    this.#runner = opts.runner ?? ((job, o) => new GenServiceClient().run(job, o));
  }

  on(listener: JobQueueListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(event: JobQueueEvent): void {
    for (const l of this.#listeners) {
      try {
        l(event);
      } catch {
        // a listener throwing must never wedge the queue
      }
    }
  }

  #setStatus(entry: Entry, status: JobStatus): void {
    entry.status = status;
    this.#emit({ type: 'status', jobId: entry.job.id, status });
  }

  /** Current status of a job, or undefined if unknown. */
  statusOf(jobId: string): JobStatus | undefined {
    return this.#entries.get(jobId)?.status;
  }

  /** Number of jobs currently running. */
  get runningCount(): number {
    return this.#running.size;
  }

  /** Number of jobs waiting to start. */
  get queuedCount(): number {
    return this.#queue.length;
  }

  /** Enqueue a job. Returns a handle whose `result` settles on completion. */
  enqueue(job: GenJob, options: EnqueueOptions = {}): JobHandle {
    if (this.#entries.has(job.id)) {
      throw new Error(`job id already in queue: ${job.id}`);
    }
    let resolveFn!: (outputs: GenOutput[]) => void;
    let rejectFn!: (err: Error) => void;
    const result = new Promise<GenOutput[]>((res, rej) => {
      resolveFn = res;
      rejectFn = rej;
    });
    const entry: Entry = {
      job,
      heavy: options.heavy === true,
      extraWith: options.extraWith,
      onEvent: options.onEvent,
      controller: new AbortController(),
      status: 'queued',
      resolve: resolveFn,
      reject: rejectFn,
    };
    this.#entries.set(job.id, entry);
    this.#queue.push(entry);
    this.#emit({ type: 'status', jobId: job.id, status: 'queued' });
    this.#pump();
    return { id: job.id, result };
  }

  /** Cancel a queued or running job. No-op for unknown / already-settled jobs. */
  cancel(jobId: string): boolean {
    const entry = this.#entries.get(jobId);
    if (entry === undefined) return false;
    if (entry.status === 'queued') {
      const idx = this.#queue.indexOf(entry);
      if (idx !== -1) this.#queue.splice(idx, 1);
      this.#setStatus(entry, 'canceled');
      entry.reject(new Error('generation canceled'));
      this.#entries.delete(jobId);
      return true;
    }
    if (entry.status === 'running') {
      // Abort → the runner SIGKILLs the worker → its promise rejects, which
      // #finish() maps to 'canceled'.
      entry.controller.abort();
      return true;
    }
    return false;
  }

  /** Whether the entry at the head can start given the memory-budget rule. */
  #canStart(entry: Entry): boolean {
    if (this.#runningHeavy) return false; // a heavy job owns the machine
    if (entry.heavy) return this.#running.size === 0; // heavy needs an empty machine
    return this.#running.size < this.#maxConcurrent;
  }

  #pump(): void {
    // Start as many head-of-queue jobs as the constraints allow. We only ever
    // consider the FRONT of the queue so ordering stays FIFO and a heavy job
    // can't be perpetually skipped by lighter jobs queued behind it.
    while (this.#queue.length > 0) {
      const next = this.#queue[0];
      if (next === undefined) break;
      if (!this.#canStart(next)) break;
      this.#queue.shift();
      this.#start(next);
    }
  }

  #start(entry: Entry): void {
    this.#running.add(entry.job.id);
    if (entry.heavy) this.#runningHeavy = true;
    this.#setStatus(entry, 'running');

    this.#runner(entry.job, {
      signal: entry.controller.signal,
      extraWith: entry.extraWith,
      onEvent: (event) => {
        entry.onEvent?.(event);
        this.#emit({ type: 'event', jobId: entry.job.id, event });
      },
    }).then(
      (outputs) => this.#finish(entry, { ok: true, outputs }),
      (err: Error) => this.#finish(entry, { ok: false, err }),
    );
  }

  #finish(
    entry: Entry,
    result: { ok: true; outputs: GenOutput[] } | { ok: false; err: Error },
  ): void {
    this.#running.delete(entry.job.id);
    if (entry.heavy) this.#runningHeavy = false;
    if (result.ok) {
      this.#setStatus(entry, 'done');
      entry.resolve(result.outputs);
    } else if (entry.controller.signal.aborted) {
      this.#setStatus(entry, 'canceled');
      entry.reject(new Error('generation canceled'));
    } else {
      this.#setStatus(entry, 'error');
      entry.reject(result.err);
    }
    this.#entries.delete(entry.job.id);
    this.#pump();
  }
}
