/**
 * The plan is a report of what was HANDED OUT, never a verdict on whether it was
 * any good — that judgement belongs to the manager and the CEO, and a plan that
 * marked itself green would be exactly the automated verdict this harness
 * deliberately does not have.
 */
import { describe, expect, it } from 'vitest';
import { type PlanHop, planFromHops, planGroup, planLabel } from './mesh-plan';

const hop = (over: Partial<PlanHop>): PlanHop => ({
  from: 'manager',
  to: 'engineer:1',
  message: 'WHAT TO BUILD: the format registry',
  reply: '',
  ...over,
});

describe('what a row says', () => {
  it('takes the contract template’s own first field', () => {
    expect(planLabel('WHAT TO BUILD: the conversion engine\nFILES YOU OWN: src/x.py')).toBe(
      'the conversion engine',
    );
  });

  it('falls back to the first real line when there is no template', () => {
    expect(planLabel('\n\nBuild the drop zone\nand wire it up')).toBe('Build the drop zone');
  });

  it('clips a whole brief down to something readable', () => {
    expect(planLabel('x'.repeat(300)).length).toBeLessThanOrEqual(80);
  });

  it('names the worker so rows group by who is doing them', () => {
    expect(planGroup('engineer:2')).toBe('Engineer 2');
  });
});

describe('what the plan counts', () => {
  it('one row per piece of work handed to a worker', () => {
    const rows = planFromHops(
      [
        hop({ to: 'engineer:1', message: 'WHAT TO BUILD: the registry' }),
        hop({ to: 'engineer:2', message: 'WHAT TO BUILD: the UI' }),
      ],
      new Set(),
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.label)).toEqual(['the registry', 'the UI']);
  });

  it('is DONE when the worker replied, in-progress while it is mid-turn', () => {
    const [pending] = planFromHops([hop({ reply: '' })], new Set());
    expect(pending?.state).toBe('queued');
    const [working] = planFromHops([hop({ reply: '' })], new Set(['engineer:1']));
    expect(working?.state).toBe('in-progress');
    const [done] = planFromHops([hop({ reply: 'built it, tests pass' })], new Set());
    expect(done?.state).toBe('done');
  });

  it('a resend of the SAME work is the same row', () => {
    // Otherwise a manager nudging somebody inflates the plan and the progress
    // rail reports work that does not exist.
    const rows = planFromHops([hop({ reply: '' }), hop({ reply: 'done' })], new Set());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe('done');
  });

  it('a SECOND, different piece for the same worker is a new row', () => {
    // This is the re-contract after a failed check — the loop the whole design
    // exists to run. Hiding it would hide the process working.
    const rows = planFromHops(
      [
        hop({ message: 'WHAT TO BUILD: the registry', reply: 'done' }),
        hop({ message: 'WHAT TO BUILD: fix the empty-input crash', reply: '' }),
      ],
      new Set(),
    );
    expect(rows).toHaveLength(2);
    expect(rows[1]?.label).toBe('fix the empty-input crash');
  });

  it('a row never moves BACKWARDS out of done', () => {
    const rows = planFromHops(
      [hop({ reply: 'finished' }), hop({ reply: '' })],
      new Set(['engineer:1']),
    );
    expect(rows[0]?.state).toBe('done');
  });

  it('ignores talk that is not somebody being given work', () => {
    // A reply up to the CEO, a question to a specialist, and a refused hop are
    // all conversation — none of them is a piece of the plan.
    const rows = planFromHops(
      [
        hop({ to: 'ceo', from: 'manager', message: 'we are finished' }),
        hop({ to: 'specialist:auditor', message: 'why does this fail?' }),
        hop({ to: 'engineer:1', refused: 'depth', message: 'WHAT TO BUILD: x' }),
      ],
      new Set(),
    );
    expect(rows).toHaveLength(0);
  });

  it('a queued message is not yet done, however long the reply stub is', () => {
    // `deliver` records "(queued)" as the reply for a message parked for later.
    const [row] = planFromHops([hop({ reply: '(queued)', queued: true })], new Set());
    expect(row?.state).not.toBe('done');
  });
});
