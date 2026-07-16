import { describe, expect, it } from 'vitest';
import type { Contract, ContractStatus } from './org-chart.js';
import { isContract } from './org-chart.js';
import { isSanitizeReportClean, sanitizeContracts, sanitizeRepairCount } from './sanitize.js';

/** A full, valid contract — id/slot/dependsOn are what the sweep operates on. */
function contract(
  id: string,
  opts: { slot?: string; dependsOn?: string[]; status?: ContractStatus; title?: string } = {},
): Contract {
  return {
    id,
    title: opts.title ?? id,
    ownerNodeId: `${id}-eng`,
    input: 'in',
    output: 'out',
    slot: opts.slot ?? `src/${id}.ts`,
    available: { tools: [], imports: [] },
    reviewRubric: 'rubric',
    dependsOn: opts.dependsOn ?? [],
    status: opts.status ?? 'queued',
  };
}

describe('sanitizeContracts — dangling / self dependsOn (case a)', () => {
  it('drops a dependsOn id that resolves to no emitted contract, recording it', () => {
    const { contracts, repairs } = sanitizeContracts([
      contract('a'),
      contract('b', { dependsOn: ['a', 'ghost'] }),
    ]);
    expect(contracts.find((c) => c.id === 'b')?.dependsOn).toEqual(['a']); // ghost gone, a kept
    expect(repairs.droppedDependencies).toEqual([
      { contractId: 'b', dependsOn: 'ghost', reason: 'unknown-id' },
    ]);
  });

  it('drops a self-dependency and tags the reason `self`', () => {
    const { contracts, repairs } = sanitizeContracts([contract('a', { dependsOn: ['a'] })]);
    expect(contracts[0]?.dependsOn).toEqual([]);
    expect(repairs.droppedDependencies).toEqual([
      { contractId: 'a', dependsOn: 'a', reason: 'self' },
    ]);
  });

  it('keeps a dep pointing at a duplicate id (it still resolves to the kept first one)', () => {
    // `dup` appears twice; the dep resolves to the surviving first `dup`.
    const { contracts, repairs } = sanitizeContracts([
      contract('dup', { slot: 'x' }),
      contract('dup', { slot: 'y' }),
      contract('c', { dependsOn: ['dup'] }),
    ]);
    expect(contracts.find((c) => c.id === 'c')?.dependsOn).toEqual(['dup']);
    expect(repairs.droppedDependencies).toEqual([]);
  });

  it('de-dupes a repeated dep silently (not recorded as a drop)', () => {
    const { contracts, repairs } = sanitizeContracts([
      contract('a'),
      contract('b', { dependsOn: ['a', 'a'] }),
    ]);
    expect(contracts.find((c) => c.id === 'b')?.dependsOn).toEqual(['a']);
    expect(repairs.droppedDependencies).toEqual([]);
  });
});

describe('sanitizeContracts — slot de-collision (case b)', () => {
  it('serializes a later contract after the earlier writer of the same slot', () => {
    const { contracts, repairs } = sanitizeContracts([
      contract('a', { slot: 'src/App.tsx' }),
      contract('b', { slot: 'src/App.tsx' }),
    ]);
    // a keeps the slot untouched; b now depends on a (serialized after it).
    expect(contracts.find((c) => c.id === 'a')?.dependsOn).toEqual([]);
    expect(contracts.find((c) => c.id === 'b')?.dependsOn).toEqual(['a']);
    // slots are NOT renamed — both still target the real injection point.
    expect(contracts.map((c) => c.slot)).toEqual(['src/App.tsx', 'src/App.tsx']);
    expect(repairs.slotCollisions).toEqual([
      { slot: 'src/App.tsx', owner: 'a', contractId: 'b', serializedAfter: 'a' },
    ]);
  });

  it('chains THREE writers of one slot in input order (a → b → c)', () => {
    const { contracts, repairs } = sanitizeContracts([
      contract('a', { slot: 's' }),
      contract('b', { slot: 's' }),
      contract('c', { slot: 's' }),
    ]);
    expect(contracts.find((c) => c.id === 'a')?.dependsOn).toEqual([]);
    expect(contracts.find((c) => c.id === 'b')?.dependsOn).toEqual(['a']);
    expect(contracts.find((c) => c.id === 'c')?.dependsOn).toEqual(['b']); // after the PREVIOUS writer
    expect(repairs.slotCollisions).toEqual([
      { slot: 's', owner: 'a', contractId: 'b', serializedAfter: 'a' },
      { slot: 's', owner: 'a', contractId: 'c', serializedAfter: 'b' },
    ]);
  });

  it('does not add a duplicate dep when the later writer already depends on the previous one', () => {
    const { contracts, repairs } = sanitizeContracts([
      contract('a', { slot: 's' }),
      contract('b', { slot: 's', dependsOn: ['a'] }),
    ]);
    expect(contracts.find((c) => c.id === 'b')?.dependsOn).toEqual(['a']); // not ['a','a']
    expect(repairs.slotCollisions).toHaveLength(1);
  });

  it('leaves distinct slots alone', () => {
    const { contracts, repairs } = sanitizeContracts([
      contract('a', { slot: 'x' }),
      contract('b', { slot: 'y' }),
    ]);
    expect(contracts.find((c) => c.id === 'b')?.dependsOn).toEqual([]);
    expect(repairs.slotCollisions).toEqual([]);
  });
});

describe('sanitizeContracts — duplicate ids (case c)', () => {
  it('keeps the first contract with an id and drops later duplicates, recording them', () => {
    const { contracts, repairs } = sanitizeContracts([
      contract('a', { slot: 'x', title: 'first' }),
      contract('a', { slot: 'y', title: 'second' }),
      contract('b', { slot: 'z' }),
    ]);
    expect(contracts.map((c) => c.id)).toEqual(['a', 'b']);
    // the SURVIVING `a` is the first one (its slot/title).
    expect(contracts.find((c) => c.id === 'a')).toMatchObject({ slot: 'x', title: 'first' });
    expect(repairs.duplicateIds).toEqual([{ id: 'a', droppedTitle: 'second' }]);
  });
});

describe('sanitizeContracts — invariants', () => {
  it('never throws and returns a valid Contract[] on empty input', () => {
    const { contracts, repairs } = sanitizeContracts([]);
    expect(contracts).toEqual([]);
    expect(isSanitizeReportClean(repairs)).toBe(true);
  });

  it('always returns structurally valid contracts, even on a messy mixed input', () => {
    const { contracts } = sanitizeContracts([
      contract('a', { slot: 's' }),
      contract('a', { slot: 's' }), // duplicate id
      contract('b', { slot: 's', dependsOn: ['ghost', 'b', 'a'] }), // dangling + self + slot-collide
    ]);
    for (const c of contracts) expect(isContract(c)).toBe(true);
  });

  it('preserves input order of the surviving contracts', () => {
    const { contracts } = sanitizeContracts([
      contract('c'),
      contract('a'),
      contract('b'),
      contract('a'), // dropped duplicate
    ]);
    expect(contracts.map((c) => c.id)).toEqual(['c', 'a', 'b']);
  });

  it('does not mutate the input contracts', () => {
    const input = [
      contract('a', { slot: 's' }),
      contract('b', { slot: 's', dependsOn: ['ghost'] }),
    ];
    const snapshot = structuredClone(input);
    sanitizeContracts(input);
    expect(input).toEqual(snapshot);
  });

  it('composes all three repairs and counts them', () => {
    const { repairs } = sanitizeContracts([
      contract('a', { slot: 's' }),
      contract('a', { slot: 's' }), // 1 duplicate id
      contract('b', { slot: 's', dependsOn: ['ghost'] }), // 1 dropped dep + 1 slot collision
    ]);
    expect(repairs.duplicateIds).toHaveLength(1);
    expect(repairs.droppedDependencies).toHaveLength(1);
    expect(repairs.slotCollisions).toHaveLength(1);
    expect(sanitizeRepairCount(repairs)).toBe(3);
    expect(isSanitizeReportClean(repairs)).toBe(false);
  });

  it('reports a clean sweep for already-valid contracts', () => {
    const { contracts, repairs } = sanitizeContracts([
      contract('a', { slot: 'x' }),
      contract('b', { slot: 'y', dependsOn: ['a'] }),
    ]);
    expect(contracts).toHaveLength(2);
    expect(isSanitizeReportClean(repairs)).toBe(true);
  });
});
