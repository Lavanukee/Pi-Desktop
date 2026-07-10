import { describe, expect, it } from 'vitest';
import type { ConcurrencyBudget } from './budget.js';
import {
  type SchedulerSnapshot,
  type SubagentRunner,
  type SubagentRunOutcome,
  SubagentScheduler,
} from './scheduler.js';

function budget(over: Partial<ConcurrencyBudget> = {}): ConcurrencyBudget {
  return {
    maxConcurrency: 2,
    ramBudgetGB: 8,
    perAgentGB: 1.5,
    reason: 'test',
    ...over,
  };
}

/** A runner whose completion the test controls via the returned `resolve`. */
function deferredRunner(): {
  run: SubagentRunner;
  started: () => boolean;
  finish: (o: SubagentRunOutcome) => void;
} {
  let started = false;
  let resolveOutcome!: (o: SubagentRunOutcome) => void;
  const run: SubagentRunner = () => {
    started = true;
    return new Promise<SubagentRunOutcome>((res) => {
      resolveOutcome = res;
    });
  };
  return { run, started: () => started, finish: (o) => resolveOutcome(o) };
}

const ok = (summary: string): SubagentRunOutcome => ({ ok: true, summary });

describe('SubagentScheduler concurrency', () => {
  it('runs up to maxConcurrency, queues the rest, then drains in order', async () => {
    const snapshots: SchedulerSnapshot[] = [];
    const sched = new SubagentScheduler({
      budget: budget({ maxConcurrency: 2 }),
      onChange: (s) => snapshots.push(s),
    });
    const a = deferredRunner();
    const b = deferredRunner();
    const c = deferredRunner();

    const pa = sched.submit({ id: 'a', name: 'A', run: a.run });
    const pb = sched.submit({ id: 'b', name: 'B', run: b.run });
    const pc = sched.submit({ id: 'c', name: 'C', run: c.run });

    // Two started; the third is queued (over the concurrency limit).
    expect(a.started()).toBe(true);
    expect(b.started()).toBe(true);
    expect(c.started()).toBe(false);
    const snap = sched.snapshot();
    expect(snap.running).toBe(2);
    expect(snap.queued).toBe(1);

    a.finish(ok('A done'));
    await pa;
    // Freeing a slot lets C start.
    expect(c.started()).toBe(true);

    b.finish(ok('B done'));
    c.finish(ok('C done'));
    const [ra, rb, rc] = await Promise.all([pa, pb, pc]);
    expect(ra).toEqual({ accepted: true, outcome: ok('A done') });
    expect(rb.accepted).toBe(true);
    expect(rc.accepted).toBe(true);

    // A final snapshot shows all three as terminal, nothing running/queued.
    const final = sched.snapshot();
    expect(final.running).toBe(0);
    expect(final.queued).toBe(0);
    expect(final.items.map((i) => i.status)).toEqual(['done', 'done', 'done']);
  });

  it('bounds concurrency by the RAM budget even under the count limit', async () => {
    const sched = new SubagentScheduler({
      // 4 slots by count, but only 3 GB of RAM and 2 GB per agent → 1 at a time.
      budget: budget({ maxConcurrency: 4, ramBudgetGB: 3 }),
    });
    const a = deferredRunner();
    const b = deferredRunner();
    sched.submit({ id: 'a', name: 'A', estRamGB: 2, run: a.run });
    sched.submit({ id: 'b', name: 'B', estRamGB: 2, run: b.run });
    expect(a.started()).toBe(true);
    expect(b.started()).toBe(false); // 2 + 2 > 3
    a.finish(ok('done'));
    await Promise.resolve();
    await Promise.resolve();
    expect(b.started()).toBe(true);
  });
});

describe('SubagentScheduler rejection', () => {
  it('rejects (never spawns) a task larger than the whole budget', async () => {
    const sched = new SubagentScheduler({ budget: budget({ ramBudgetGB: 4 }) });
    const r = deferredRunner();
    const result = await sched.submit({ id: 'big', name: 'Big', estRamGB: 16, run: r.run });
    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.reason).toMatch(/memory budget/i);
    expect(r.started()).toBe(false);
    // No record was created for a rejected task.
    expect(sched.snapshot().items).toHaveLength(0);
  });

  it('accepts an exact-fit estimate (float slop tolerated)', async () => {
    const sched = new SubagentScheduler({ budget: budget({ ramBudgetGB: 1.5, perAgentGB: 1.5 }) });
    const r = deferredRunner();
    sched.submit({ id: 'fit', name: 'Fit', run: r.run });
    expect(r.started()).toBe(true);
  });
});

describe('SubagentScheduler — RAM estimate poisoning (SB-2)', () => {
  it('a non-positive estRamGB falls back to perAgentGB (cannot bypass the budget)', () => {
    // 4 slots by count, 2 GB RAM, 1.5 GB per agent. An estRamGB of 0 would
    // otherwise read as "free" (0 <= budget always) and never charge #usedRamGB,
    // letting unlimited agents run. It must be charged the per-agent default.
    const sched = new SubagentScheduler({
      budget: budget({ maxConcurrency: 4, ramBudgetGB: 2, perAgentGB: 1.5 }),
    });
    const a = deferredRunner();
    const b = deferredRunner();
    sched.submit({ id: 'a', name: 'A', estRamGB: 0, run: a.run });
    sched.submit({ id: 'b', name: 'B', estRamGB: 0, run: b.run });
    expect(a.started()).toBe(true);
    // Charged 1.5 each: 1.5 + 1.5 = 3 > 2 → second QUEUES rather than running.
    expect(b.started()).toBe(false);
  });

  it('negative and NaN estimates are ignored the same way', () => {
    const sched = new SubagentScheduler({
      budget: budget({ maxConcurrency: 4, ramBudgetGB: 2, perAgentGB: 1.5 }),
    });
    const a = deferredRunner();
    const b = deferredRunner();
    sched.submit({ id: 'a', name: 'A', estRamGB: -5, run: a.run });
    sched.submit({ id: 'b', name: 'B', estRamGB: Number.NaN, run: b.run });
    expect(a.started()).toBe(true);
    expect(b.started()).toBe(false);
  });
});

describe('SubagentScheduler failure handling', () => {
  it('records a failed run and keeps draining the queue (no wedge)', async () => {
    const sched = new SubagentScheduler({ budget: budget({ maxConcurrency: 1 }) });
    const failing: SubagentRunner = () =>
      Promise.resolve({ ok: false, summary: '', error: 'boom' });
    const p1 = sched.submit({ id: '1', name: 'one', run: failing });
    const p2 = sched.submit({ id: '2', name: 'two', run: () => Promise.resolve(ok('two ok')) });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual({ accepted: true, outcome: { ok: false, summary: '', error: 'boom' } });
    expect(r2.accepted).toBe(true);
    const items = sched.snapshot().items;
    expect(items.find((i) => i.id === '1')?.status).toBe('error');
    expect(items.find((i) => i.id === '2')?.status).toBe('done');
  });

  it('does not wedge if the injected runner throws synchronously', async () => {
    const sched = new SubagentScheduler({ budget: budget({ maxConcurrency: 1 }) });
    const thrower: SubagentRunner = () => {
      throw new Error('sync throw');
    };
    const r = await sched.submit({ id: 't', name: 'thrower', run: thrower });
    expect(r.accepted).toBe(true);
    if (r.accepted) expect(r.outcome.ok).toBe(false);
  });
});
