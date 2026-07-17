import { describe, expect, it } from 'vitest';
import { buildProductManifest, summarizeContractStatus } from './assemble.js';
import type { Contract, OrgChart } from './org-chart.js';
import { slotPath, type WorkspaceReadFs } from './workspace.js';

const WS = '/ws';

function contract(overrides: Partial<Contract> = {}): Contract {
  return {
    id: 'c1',
    title: 'Contract 1',
    ownerNodeId: 'eng-1',
    input: 'in',
    output: 'out',
    slot: 'src/one.ts',
    available: { tools: [], imports: [] },
    reviewRubric: 'meets slot',
    dependsOn: [],
    status: 'in-review',
    ...overrides,
  };
}

/** An in-memory read seam over a slot→content map (keyed at the resolved path). */
function memFs(bySlot: Record<string, string>): WorkspaceReadFs {
  const store = new Map<string, string>();
  for (const [slot, content] of Object.entries(bySlot)) store.set(slotPath(WS, slot), content);
  return {
    readFile: (p) => store.get(p),
    listFiles: () => [...store.keys()],
  };
}

function chart(overrides: Partial<OrgChart> = {}): OrgChart {
  return {
    projectId: 'p',
    nodes: [
      { id: 'ceo', role: 'ceo', name: 'CEO' },
      { id: 'manager', role: 'manager', name: 'Manager block', parentId: 'ceo' },
      { id: 'division-fe', role: 'division', name: 'Frontend', parentId: 'manager' },
      { id: 'division-be', role: 'division', name: 'Backend', parentId: 'manager' },
    ],
    contracts: [],
    queue: [],
    branches: [],
    status: 'running',
    nodeStatus: {},
    ...overrides,
  };
}

describe('summarizeContractStatus', () => {
  it('buckets produced work as done, unfulfillable as failed, the rest as skipped', () => {
    expect(summarizeContractStatus('in-review')).toBe('done');
    expect(summarizeContractStatus('merged')).toBe('done');
    expect(summarizeContractStatus('unfulfillable')).toBe('failed');
    expect(summarizeContractStatus('queued')).toBe('skipped');
    expect(summarizeContractStatus('ready')).toBe('skipped');
    expect(summarizeContractStatus('in-progress')).toBe('skipped');
  });
});

describe('buildProductManifest', () => {
  it('lists divisions from the org chart (role=division only)', () => {
    const manifest = buildProductManifest(chart(), WS, memFs({}));
    expect(manifest.divisions.map((d) => d.name)).toEqual(['Frontend', 'Backend']);
    expect(manifest.divisions.map((d) => d.id)).toEqual(['division-fe', 'division-be']);
  });

  it('lists produced files with real byte sizes and totals them', () => {
    const contracts = [
      contract({ id: 'a', slot: 'src/a.ts' }),
      contract({ id: 'b', slot: 'src/b.ts' }),
    ];
    const fs = memFs({ 'src/a.ts': 'export const a = 1;\n', 'src/b.ts': 'export const b = 2;\n' });
    const manifest = buildProductManifest(chart({ contracts }), WS, fs);
    expect(manifest.files.map((f) => f.slot)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(manifest.files[0]?.path).toBe(slotPath(WS, 'src/a.ts'));
    expect(manifest.files[0]?.bytes).toBe(20);
    expect(manifest.totalBytes).toBe(40);
  });

  it('omits contracts whose file was never produced (skipped/failed)', () => {
    const contracts = [
      contract({ id: 'a', slot: 'src/a.ts', status: 'in-review' }),
      contract({ id: 'b', slot: 'src/missing.ts', status: 'unfulfillable' }),
    ];
    // only a.ts exists on disk
    const fs = memFs({ 'src/a.ts': 'ok\n' });
    const manifest = buildProductManifest(chart({ contracts }), WS, fs);
    expect(manifest.files.map((f) => f.slot)).toEqual(['src/a.ts']);
  });

  it('summarizes contract outcomes across statuses', () => {
    const contracts = [
      contract({ id: 'a', status: 'in-review', slot: 'src/a.ts' }),
      contract({ id: 'b', status: 'merged', slot: 'src/b.ts' }),
      contract({ id: 'c', status: 'unfulfillable', slot: 'src/c.ts' }),
      contract({ id: 'd', status: 'queued', slot: 'src/d.ts' }),
    ];
    const manifest = buildProductManifest(chart({ contracts }), WS, memFs({}));
    expect(manifest.contractStatusSummary).toEqual({ done: 2, failed: 1, skipped: 1 });
  });

  it('carries the shared architecture interfaces (when present) and defaults to []', () => {
    const withArch = chart({
      architecture: {
        moduleMap: [{ path: 'src/game/', owner: 'Frontend', purpose: 'game' }],
        interfaces: [
          {
            name: 'GameState',
            exposedBy: 'Frontend',
            path: 'src/game/state.ts',
            summary: 'the store',
            consumedBy: ['Backend'],
          },
        ],
      },
    });
    expect(buildProductManifest(withArch, WS, memFs({})).interfaces).toHaveLength(1);
    expect(buildProductManifest(chart(), WS, memFs({})).interfaces).toEqual([]);
  });

  it('dedupes distinct contracts that resolve to the same path', () => {
    const contracts = [
      contract({ id: 'a', slot: 'src/a.ts' }),
      contract({ id: 'a2', slot: 'src/a.ts' }),
    ];
    const manifest = buildProductManifest(chart({ contracts }), WS, memFs({ 'src/a.ts': 'x\n' }));
    expect(manifest.files).toHaveLength(1);
  });
});
