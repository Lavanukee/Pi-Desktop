/**
 * SubagentScheduler — the memory-aware queue that bounds how many subagents run
 * at once. It enforces two limits derived from {@link ConcurrencyBudget}:
 *
 *  - a max concurrency count, and
 *  - a RAM budget: each task declares an estimated RAM cost and the running set
 *    may never exceed `ramBudgetGB`.
 *
 * Over-budget submissions QUEUE (they start when a slot + RAM free up) rather
 * than spawning blindly. A task whose estimate can NEVER fit (bigger than the
 * whole budget) is REJECTED immediately with a clear reason — it is never
 * spawned. The scheduler also owns the live record list and notifies a single
 * publisher on every change so the desktop can render live progress.
 *
 * Pure of any pi/os coupling: the actual child run is an injected async fn, so
 * this unit-tests deterministically (queue ordering, rejection, crash handling).
 */

import type { ConcurrencyBudget } from './budget.js';
import type { SubagentStatus, SubagentStatusItem } from './types.js';

/** A live scheduler record (superset of the wire item). */
export interface SubagentRecord {
  readonly id: string;
  readonly name: string;
  step?: string;
  status: SubagentStatus;
  readonly estRamGB: number;
  /** Ordered tool/step labels seen so far (the activity timeline). */
  readonly activity: string[];
  /** Full final output (summary) or error, set on completion. */
  output?: string;
}

/** Cap on the retained activity timeline per subagent (keep the newest). */
const MAX_ACTIVITY = 100;

/** Outcome the injected runner resolves with. */
export interface SubagentRunOutcome {
  readonly ok: boolean;
  /** The summary-only result (or an error message). */
  readonly summary: string;
  readonly error?: string;
}

/** The injected runner: drives one subagent, reporting steps as it goes. */
export type SubagentRunner = (ctx: {
  readonly id: string;
  readonly name: string;
  /** Push a live step label onto this subagent's record. */
  setStep(step: string): void;
}) => Promise<SubagentRunOutcome>;

export interface SubmitSpec {
  readonly id: string;
  readonly name: string;
  /** Estimated RAM cost (GiB); defaults to the budget's per-agent estimate. */
  readonly estRamGB?: number;
  readonly run: SubagentRunner;
}

/** What `submit` resolves with. `accepted:false` → never spawned (over budget). */
export type SubmitResult =
  | { readonly accepted: true; readonly outcome: SubagentRunOutcome }
  | { readonly accepted: false; readonly reason: string };

export interface SchedulerOptions {
  readonly budget: ConcurrencyBudget;
  /** Notified (with a fresh snapshot) on every record change. */
  readonly onChange?: (snapshot: SchedulerSnapshot) => void;
  /** Max finished records retained for display before the oldest are pruned. */
  readonly retainFinished?: number;
}

export interface SchedulerSnapshot {
  readonly items: readonly SubagentStatusItem[];
  readonly running: number;
  readonly queued: number;
  readonly maxConcurrency: number;
  readonly reason: string;
}

interface QueueEntry {
  readonly record: SubagentRecord;
  readonly run: SubagentRunner;
  readonly resolve: (r: SubmitResult) => void;
}

const DEFAULT_RETAIN_FINISHED = 12;

export class SubagentScheduler {
  readonly budget: ConcurrencyBudget;
  readonly #onChange?: (snapshot: SchedulerSnapshot) => void;
  readonly #retainFinished: number;
  /** Insertion-ordered records (queued + running + finished). */
  readonly #records: SubagentRecord[] = [];
  readonly #queue: QueueEntry[] = [];
  #running = 0;
  #usedRamGB = 0;

  constructor(opts: SchedulerOptions) {
    this.budget = opts.budget;
    this.#onChange = opts.onChange;
    this.#retainFinished = opts.retainFinished ?? DEFAULT_RETAIN_FINISHED;
  }

  /**
   * Submit a subagent. Resolves when it finishes (accepted) or immediately with
   * `accepted:false` when its RAM estimate can never fit the budget.
   */
  submit(spec: SubmitSpec): Promise<SubmitResult> {
    // Only a FINITE, POSITIVE estimate is honoured; 0/negative/NaN would poison
    // the shared `#usedRamGB` accounting (or bypass the budget entirely, since
    // `usedRamGB + 0 <= budget` is always true), so those fall back to the
    // per-agent default. `?? perAgentGB` alone let 0/negative through.
    const estRamGB =
      typeof spec.estRamGB === 'number' && Number.isFinite(spec.estRamGB) && spec.estRamGB > 0
        ? spec.estRamGB
        : this.budget.perAgentGB;
    // A task larger than the entire budget can never run — reject, don't queue
    // forever. (Guard the +0.001 float slop so an exact-fit estimate passes.)
    if (estRamGB > this.budget.ramBudgetGB + 1e-6) {
      return Promise.resolve({
        accepted: false,
        reason:
          `Subagent needs ~${estRamGB} GB but the memory budget is ` +
          `${this.budget.ramBudgetGB.toFixed(1)} GB (${this.budget.reason}). ` +
          'Reduce the task or run it in the main agent.',
      });
    }
    const record: SubagentRecord = {
      id: spec.id,
      name: spec.name,
      status: 'queued',
      step: 'Queued',
      estRamGB,
      activity: [],
    };
    this.#records.push(record);
    this.#emit();
    return new Promise<SubmitResult>((resolve) => {
      this.#queue.push({ record, run: spec.run, resolve });
      this.#pump();
    });
  }

  /** Current snapshot for external readers (e.g. the initial publish). */
  snapshot(): SchedulerSnapshot {
    return {
      items: this.#records.map((r) => ({
        id: r.id,
        name: r.name,
        status: r.status,
        ...(r.step !== undefined ? { step: r.step } : {}),
        ...(r.activity.length > 0 ? { activity: [...r.activity] } : {}),
        ...(r.output !== undefined ? { output: r.output } : {}),
      })),
      running: this.#running,
      queued: this.#queue.length,
      maxConcurrency: this.budget.maxConcurrency,
      reason: this.budget.reason,
    };
  }

  #emit(): void {
    this.#onChange?.(this.snapshot());
  }

  /** Start as many queued entries as the concurrency + RAM budget allows. */
  #pump(): void {
    for (;;) {
      const next = this.#queue[0];
      if (next === undefined) return;
      const withinCount = this.#running < this.budget.maxConcurrency;
      const withinRam = this.#usedRamGB + next.record.estRamGB <= this.budget.ramBudgetGB + 1e-6;
      if (!withinCount || !withinRam) return; // wait for a completion to free room
      this.#queue.shift();
      this.#start(next);
    }
  }

  #start(entry: QueueEntry): void {
    const { record, run, resolve } = entry;
    this.#running += 1;
    this.#usedRamGB += record.estRamGB;
    record.status = 'running';
    record.step = 'Starting…';
    this.#emit();

    const setStep = (step: string): void => {
      if (record.status !== 'running') return;
      record.step = step;
      // Append to the activity timeline, skipping a consecutive duplicate (a tool
      // fires both toolcall_start + tool_execution_start with the same name).
      if (record.activity[record.activity.length - 1] !== step) {
        record.activity.push(step);
        if (record.activity.length > MAX_ACTIVITY) record.activity.shift();
      }
      this.#emit();
    };

    const done = (outcome: SubagentRunOutcome): void => {
      record.status = outcome.ok ? 'done' : 'error';
      record.output = outcome.ok ? outcome.summary : (outcome.error ?? outcome.summary);
      record.step = outcome.ok
        ? firstLine(outcome.summary) || 'Done'
        : `Failed: ${firstLine(outcome.error ?? outcome.summary) || 'error'}`;
      this.#running -= 1;
      this.#usedRamGB -= record.estRamGB;
      this.#prune();
      this.#emit();
      resolve({ accepted: true, outcome });
      this.#pump();
    };

    // Start the runner synchronously (so a freed slot is claimed at once), but
    // guard against a synchronous throw so a misbehaving runner can't wedge the
    // queue. The injected runner is promised to never reject (child-agent
    // resolves its own failures); the catch is belt-and-braces.
    let outcome: Promise<SubagentRunOutcome>;
    try {
      outcome = Promise.resolve(run({ id: record.id, name: record.name, setStep }));
    } catch (err) {
      outcome = Promise.resolve({
        ok: false,
        summary: '',
        error: err instanceof Error ? err.message : String(err),
      });
    }
    void outcome
      .then(done)
      .catch((err: unknown) =>
        done({ ok: false, summary: '', error: err instanceof Error ? err.message : String(err) }),
      );
  }

  /** Drop the oldest FINISHED records past the retention cap (keep active ones). */
  #prune(): void {
    const finished = this.#records.filter((r) => r.status === 'done' || r.status === 'error');
    const excess = finished.length - this.#retainFinished;
    if (excess <= 0) return;
    let removed = 0;
    for (let i = 0; i < this.#records.length && removed < excess; ) {
      const r = this.#records[i];
      if (r !== undefined && (r.status === 'done' || r.status === 'error')) {
        this.#records.splice(i, 1);
        removed += 1;
      } else {
        i += 1;
      }
    }
  }
}

/** First non-empty line of a string, trimmed (for a compact step label). */
function firstLine(s: string): string {
  for (const line of s.split('\n')) {
    const t = line.trim();
    if (t.length > 0) return t.length > 80 ? `${t.slice(0, 77)}…` : t;
  }
  return '';
}
