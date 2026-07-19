import { describe, expect, it } from 'vitest';
import {
  budgetExceeded,
  budgetExceededReason,
  chargeTurn,
  DEFAULT_MAX_WALL_CLOCK_MS,
  DEFAULT_STALL_WINDOW_MS,
  defaultMaxTurns,
  fitBudgetToPlan,
  MAX_TURNS_FLOOR,
  markProgress,
  newRunBudget,
  TURNS_PER_UNIT,
} from './budget.js';

describe('newRunBudget', () => {
  it('applies sensible defaults (floor turns, NO absolute cap, watchdog on)', () => {
    const clock = () => 1000;
    const budget = newRunBudget({ now: clock });
    expect(budget.maxTurns).toBe(MAX_TURNS_FLOOR);
    // The absolute wall-clock cap is OFF by default — no arbitrary truncation.
    expect(budget.maxWallClockMs).toBe(Number.POSITIVE_INFINITY);
    expect(budget.stallWindowMs).toBe(DEFAULT_STALL_WINDOW_MS);
    expect(budget.startedAt).toBe(1000);
    expect(budget.lastProgressAt).toBe(1000);
    expect(budget.turnsUsed).toBe(0);
  });

  it('honors explicit caps; disables the absolute cap on garbage/omission', () => {
    expect(newRunBudget({ maxTurns: 5, maxWallClockMs: 10 }).maxTurns).toBe(5);
    expect(newRunBudget({ maxTurns: 5, maxWallClockMs: 10 }).maxWallClockMs).toBe(10);
    // Garbage turns fall back to the floor, never a broken (0 / NaN) cap.
    expect(newRunBudget({ maxTurns: 0 }).maxTurns).toBe(MAX_TURNS_FLOOR);
    expect(newRunBudget({ maxTurns: Number.NaN }).maxTurns).toBe(MAX_TURNS_FLOOR);
    // The absolute cap is enabled ONLY by an explicit positive value.
    expect(newRunBudget({}).maxWallClockMs).toBe(Number.POSITIVE_INFINITY);
    expect(newRunBudget({ maxWallClockMs: -1 }).maxWallClockMs).toBe(Number.POSITIVE_INFINITY);
    expect(newRunBudget({ maxWallClockMs: DEFAULT_MAX_WALL_CLOCK_MS }).maxWallClockMs).toBe(
      DEFAULT_MAX_WALL_CLOCK_MS,
    );
    // The watchdog can be turned off with a non-positive window.
    expect(newRunBudget({ stallWindowMs: 0 }).stallWindowMs).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('defaultMaxTurns', () => {
  it('scales with the plan (3× the contract + division count) above the floor', () => {
    // 20 contracts + 4 divisions = 24 units × 3 = 72 turns.
    expect(defaultMaxTurns({ contractCount: 20, divisionCount: 4 })).toBe(
      TURNS_PER_UNIT * (20 + 4),
    );
  });

  it('never drops below the floor for a tiny plan', () => {
    expect(defaultMaxTurns({ contractCount: 1, divisionCount: 1 })).toBe(MAX_TURNS_FLOOR);
    expect(defaultMaxTurns({ contractCount: 0, divisionCount: 0 })).toBe(MAX_TURNS_FLOOR);
  });

  it('is robust to garbage counts', () => {
    expect(defaultMaxTurns({ contractCount: Number.NaN, divisionCount: -3 })).toBe(MAX_TURNS_FLOOR);
  });
});

describe('chargeTurn / budgetExceeded (turn cap)', () => {
  it('permits exactly maxTurns turns, then refuses', () => {
    const budget = newRunBudget({ maxTurns: 3 });
    expect(chargeTurn(budget)).toBe(true); // turn 1
    expect(chargeTurn(budget)).toBe(true); // turn 2
    expect(chargeTurn(budget)).toBe(true); // turn 3
    expect(budget.turnsUsed).toBe(3);
    expect(budgetExceeded(budget)).toBe(true);
    expect(chargeTurn(budget)).toBe(false); // turn 4 refused
    // A refused turn does NOT over-count.
    expect(budget.turnsUsed).toBe(3);
    expect(budgetExceededReason(budget)).toBe('turns');
  });

  it('a would-run-forever loop terminates at the cap (the endless-loop catch)', () => {
    const budget = newRunBudget({ maxTurns: 50 });
    let iterations = 0;
    // A model that loops forever: keep charging until the budget refuses.
    while (chargeTurn(budget)) {
      iterations += 1;
      // Hard safety so a bug here fails the test instead of hanging the suite.
      if (iterations > 10_000) throw new Error('chargeTurn never refused — budget did not cap');
    }
    expect(iterations).toBe(50);
    expect(budget.turnsUsed).toBe(50);
    expect(budgetExceeded(budget)).toBe(true);
  });
});

describe('budgetExceeded (opt-in absolute wall-clock cap, injected clock)', () => {
  it('refuses once an explicit wall-clock cap is spent, even with turns remaining', () => {
    let t = 0;
    const budget = newRunBudget({ maxTurns: 1000, maxWallClockMs: 100, now: () => t });
    expect(chargeTurn(budget)).toBe(true);
    expect(budgetExceeded(budget)).toBe(false);
    t = 100; // exactly at the wall
    expect(budgetExceededReason(budget)).toBe('wall-clock');
    expect(chargeTurn(budget)).toBe(false);
    // Turns were nowhere near their cap — wall-clock is what caught it.
    expect(budget.turnsUsed).toBeLessThan(budget.maxTurns);
  });

  it('reports the turn cap first when both are exhausted', () => {
    let t = 0;
    const budget = newRunBudget({ maxTurns: 1, maxWallClockMs: 100, now: () => t });
    chargeTurn(budget);
    t = 1000;
    expect(budgetExceededReason(budget)).toBe('turns');
  });
});

describe('no-progress watchdog (markProgress + injected clock)', () => {
  it('terminates a stalled run after the window, with turns and wall-clock to spare', () => {
    let t = 0;
    const budget = newRunBudget({ maxTurns: 1000, stallWindowMs: 100, now: () => t });
    expect(chargeTurn(budget)).toBe(true);
    t = 99;
    expect(budgetExceeded(budget)).toBe(false); // just short of the window
    t = 100; // no progress for the whole window
    expect(budgetExceededReason(budget)).toBe('stalled');
    expect(chargeTurn(budget)).toBe(false);
    expect(budget.turnsUsed).toBeLessThan(budget.maxTurns); // not the turn cap
  });

  it('markProgress resets the window — a run that keeps advancing never stalls', () => {
    let t = 0;
    const budget = newRunBudget({ maxTurns: 1000, stallWindowMs: 100, now: () => t });
    // Advance for well past one window, marking progress every 50ms.
    for (let step = 0; step < 20; step += 1) {
      t += 50;
      markProgress(budget);
      expect(budgetExceeded(budget)).toBe(false);
    }
    expect(budget.now() - budget.startedAt).toBeGreaterThan(100); // ran far past one window
    // Then stop advancing → it stalls exactly one window later.
    t += 100;
    expect(budgetExceededReason(budget)).toBe('stalled');
  });

  it('an explicit non-positive window disables the watchdog (turn cap only)', () => {
    let t = 0;
    const budget = newRunBudget({ maxTurns: 1000, stallWindowMs: 0, now: () => t });
    expect(budget.stallWindowMs).toBe(Number.POSITIVE_INFINITY);
    t = 10 ** 12; // an eternity with no progress
    expect(budgetExceeded(budget)).toBe(false); // never stalls
  });

  it('reports the turn cap first when turns AND stall both trip', () => {
    let t = 0;
    const budget = newRunBudget({ maxTurns: 1, stallWindowMs: 100, now: () => t });
    chargeTurn(budget);
    t = 1000;
    expect(budgetExceededReason(budget)).toBe('turns');
  });
});

describe('fitBudgetToPlan', () => {
  it('raises the turn cap to fit a bigger plan', () => {
    const budget = newRunBudget({ maxTurns: MAX_TURNS_FLOOR });
    fitBudgetToPlan(budget, { contractCount: 40, divisionCount: 5 });
    expect(budget.maxTurns).toBe(TURNS_PER_UNIT * 45);
  });

  it('never lowers the cap (a small plan does not shrink an already-raised budget)', () => {
    const budget = newRunBudget({ maxTurns: 500 });
    fitBudgetToPlan(budget, { contractCount: 2, divisionCount: 1 });
    expect(budget.maxTurns).toBe(500);
  });

  it('leaves the wall-clock cap untouched (the hard net no plan can widen)', () => {
    const budget = newRunBudget({ maxWallClockMs: 1234 });
    fitBudgetToPlan(budget, { contractCount: 1000, divisionCount: 100 });
    expect(budget.maxWallClockMs).toBe(1234);
  });
});
