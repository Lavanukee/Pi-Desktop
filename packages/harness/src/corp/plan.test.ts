import { describe, expect, it } from 'vitest';
import { edgesFromContracts, topologicalOrder } from './dag.js';
import type { Contract, ContractStatus, OrgChart } from './org-chart.js';
import { isOrgChart } from './org-chart.js';
import { buildOrgChartQueue, buildOrgChartQueueWithReport } from './plan.js';
import { applyCreateHierarchy } from './promotion.js';

/** A full, valid contract owned by a given division's engineer. */
function contract(
  id: string,
  ownerNodeId: string,
  opts: { slot?: string; dependsOn?: string[]; status?: ContractStatus } = {},
): Contract {
  return {
    id,
    title: id,
    ownerNodeId,
    input: 'in',
    output: 'out',
    slot: opts.slot ?? `src/${id}.ts`,
    available: { tools: [], imports: [] },
    reviewRubric: 'rubric',
    dependsOn: opts.dependsOn ?? [],
    status: opts.status ?? 'queued',
  };
}

/** A two-division org chart (Frontend + Backend) with the given contracts. */
function chartWith(contracts: Contract[]): OrgChart {
  const base = applyCreateHierarchy(null, {
    reason: 'multi-part app',
    divisions: [
      { name: 'Frontend', purpose: 'the UI' },
      { name: 'Backend', purpose: 'the API' },
    ],
  });
  return { ...base, contracts };
}

describe('buildOrgChartQueue — cross-division DAG', () => {
  it('builds queue edges spanning divisions and stays acyclic', () => {
    // be-1 (Backend) depends on fe-1 (Frontend): a cross-division edge.
    const chart = chartWith([
      contract('fe-1', 'division-frontend-eng'),
      contract('be-1', 'division-backend-eng', { dependsOn: ['fe-1'] }),
    ]);
    const { chart: planned, report } = buildOrgChartQueueWithReport(chart);

    expect(report.acyclic).toBe(true);
    expect(planned.queue).toEqual([{ from: 'fe-1', to: 'be-1' }]);
    // topological order honours the cross-division dependency.
    expect(
      topologicalOrder(
        planned.contracts.map((c) => c.id),
        planned.queue,
      ),
    ).toEqual(['fe-1', 'be-1']);
  });

  it('returns a structurally valid chart with status set to running', () => {
    const chart = chartWith([contract('fe-1', 'division-frontend-eng')]);
    const planned = buildOrgChartQueue(chart);
    expect(isOrgChart(planned)).toBe(true);
    expect(planned.status).toBe('running');
    // The queue is exactly the edges derived from the (sanitized) contracts.
    expect(planned.queue).toEqual(edgesFromContracts(planned.contracts));
  });

  it('does not mutate the input chart', () => {
    const chart = chartWith([contract('fe-1', 'division-frontend-eng')]);
    const snapshot = structuredClone(chart);
    buildOrgChartQueue(chart);
    expect(chart).toEqual(snapshot);
  });
});

describe('buildOrgChartQueue — runs the sweep', () => {
  it('drops a dangling cross-division dep so it never becomes a queue edge', () => {
    const chart = chartWith([
      contract('fe-1', 'division-frontend-eng'),
      // be-1 points at a Frontend contract that was never emitted.
      contract('be-1', 'division-backend-eng', { dependsOn: ['fe-ghost'] }),
    ]);
    const { chart: planned, report } = buildOrgChartQueueWithReport(chart);
    expect(planned.queue).toEqual([]); // ghost edge dropped
    expect(report.sweep.droppedDependencies).toEqual([
      { contractId: 'be-1', dependsOn: 'fe-ghost', reason: 'unknown-id' },
    ]);
  });

  it('serializes a cross-division slot collision instead of racing the file', () => {
    // Both divisions target the same shared file — Frontend claims it first.
    const chart = chartWith([
      contract('fe-1', 'division-frontend-eng', { slot: 'src/shared/theme.ts' }),
      contract('be-1', 'division-backend-eng', { slot: 'src/shared/theme.ts' }),
    ]);
    const { chart: planned, report } = buildOrgChartQueueWithReport(chart);
    expect(report.sweep.slotCollisions).toEqual([
      { slot: 'src/shared/theme.ts', owner: 'fe-1', contractId: 'be-1', serializedAfter: 'fe-1' },
    ]);
    expect(planned.queue).toEqual([{ from: 'fe-1', to: 'be-1' }]); // serialized, acyclic
    expect(report.acyclic).toBe(true);
  });
});

describe('buildOrgChartQueue — cycle breaking', () => {
  it('breaks an injected 2-node cycle deterministically and records the back-edge', () => {
    // fe-1 depends on be-1 AND be-1 depends on fe-1 — a cycle across divisions.
    const chart = chartWith([
      contract('fe-1', 'division-frontend-eng', { dependsOn: ['be-1'] }),
      contract('be-1', 'division-backend-eng', { dependsOn: ['fe-1'] }),
    ]);
    const { chart: planned, report } = buildOrgChartQueueWithReport(chart);

    expect(report.acyclic).toBe(true);
    expect(report.brokenEdges).toHaveLength(1);
    // The queue that remains is a real DAG (topo order exists).
    expect(
      topologicalOrder(
        planned.contracts.map((c) => c.id),
        planned.queue,
      ),
    ).not.toBeNull();
    // Exactly one of the two mutual edges survives.
    expect(planned.queue).toHaveLength(1);
    // Contracts and queue stay consistent after the break.
    expect(planned.queue).toEqual(edgesFromContracts(planned.contracts));
  });

  it('breaks a self-dependency cycle', () => {
    const chart = chartWith([contract('fe-1', 'division-frontend-eng', { dependsOn: ['fe-1'] })]);
    // The self-dep is dropped by the sweep before it can even form a cycle,
    // so the queue is clean and no cycle break is needed.
    const { chart: planned, report } = buildOrgChartQueueWithReport(chart);
    expect(planned.queue).toEqual([]);
    expect(report.acyclic).toBe(true);
    expect(planned.contracts[0]?.dependsOn).toEqual([]);
  });

  it('breaks a longer cycle introduced by slot serialization + a forward reference', () => {
    // fe-1 depends on be-1 (a forward reference the manager wrote), and fe-1 and
    // be-1 share a slot — serialization adds be-1 → fe-1, closing a cycle. The
    // build must still return an acyclic queue.
    const chart = chartWith([
      contract('fe-1', 'division-frontend-eng', { slot: 'src/shared.ts', dependsOn: ['be-1'] }),
      contract('be-1', 'division-backend-eng', { slot: 'src/shared.ts' }),
    ]);
    const { chart: planned, report } = buildOrgChartQueueWithReport(chart);
    expect(report.acyclic).toBe(true);
    expect(
      topologicalOrder(
        planned.contracts.map((c) => c.id),
        planned.queue,
      ),
    ).not.toBeNull();
    expect(planned.queue).toEqual(edgesFromContracts(planned.contracts));
  });
});
