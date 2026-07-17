/**
 * Bounded CEO REVISE loop (spec §8 review, §9 "never an unbounded churn").
 *
 * When the CEO's final sign-off (ceo.ts) returns REVISE, its notes route back down
 * to re-work the specifically-flagged gaps — re-dispatch the relevant contracts
 * addressing the notes, then re-review. That is a LOOP, and a loop is exactly what
 * "no run takes a year" forbids leaving unbounded: a CEO that is never satisfied (a
 * 4B's product may genuinely never be "perfect") would churn forever.
 *
 * This module makes that loop BOUNDED. It runs at most `maxRevisions` (default 1)
 * revision cycles, and only while the current decision is still `revise`. After the
 * cap, it ACCEPTS THE HONEST FINAL STATE — the last CEO decision + notes stand as
 * the delivered outcome. It never loops trying to reach "perfect". An optional
 * {@link RunBudget} is the outer net: if the global budget is exhausted the loop
 * stops immediately, deferring to the run's graceful termination.
 *
 * Pure control-flow around an injected {@link ReviseCycleParams.runRevision} seam
 * (the actual re-work + re-review turn) — no model, no I/O — so it is unit-testable
 * with a mock and reused by the orchestrator (run.ts).
 */

import { budgetExceeded, type RunBudget } from './budget.js';
import type { CeoDecision } from './ceo.js';

/** Default number of revision cycles: one. A single focused re-work pass, then the
 * honest final state stands (spec §8 — do not chase "perfect"). */
export const DEFAULT_MAX_REVISIONS = 1;

/** The input handed to one revision cycle. */
export interface ReviseRoundInput {
  /** 1-based cycle index (1 = the first revision). */
  readonly round: number;
  /** The CEO's notes to address this cycle (from the previous decision), if any. */
  readonly notes?: string;
  /** The decision that triggered this cycle (always `revise`). */
  readonly previousDecision: CeoDecision;
}

/** What one revision cycle did. */
export interface ReviseRound {
  readonly round: number;
  /** The notes this cycle was asked to address. */
  readonly notes?: string;
  /** The CEO decision AFTER the cycle's re-work + re-review. */
  readonly decision: CeoDecision;
}

/** Inputs to {@link runBoundedRevise}. */
export interface ReviseCycleParams {
  /** The CEO's first decision (from the initial final review). */
  readonly initialDecision: CeoDecision;
  /** Cap on revision cycles; default {@link DEFAULT_MAX_REVISIONS}. Clamped to ≥0
   * (0 = accept the initial decision with no revision). Non-finite ⇒ default. */
  readonly maxRevisions?: number;
  /** Optional global backstop: when exhausted, the loop stops immediately (the run
   * is terminating). The cap already bounds the loop; this is the outer net. */
  readonly budget?: RunBudget;
  /**
   * Perform ONE revision cycle: re-work the flagged contracts addressing `notes`,
   * re-review, and return the NEW CEO decision. Called at most `maxRevisions`
   * times, only while the current decision is `revise`. Sync or async. The
   * orchestrator wires the actual re-dispatch + re-review here; a test passes a
   * mock (e.g. a CEO that always revises).
   */
  readonly runRevision: (input: ReviseRoundInput) => Promise<CeoDecision> | CeoDecision;
}

/** The outcome of the bounded revise loop — the honest final state. */
export interface ReviseOutcome {
  /** The delivered decision: an `approve` if one was reached, else the last
   * `revise` (the honest "this is as far as we got" outcome). */
  readonly finalDecision: CeoDecision;
  /** How many revision cycles actually ran (0..maxRevisions). */
  readonly revisionsRun: number;
  /** True iff {@link finalDecision} is `approve`. */
  readonly approved: boolean;
  /** True when the loop stopped because it reached `maxRevisions` while the CEO was
   * still revising — the accepted-honest-final-state case (a never-satisfied CEO
   * terminates here). */
  readonly hitCap: boolean;
  /** True when the loop stopped early because the run {@link RunBudget} was
   * exhausted (the global net fired before the revision cap). */
  readonly stoppedForBudget: boolean;
  /** Per-cycle record, in order. */
  readonly rounds: readonly ReviseRound[];
}

/** Clamp `maxRevisions` to a non-negative integer; default {@link DEFAULT_MAX_REVISIONS}. */
export function normalizeMaxRevisions(maxRevisions: number | undefined): number {
  if (maxRevisions === undefined || !Number.isFinite(maxRevisions)) return DEFAULT_MAX_REVISIONS;
  return Math.max(0, Math.floor(maxRevisions));
}

/**
 * Run the BOUNDED CEO revise loop. Starting from {@link ReviseCycleParams.initialDecision},
 * while the current decision is `revise` and fewer than `maxRevisions` cycles have
 * run (and the optional budget has room), invoke `runRevision` with the current
 * notes and take its new decision. Stops the instant the CEO approves, the cap is
 * reached, or the budget is exhausted — never loops chasing "perfect". Returns the
 * honest {@link ReviseOutcome}. Never throws on its own (a throwing `runRevision`
 * propagates to the caller, which the orchestrator wraps).
 */
export async function runBoundedRevise(params: ReviseCycleParams): Promise<ReviseOutcome> {
  const maxRevisions = normalizeMaxRevisions(params.maxRevisions);
  const rounds: ReviseRound[] = [];
  let decision = params.initialDecision;
  let revisionsRun = 0;
  let stoppedForBudget = false;

  while (decision.decision === 'revise' && revisionsRun < maxRevisions) {
    // The outer net: if the global run budget is spent, stop now and let the run
    // terminate on the honest current state (the revision cap alone would also
    // stop us — this just stops us sooner when the whole run is out of budget).
    if (params.budget !== undefined && budgetExceeded(params.budget)) {
      stoppedForBudget = true;
      break;
    }
    const round = revisionsRun + 1;
    const notes = decision.notes;
    const next = await params.runRevision({ round, notes, previousDecision: decision });
    revisionsRun += 1;
    rounds.push(notes === undefined ? { round, decision: next } : { round, notes, decision: next });
    decision = next;
  }

  const approved = decision.decision === 'approve';
  return {
    finalDecision: decision,
    revisionsRun,
    approved,
    hitCap: !approved && !stoppedForBudget && revisionsRun >= maxRevisions,
    stoppedForBudget,
    rounds,
  };
}
