/**
 * Retry-on-empty guard (spec §0.6 "robustness is external") — a general wrapper
 * for the role turns that can silently produce NOTHING.
 *
 * Real-qwen slice-4 findings this backstops:
 *  - a manager turn that parsed 0 contracts made a WHOLE division vanish from the
 *    plan with no signal; and
 *  - an engineer turn CAN emit empty/whitespace-only content (a runaway think that
 *    starves the file body), which would otherwise be written to disk as an empty
 *    file for the contract's slot.
 *
 * Both are the same shape: run a generation turn, and if its parsed result is
 * "empty" by a caller-supplied predicate, RETRY it ONCE — the caller varies the
 * retry however it needs (a manager appends a "you must output at least a few
 * contracts" nudge; an engineer re-runs with thinking OFF). If the single retry is
 * ALSO empty, that is RECORDED ({@link RetryOnEmptyResult.emptyAfterRetry}) so the
 * driver can surface a division as `emptyAfterRetry` or mark a contract FAILED —
 * never silently drop it. Exactly ONE retry: robustness is a backstop, not an
 * unbounded loop.
 *
 * Pure control-flow around an injected `run` seam — no model, no I/O of its own —
 * so it is unit-testable with a mock `run` and reusable for BOTH role turns.
 */

/** The turn being attempted: `attempt` is 1 on the first try, 2 on the single
 * retry; `isRetry` is the same signal as a boolean for the common branch. The
 * caller reads these to vary the retry (append a nudge, flip thinking off). */
export interface RetryTurn {
  /** 1 on the first turn, 2 on the single retry. */
  readonly attempt: number;
  /** True only on the retry turn (`attempt === 2`). */
  readonly isRetry: boolean;
}

/** Inputs to {@link withRetryOnEmpty}. */
export interface RetryOnEmptyParams<T> {
  /** Perform one turn and return its parsed result. Called once, or twice when
   * the first result is empty. Sync or async. */
  readonly run: (turn: RetryTurn) => Promise<T> | T;
  /** Whether a produced value counts as EMPTY (⇒ triggers the retry / a recorded
   * failure). E.g. `(c) => c.length === 0` for contracts, `(s) => s.trim() === ''`
   * for a file body. */
  readonly isEmpty: (value: T) => boolean;
}

/** Outcome of {@link withRetryOnEmpty}. */
export interface RetryOnEmptyResult<T> {
  /** The final produced value — the retry's result when the first was empty, else
   * the first result. May STILL be empty (see {@link emptyAfterRetry}). */
  readonly value: T;
  /** How many turns ran: 1 (first try succeeded) or 2 (one retry). */
  readonly attempts: number;
  /** True when the first turn was empty and a retry was run (regardless of the
   * retry's outcome). */
  readonly retried: boolean;
  /** True when BOTH the first turn AND the retry produced an empty value — the
   * caller must record this (division `emptyAfterRetry` / contract FAILED), never
   * silently drop the work. */
  readonly emptyAfterRetry: boolean;
}

/**
 * Run a generation turn with a single retry-on-empty guard. Runs `run` once; if
 * its result is {@link RetryOnEmptyParams.isEmpty | empty}, runs it exactly ONCE
 * more (the caller varies that retry via {@link RetryTurn}). Returns the final
 * value plus the flags a driver needs to REPORT an empty-after-retry outcome
 * instead of silently losing the work. Never loops beyond the one retry.
 */
export async function withRetryOnEmpty<T>(
  params: RetryOnEmptyParams<T>,
): Promise<RetryOnEmptyResult<T>> {
  const first = await params.run({ attempt: 1, isRetry: false });
  if (!params.isEmpty(first)) {
    return { value: first, attempts: 1, retried: false, emptyAfterRetry: false };
  }
  const second = await params.run({ attempt: 2, isRetry: true });
  return {
    value: second,
    attempts: 2,
    retried: true,
    emptyAfterRetry: params.isEmpty(second),
  };
}

/** A produced file body is empty when it is not a non-blank string — the engineer
 * retry-on-empty predicate (a whitespace-only reply must not be written to disk). */
export function isBlankFile(value: unknown): boolean {
  return typeof value !== 'string' || value.trim() === '';
}

/** The light nudge appended to a manager's RETRY turn when its first turn parsed
 * zero contracts: reusable so the drivers share one wording. */
export const MANAGER_EMPTY_RETRY_NUDGE =
  'You must output at least a few contracts; do not return an empty list. Output the JSON array of contracts now, and close the array.';
