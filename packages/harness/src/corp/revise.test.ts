import { describe, expect, it, vi } from 'vitest';
import { newRunBudget } from './budget.js';
import type { CeoDecision } from './ceo.js';
import {
  DEFAULT_MAX_REVISIONS,
  normalizeMaxRevisions,
  type ReviseRoundInput,
  runBoundedRevise,
} from './revise.js';

const revise = (notes?: string): CeoDecision =>
  notes === undefined ? { decision: 'revise' } : { decision: 'revise', notes };
const approve: CeoDecision = { decision: 'approve' };

describe('normalizeMaxRevisions', () => {
  it('defaults to one and clamps to a non-negative integer', () => {
    expect(normalizeMaxRevisions(undefined)).toBe(DEFAULT_MAX_REVISIONS);
    expect(normalizeMaxRevisions(Number.NaN)).toBe(DEFAULT_MAX_REVISIONS);
    expect(normalizeMaxRevisions(-4)).toBe(0);
    expect(normalizeMaxRevisions(3.9)).toBe(3);
  });
});

describe('runBoundedRevise', () => {
  it('does not revise when the CEO already approved', async () => {
    const runRevision = vi.fn();
    const outcome = await runBoundedRevise({ initialDecision: approve, runRevision });
    expect(runRevision).not.toHaveBeenCalled();
    expect(outcome.revisionsRun).toBe(0);
    expect(outcome.approved).toBe(true);
    expect(outcome.hitCap).toBe(false);
    expect(outcome.finalDecision).toEqual(approve);
  });

  it('runs one cycle and stops when the revision produces an approval', async () => {
    const runRevision = vi.fn(async () => approve);
    const outcome = await runBoundedRevise({
      initialDecision: revise('fix the UI'),
      runRevision,
    });
    expect(runRevision).toHaveBeenCalledTimes(1);
    expect(outcome.revisionsRun).toBe(1);
    expect(outcome.approved).toBe(true);
    expect(outcome.hitCap).toBe(false);
  });

  it('a CEO that ALWAYS revises terminates at the cap with the honest final state', async () => {
    // The headline bound: an unsatisfiable CEO must stop, not churn forever.
    const runRevision = vi.fn(async (input: ReviseRoundInput) =>
      revise(`still wrong @${input.round}`),
    );
    const outcome = await runBoundedRevise({
      initialDecision: revise('start'),
      maxRevisions: 1,
      runRevision,
    });
    expect(runRevision).toHaveBeenCalledTimes(1); // exactly maxRevisions
    expect(outcome.revisionsRun).toBe(1);
    expect(outcome.approved).toBe(false);
    expect(outcome.hitCap).toBe(true);
    // The last CEO verdict + notes stand as the delivered outcome.
    expect(outcome.finalDecision.decision).toBe('revise');
    expect(outcome.finalDecision.notes).toContain('still wrong');
  });

  it('honors a higher maxRevisions but still terminates at exactly the cap', async () => {
    const runRevision = vi.fn(async () => revise('nope'));
    const outcome = await runBoundedRevise({
      initialDecision: revise('start'),
      maxRevisions: 3,
      runRevision,
    });
    expect(runRevision).toHaveBeenCalledTimes(3);
    expect(outcome.revisionsRun).toBe(3);
    expect(outcome.hitCap).toBe(true);
  });

  it('maxRevisions=0 accepts the initial decision with no revision', async () => {
    const runRevision = vi.fn();
    const outcome = await runBoundedRevise({
      initialDecision: revise('unaddressed'),
      maxRevisions: 0,
      runRevision,
    });
    expect(runRevision).not.toHaveBeenCalled();
    expect(outcome.revisionsRun).toBe(0);
    // A cap of 0 with a still-revise verdict IS at the cap: the honest final state
    // stands, unaddressed, because policy allowed zero revisions.
    expect(outcome.hitCap).toBe(true);
    expect(outcome.finalDecision).toEqual(revise('unaddressed'));
  });

  it('feeds each round the previous decision notes and a 1-based round index', async () => {
    const seen: ReviseRoundInput[] = [];
    const runRevision = vi.fn((input: ReviseRoundInput) => {
      seen.push(input);
      return revise(`round ${input.round} notes`);
    });
    await runBoundedRevise({
      initialDecision: revise('original notes'),
      maxRevisions: 2,
      runRevision,
    });
    expect(seen[0]?.round).toBe(1);
    expect(seen[0]?.notes).toBe('original notes');
    expect(seen[1]?.round).toBe(2);
    expect(seen[1]?.notes).toBe('round 1 notes');
  });

  it('stops early when the run budget is exhausted (the outer net)', async () => {
    const budget = newRunBudget({ maxTurns: 1 });
    budget.turnsUsed = 1; // already spent
    const runRevision = vi.fn(async () => revise('never runs'));
    const outcome = await runBoundedRevise({
      initialDecision: revise('start'),
      maxRevisions: 1_000_000,
      budget,
      runRevision,
    });
    expect(runRevision).not.toHaveBeenCalled();
    expect(outcome.stoppedForBudget).toBe(true);
    expect(outcome.hitCap).toBe(false);
    expect(outcome.revisionsRun).toBe(0);
  });
});
