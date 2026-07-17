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
  /** Hard cap on wall-clock milliseconds. Default {@link DEFAULT_MAX_WALL_CLOCK_MS}.
   * Non-finite/≤0 falls back to the default. */
  readonly maxWallClockMs?: number;
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
  /** Hard cap on wall-clock milliseconds from {@link startedAt}. */
  readonly maxWallClockMs: number;
  /** Epoch ms the budget was created (the run's start), from {@link now}. */
  readonly startedAt: number;
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

/** The default wall-clock cap: 90 minutes. Generous enough that a normal run never
 * hits it locally, tight enough that a runaway cascade (even one that keeps the
 * turn count technically legal) cannot run "for a year". */
export const DEFAULT_MAX_WALL_CLOCK_MS = 90 * 60 * 1000;

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
  const maxWallClockMs =
    options.maxWallClockMs !== undefined &&
    Number.isFinite(options.maxWallClockMs) &&
    options.maxWallClockMs > 0
      ? options.maxWallClockMs
      : DEFAULT_MAX_WALL_CLOCK_MS;
  return { maxTurns, maxWallClockMs, startedAt: now(), turnsUsed: 0, now };
}

/** Which cap a budget has hit, or `undefined` if it still has room. */
export type BudgetExceededReason = 'turns' | 'wall-clock';

/**
 * The reason a budget is exhausted — `turns` (the turn cap is reached) or
 * `wall-clock` (the time cap is reached) — or `undefined` when it still has room.
 * Turns are checked first so an over-turn run reports `turns` even at the wall.
 * Pure (reads the injected clock).
 */
export function budgetExceededReason(budget: RunBudget): BudgetExceededReason | undefined {
  if (budget.turnsUsed >= budget.maxTurns) return 'turns';
  if (budget.now() - budget.startedAt >= budget.maxWallClockMs) return 'wall-clock';
  return undefined;
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
