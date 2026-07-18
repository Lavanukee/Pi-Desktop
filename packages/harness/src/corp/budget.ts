/**
 * Global RUN BUDGET — the "no run takes a year" safety net (spec §0.6 "robustness
 * is external", §9 failure/control/safety).
 *
 * The corp flow is mostly bounded already: a model turn is a single call capped by
 * `max_tokens`; retry-on-empty (retry.ts) is bounded to one; escalation
 * (escalate.ts) is bounded to one; dispatch (dispatch.ts) is a finite DAG walk.
 * What none of those bound is the WHOLE run: a pathological cascade (a manager that
 * keeps re-scoping, a CEO that always revises, a config that re-enters a stage)
 * could, in aggregate, run far longer than any single guard imagines. This module
 * is the LAST net under all of them — a global cap on both the number of model
 * turns AND the wall-clock time a run may consume, so that however the pieces
 * compose, the run terminates.
 *
 * It is a pure, mutable accumulator with an injected clock seam (so wall-clock
 * termination is unit-testable without real time):
 *  - {@link newRunBudget} mints a budget (sensible defaults; overridable).
 *  - {@link chargeTurn} is called immediately BEFORE every model turn — it charges
 *    the turn and returns whether the turn is permitted (there was budget). A
 *    `false` return is the driver's signal to STOP starting new turns and
 *    terminate gracefully.
 *  - {@link budgetExceeded} / {@link budgetExceededReason} report the current state
 *    without charging (turns OR wall-clock).
 *  - {@link defaultMaxTurns} / {@link fitBudgetToPlan} scale the cap to the plan
 *    once it is known (a big legitimate plan gets more turns; a runaway still hits
 *    the wall-clock net regardless).
 *
 * No I/O, no model, no `node:*` — it is threaded through the driver/orchestrator
 * (run.ts), which owns the actual turns.
 */

/** Options for {@link newRunBudget}. All optional — sensible defaults apply. */
export interface RunBudgetOptions {
  /** Hard cap on model turns. Default {@link MAX_TURNS_FLOOR}; raise per plan via
   * {@link fitBudgetToPlan}. Non-finite/≤0 falls back to the floor. */
  readonly maxTurns?: number;
  /** ABSOLUTE hard cap on wall-clock milliseconds — DISABLED by default. Pass a
   * positive finite value ONLY to impose a hard ceiling (e.g. a snappy low-effort
   * mode); omit / non-finite / ≤0 leaves it OFF (no absolute truncation), so a
   * max-effort run is bounded by the turn cap + the {@link stallWindowMs} watchdog,
   * not an arbitrary clock. */
  readonly maxWallClockMs?: number;
  /** No-progress WATCHDOG window in ms. Default {@link DEFAULT_STALL_WINDOW_MS}.
   * The run terminates if {@link markProgress} has not been called for this long.
   * Non-finite/≤0 DISABLES the watchdog (rely on the turn cap alone). */
  readonly stallWindowMs?: number;
  /** Clock seam (ms epoch). Injected in tests so wall-clock termination is
   * deterministic; defaults to {@link Date.now}. */
  readonly now?: () => number;
}

/**
 * A live run budget. A MUTABLE accumulator on purpose — {@link chargeTurn}
 * increments {@link turnsUsed} and {@link fitBudgetToPlan} may raise
 * {@link maxTurns} as the plan is discovered. The caps and the clock are otherwise
 * fixed for the run.
 */
export interface RunBudget {
  /** Hard cap on model turns (may be raised by {@link fitBudgetToPlan}, never lowered). */
  maxTurns: number;
  /** ABSOLUTE hard cap on wall-clock ms from {@link startedAt}. `Infinity` = disabled
   * (the default) — the run is bounded by the turn cap + the {@link stallWindowMs}
   * watchdog instead of an arbitrary clock. */
  readonly maxWallClockMs: number;
  /** No-progress watchdog window in ms. `Infinity` = disabled. The run terminates if
   * {@link now}`() - `{@link lastProgressAt} reaches this. */
  readonly stallWindowMs: number;
  /** Epoch ms the budget was created (the run's start), from {@link now}. */
  readonly startedAt: number;
  /** Epoch ms of the last forward progress ({@link markProgress}); starts at
   * {@link startedAt}. Reset whenever a builder writes a file or a stage turn lands. */
  lastProgressAt: number;
  /** How many model turns have been charged so far. */
  turnsUsed: number;
  /** Clock seam (ms epoch) — the same one used for {@link startedAt}. */
  readonly now: () => number;
}

/**
 * The floor for a run's turn cap: enough for a normal small run's whole flow
 * (worker + architect + a handful of managers + their engineers' draft/review
 * turns + the CEO sign-off + a bounded revision) so a NORMAL run never hits it,
 * while a pathological cascade blows past it. {@link fitBudgetToPlan} raises it for
 * larger plans.
 */
export const MAX_TURNS_FLOOR = 24;

/**
 * A wall-clock value that a caller may pass as an ABSOLUTE hard ceiling. It is NOT
 * the default any more: an absolute time cap only ever truncates legitimate long
 * work (the "max effort" run that genuinely needs the time), and the run is already
 * bounded without it — the plan-scaled TURN cap ({@link fitBudgetToPlan}) times a
 * per-call network abort makes even a misbehaving model terminate. So the absolute
 * cap defaults to DISABLED (see {@link newRunBudget}); this constant is kept for the
 * odd caller (a snappier low-effort mode) that wants a hard ceiling, and for tests.
 */
export const DEFAULT_MAX_WALL_CLOCK_MS = 90 * 60 * 1000;

/**
 * The no-progress WATCHDOG window: 30 minutes. This is the honest replacement for
 * the old absolute cap. Instead of "stop the run at T minutes however it is going",
 * the watchdog stops it only when it has made NO FORWARD PROGRESS — no file written
 * by a builder, no stage turn completed — for this long. A run that is genuinely
 * grinding forward (max effort on a big job) is never truncated; a run that is
 * actually stuck (a hung seam that slipped its own per-call abort) still terminates.
 * Generous enough that a slow-but-advancing sequential build never false-positives.
 */
export const DEFAULT_STALL_WINDOW_MS = 30 * 60 * 1000;

/** Turns budgeted per plan "unit" (a contract or a division). ~3 covers a
 * contract's draft + self-review + an occasional retry-on-empty, and a division's
 * manager turn plus slack. Tuned so a normal run stays well under the cap. */
export const TURNS_PER_UNIT = 3;

/** A non-negative integer, or `0` for anything non-finite/negative. */
function nonNegInt(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * The recommended turn cap for a plan of `contractCount` contracts across
 * `divisionCount` divisions: `max(FLOOR, TURNS_PER_UNIT × (contracts + divisions))`.
 * Scales the backstop to the real size of the work while never dropping below the
 * floor. Pure.
 */
export function defaultMaxTurns(plan: {
  readonly contractCount: number;
  readonly divisionCount: number;
}): number {
  const units = nonNegInt(plan.contractCount) + nonNegInt(plan.divisionCount);
  return Math.max(MAX_TURNS_FLOOR, TURNS_PER_UNIT * units);
}

/**
 * Mint a fresh {@link RunBudget}. `maxTurns` defaults to {@link MAX_TURNS_FLOOR}
 * (raise it once the plan size is known via {@link fitBudgetToPlan}, or pass an
 * explicit value from {@link defaultMaxTurns}); `maxWallClockMs` defaults to
 * {@link DEFAULT_MAX_WALL_CLOCK_MS}. `startedAt` is stamped from the injected clock.
 */
export function newRunBudget(options: RunBudgetOptions = {}): RunBudget {
  const now = options.now ?? Date.now;
  const maxTurns =
    options.maxTurns !== undefined && Number.isFinite(options.maxTurns) && options.maxTurns > 0
      ? Math.floor(options.maxTurns)
      : MAX_TURNS_FLOOR;
  // ABSOLUTE cap: OFF by default. Only an explicit positive finite value enables it;
  // omit / non-finite / ≤0 leaves it disabled (Infinity) — no arbitrary truncation.
  const maxWallClockMs =
    options.maxWallClockMs !== undefined &&
    Number.isFinite(options.maxWallClockMs) &&
    options.maxWallClockMs > 0
      ? options.maxWallClockMs
      : Number.POSITIVE_INFINITY;
  // Watchdog: ON by default (DEFAULT_STALL_WINDOW_MS); an explicit ≤0/non-finite
  // value disables it (Infinity), leaving the turn cap as the sole net.
  const stallWindowMs =
    options.stallWindowMs === undefined
      ? DEFAULT_STALL_WINDOW_MS
      : Number.isFinite(options.stallWindowMs) && options.stallWindowMs > 0
        ? options.stallWindowMs
        : Number.POSITIVE_INFINITY;
  const startedAt = now();
  return {
    maxTurns,
    maxWallClockMs,
    stallWindowMs,
    startedAt,
    lastProgressAt: startedAt,
    turnsUsed: 0,
    now,
  };
}

/** Which net a budget has hit, or `undefined` if it still has room. */
export type BudgetExceededReason = 'turns' | 'stalled' | 'wall-clock';

/**
 * The reason a budget is exhausted, or `undefined` when it still has room:
 *  - `turns` — the plan-scaled turn cap is reached (the primary finite net).
 *  - `stalled` — no {@link markProgress} for {@link RunBudget.stallWindowMs} (the
 *    no-progress watchdog: the run is stuck, not advancing).
 *  - `wall-clock` — the ABSOLUTE ceiling is reached (disabled unless a caller opts
 *    in, so this normally never fires).
 * Turns are checked first (an over-turn run reports `turns`), then the watchdog,
 * then the absolute ceiling. Pure (reads the injected clock).
 */
export function budgetExceededReason(budget: RunBudget): BudgetExceededReason | undefined {
  if (budget.turnsUsed >= budget.maxTurns) return 'turns';
  const elapsedSinceProgress = budget.now() - budget.lastProgressAt;
  if (elapsedSinceProgress >= budget.stallWindowMs) return 'stalled';
  if (budget.now() - budget.startedAt >= budget.maxWallClockMs) return 'wall-clock';
  return undefined;
}

/**
 * Record FORWARD PROGRESS — resets the no-progress watchdog. Call this whenever the
 * run genuinely advances the work: a builder writes a file, a stage turn completes.
 * A run that keeps calling this is, by definition, not stuck, and the watchdog never
 * fires it; a run that stops calling it for {@link RunBudget.stallWindowMs} is stuck
 * and terminates. Mutates {@link RunBudget.lastProgressAt}.
 */
export function markProgress(budget: RunBudget): void {
  budget.lastProgressAt = budget.now();
}

/** True when the budget is exhausted on EITHER cap (turns or wall-clock). Reads,
 * never charges — safe to poll at a stage boundary. */
export function budgetExceeded(budget: RunBudget): boolean {
  return budgetExceededReason(budget) !== undefined;
}

/**
 * Charge one model turn against the budget. Call this IMMEDIATELY BEFORE every
 * model turn. Returns `true` when the turn is permitted — there was budget, and the
 * turn is now counted; `false` when the budget was already exhausted (turns OR
 * wall-clock), in which case NOTHING is charged and the caller must stop starting
 * new turns. Exactly `maxTurns` turns can be charged before it starts returning
 * `false`; this is what makes an endless-looped model terminate.
 */
export function chargeTurn(budget: RunBudget): boolean {
  if (budgetExceeded(budget)) return false;
  budget.turnsUsed += 1;
  return true;
}

/**
 * Raise a budget's turn cap to fit a now-known plan: `maxTurns` becomes at least
 * {@link defaultMaxTurns}`(plan)`, never lowered (early turns already spent still
 * count, and the cap only grows to accommodate a bigger plan). The wall-clock cap
 * is untouched — it is the hard net that no plan size can widen, so even a plan
 * that inflates the turn cap cannot make the run take "a year". Mutates and
 * returns `budget`.
 */
export function fitBudgetToPlan(
  budget: RunBudget,
  plan: { readonly contractCount: number; readonly divisionCount: number },
): RunBudget {
  const target = defaultMaxTurns(plan);
  if (target > budget.maxTurns) budget.maxTurns = target;
  return budget;
}
