import { describe, expect, it } from 'vitest';
import {
  countCrossDivisionEdges,
  type DivisionContracts,
  isInterfaceHandleRef,
  resolveInterfaceHandles,
} from './integrate.js';
import type { Architecture, Contract, ContractStatus } from './org-chart.js';
import { buildOrgChartQueueWithReport } from './plan.js';
import { applyCreateHierarchy } from './promotion.js';

/** A full, valid contract owned by a division's engineer. */
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

/** Backend exposes `GameState` at src/api.ts; Frontend consumes it. */
function architecture(path = 'src/api.ts'): Architecture {
  return {
    moduleMap: [{ path, owner: 'Backend', purpose: 'the API' }],
    interfaces: [
      {
        name: 'GameState',
        exposedBy: 'Backend',
        path,
        summary: 'the typed game state',
        consumedBy: ['Frontend'],
      },
    ],
  };
}

describe('isInterfaceHandleRef', () => {
  it('recognizes the iface: prefix only', () => {
    expect(isInterfaceHandleRef('iface:GameState')).toBe(true);
    expect(isInterfaceHandleRef('be-1')).toBe(false);
    expect(isInterfaceHandleRef('interface:GameState')).toBe(false);
  });
});

describe('resolveInterfaceHandles — the cross-division seam', () => {
  it('rewrites iface:<Name> to the exposing division contract whose slot matches the path', () => {
    const byDivision: DivisionContracts[] = [
      {
        division: 'Backend',
        contracts: [contract('be-1', 'division-backend-eng', { slot: 'src/api.ts' })],
      },
      {
        division: 'Frontend',
        contracts: [contract('fe-1', 'division-frontend-eng', { dependsOn: ['iface:GameState'] })],
      },
    ];
    const { contracts, report } = resolveInterfaceHandles(byDivision, architecture());

    const fe1 = contracts.find((c) => c.id === 'fe-1');
    expect(fe1?.dependsOn).toEqual(['be-1']); // handle rewritten to the producing contract id
    expect(report.resolved).toHaveLength(1);
    expect(report.resolved[0]).toMatchObject({
      name: 'GameState',
      inContract: 'fe-1',
      resolvedTo: 'be-1',
      exposedBy: 'Backend',
      matchedSlot: true,
    });
    expect(report.unresolved).toHaveLength(0);
  });

  it('produces a real cross-division queue edge once the chart is planned', () => {
    const byDivision: DivisionContracts[] = [
      {
        division: 'Backend',
        contracts: [contract('be-1', 'division-backend-eng', { slot: 'src/api.ts' })],
      },
      {
        division: 'Frontend',
        contracts: [contract('fe-1', 'division-frontend-eng', { dependsOn: ['iface:GameState'] })],
      },
    ];
    const { contracts } = resolveInterfaceHandles(byDivision, architecture());

    const base = applyCreateHierarchy(null, {
      reason: 'multi-part app',
      divisions: [
        { name: 'Backend', purpose: 'the API' },
        { name: 'Frontend', purpose: 'the UI' },
      ],
    });
    const { chart, report } = buildOrgChartQueueWithReport({ ...base, contracts });

    expect(report.acyclic).toBe(true);
    expect(chart.queue).toEqual([{ from: 'be-1', to: 'fe-1' }]); // Backend → Frontend edge

    // And it is genuinely cross-division per the id → division map.
    const divisionByContractId = new Map([
      ['be-1', 'Backend'],
      ['fe-1', 'Frontend'],
    ]);
    expect(countCrossDivisionEdges(chart.queue, divisionByContractId)).toBe(1);
  });

  it('falls back to the first contract in the exposing division when no slot matches', () => {
    const byDivision: DivisionContracts[] = [
      {
        division: 'Backend',
        contracts: [
          contract('be-1', 'division-backend-eng', { slot: 'src/other.ts' }),
          contract('be-2', 'division-backend-eng', { slot: 'src/more.ts' }),
        ],
      },
      {
        division: 'Frontend',
        contracts: [contract('fe-1', 'division-frontend-eng', { dependsOn: ['iface:GameState'] })],
      },
    ];
    // Interface path points at a slot no Backend contract claims → first-in-division.
    const { contracts, report } = resolveInterfaceHandles(byDivision, architecture('src/api.ts'));
    expect(contracts.find((c) => c.id === 'fe-1')?.dependsOn).toEqual(['be-1']);
    expect(report.resolved[0]?.matchedSlot).toBe(false);
  });

  it('leaves an unknown handle for the sweep to drop (recorded as unresolved)', () => {
    const byDivision: DivisionContracts[] = [
      {
        division: 'Backend',
        contracts: [contract('be-1', 'division-backend-eng', { slot: 'src/api.ts' })],
      },
      {
        division: 'Frontend',
        contracts: [contract('fe-1', 'division-frontend-eng', { dependsOn: ['iface:Missing'] })],
      },
    ];
    const { contracts, report } = resolveInterfaceHandles(byDivision, architecture());
    // Not rewritten — still the raw handle, which is not a contract id.
    expect(contracts.find((c) => c.id === 'fe-1')?.dependsOn).toEqual(['iface:Missing']);
    expect(report.resolved).toHaveLength(0);
    expect(report.unresolved).toEqual([
      {
        handle: 'iface:Missing',
        name: 'Missing',
        inContract: 'fe-1',
        inDivision: 'Frontend',
        reason: 'unknown-interface',
      },
    ]);

    // The existing sweep then drops it as a dangling id (spec §0.6).
    const base = applyCreateHierarchy(null, {
      reason: 'app',
      divisions: [
        { name: 'Backend', purpose: 'the API' },
        { name: 'Frontend', purpose: 'the UI' },
      ],
    });
    const { chart, report: plan } = buildOrgChartQueueWithReport({ ...base, contracts });
    expect(chart.queue).toEqual([]); // no phantom edge
    expect(plan.sweep.droppedDependencies).toEqual([
      { contractId: 'fe-1', dependsOn: 'iface:Missing', reason: 'unknown-id' },
    ]);
  });

  it('records no-producer when the exposing division authored no contracts', () => {
    const byDivision: DivisionContracts[] = [
      { division: 'Backend', contracts: [] }, // exposes GameState but wrote nothing
      {
        division: 'Frontend',
        contracts: [contract('fe-1', 'division-frontend-eng', { dependsOn: ['iface:GameState'] })],
      },
    ];
    const { contracts, report } = resolveInterfaceHandles(byDivision, architecture());
    expect(contracts.find((c) => c.id === 'fe-1')?.dependsOn).toEqual(['iface:GameState']);
    expect(report.unresolved[0]?.reason).toBe('no-producer');
  });

  it('preserves non-iface deps, de-dupes, and does not mutate inputs', () => {
    const byDivision: DivisionContracts[] = [
      {
        division: 'Backend',
        contracts: [contract('be-1', 'division-backend-eng', { slot: 'src/api.ts' })],
      },
      {
        division: 'Frontend',
        contracts: [
          contract('fe-0', 'division-frontend-eng'),
          contract('fe-1', 'division-frontend-eng', {
            dependsOn: ['fe-0', 'iface:GameState'],
          }),
        ],
      },
    ];
    const snapshot = structuredClone(byDivision);
    const { contracts } = resolveInterfaceHandles(byDivision, architecture());
    expect(contracts.find((c) => c.id === 'fe-1')?.dependsOn).toEqual(['fe-0', 'be-1']);
    expect(byDivision).toEqual(snapshot); // inputs untouched
  });
});

describe('countCrossDivisionEdges', () => {
  it('counts only edges whose ends are known and in different divisions', () => {
    const map = new Map([
      ['a1', 'A'],
      ['a2', 'A'],
      ['b1', 'B'],
    ]);
    const edges = [
      { from: 'a1', to: 'a2' }, // same division
      { from: 'a1', to: 'b1' }, // cross
      { from: 'b1', to: 'ghost' }, // unknown end — ignored
    ];
    expect(countCrossDivisionEdges(edges, map)).toBe(1);
  });
});
