import { describe, expect, it } from 'vitest';
import {
  edgesFromContracts,
  findCycle,
  readyContracts,
  readyIds,
  topologicalOrder,
} from './dag.js';
import type { Contract, ContractStatus, QueueEdge } from './org-chart.js';

/** Minimal valid contract for graph tests — only id/dependsOn/status matter here. */
function contract(id: string, dependsOn: string[], status: ContractStatus = 'queued'): Contract {
  return {
    id,
    title: id,
    ownerNodeId: 'n1',
    input: 'in',
    output: 'out',
    slot: 'slot',
    available: { tools: [], imports: [] },
    reviewRubric: 'rubric',
    dependsOn,
    status,
  };
}

describe('edgesFromContracts', () => {
  it('derives one from→to edge per dependsOn entry', () => {
    const edges = edgesFromContracts([
      contract('a', []),
      contract('b', ['a']),
      contract('c', ['a', 'b']),
    ]);
    expect(edges).toEqual([
      { from: 'a', to: 'b' },
      { from: 'a', to: 'c' },
      { from: 'b', to: 'c' },
    ]);
  });

  it('produces no edges for a dependency-free contract set', () => {
    expect(edgesFromContracts([contract('a', []), contract('b', [])])).toEqual([]);
  });
});

describe('readyIds', () => {
  const ids = ['a', 'b', 'c'];

  it('returns every not-yet-completed id when there are no edges', () => {
    expect(readyIds(ids, [], new Set())).toEqual(['a', 'b', 'c']);
  });

  it('preserves input order (queue order = tie-break priority)', () => {
    expect(readyIds(['c', 'a', 'b'], [], new Set())).toEqual(['c', 'a', 'b']);
  });

  it('blocks a dependent until its prerequisite is completed, and excludes completed ids', () => {
    const edges: QueueEdge[] = [{ from: 'a', to: 'b' }];
    expect(readyIds(ids, edges, new Set())).toEqual(['a', 'c']); // b waits on a
    expect(readyIds(ids, edges, new Set(['a']))).toEqual(['b', 'c']); // a done → b unblocks, a gone
  });

  it('treats a prerequisite outside the id set as a blocker unless it is completed', () => {
    const edges: QueueEdge[] = [{ from: 'x', to: 'b' }];
    expect(readyIds(ids, edges, new Set())).toEqual(['a', 'c']); // external x blocks b
    expect(readyIds(ids, edges, new Set(['x']))).toEqual(['a', 'b', 'c']); // x satisfied
  });

  it('requires ALL prerequisites of a node to be completed', () => {
    const edges: QueueEdge[] = [
      { from: 'a', to: 'c' },
      { from: 'b', to: 'c' },
    ];
    expect(readyIds(ids, edges, new Set(['a']))).toEqual(['b']); // c still waits on b
    expect(readyIds(ids, edges, new Set(['a', 'b']))).toEqual(['c']);
  });
});

describe('readyContracts', () => {
  it('counts merged contracts as completed and returns those that may start now', () => {
    const contracts = [
      contract('a', [], 'merged'),
      contract('b', ['a'], 'queued'),
      contract('c', [], 'queued'),
      contract('d', ['b'], 'queued'),
    ];
    const ready = readyContracts(contracts, edgesFromContracts(contracts));
    // a is merged (excluded); b unblocks (a merged); c is independent; d still waits on b.
    expect(ready.map((c) => c.id)).toEqual(['b', 'c']);
  });

  it('holds back a contract whose prerequisite is not yet merged', () => {
    const contracts = [contract('a', [], 'in-progress'), contract('b', ['a'], 'queued')];
    const ready = readyContracts(contracts, edgesFromContracts(contracts));
    expect(ready.map((c) => c.id)).toEqual(['a']); // a not merged → b blocked
  });
});

describe('topologicalOrder', () => {
  it('orders a chain regardless of input order', () => {
    const edges: QueueEdge[] = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
    ];
    expect(topologicalOrder(['c', 'b', 'a'], edges)).toEqual(['a', 'b', 'c']);
  });

  it('is deterministic on a diamond (stable: input order wins among available nodes)', () => {
    const edges: QueueEdge[] = [
      { from: 'a', to: 'b' },
      { from: 'a', to: 'c' },
      { from: 'b', to: 'd' },
      { from: 'c', to: 'd' },
    ];
    expect(topologicalOrder(['d', 'c', 'b', 'a'], edges)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('returns null when the edges contain a cycle', () => {
    const edges: QueueEdge[] = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' },
    ];
    expect(topologicalOrder(['a', 'b'], edges)).toBeNull();
  });
});

describe('findCycle', () => {
  it('returns null for an acyclic graph', () => {
    const edges: QueueEdge[] = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
    ];
    expect(findCycle(['a', 'b', 'c'], edges)).toBeNull();
  });

  it('returns one cycle as a path with the entry id repeated at the end', () => {
    const edges: QueueEdge[] = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' },
    ];
    const cycle = findCycle(['a', 'b'], edges);
    expect(cycle).not.toBeNull();
    expect(cycle?.[0]).toBe(cycle?.[cycle.length - 1]); // closes back on itself
    expect(new Set(cycle)).toEqual(new Set(['a', 'b']));
  });

  it('detects a self-dependency', () => {
    expect(findCycle(['a'], [{ from: 'a', to: 'a' }])).toEqual(['a', 'a']);
  });
});
