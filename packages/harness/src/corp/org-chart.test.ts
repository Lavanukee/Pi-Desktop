import { describe, expect, it } from 'vitest';
import {
  type Architecture,
  CONTRACT_STATUSES,
  emptyOrgChart,
  isArchitecture,
  isContractStatus,
  isInterfaceHandle,
  isModuleEntry,
  isNodeRole,
  isNodeStatus,
  isOrgChart,
  isOrgChartRunStatus,
  NODE_ROLES,
  NODE_STATUSES,
  ORG_CHART_RUN_STATUSES,
  type OrgChart,
} from './org-chart.js';

/** A structurally-valid, fully-populated chart to corrupt one field at a time. */
function validChart(): OrgChart {
  return {
    projectId: 'p1',
    nodes: [
      { id: 'ceo', role: 'ceo', name: 'CEO' },
      { id: 'mgr', role: 'manager', name: 'Manager', parentId: 'ceo', promptId: 'manager' },
      {
        id: 'fe',
        role: 'division',
        name: 'Frontend',
        parentId: 'mgr',
        promptId: 'frontend-dev',
        promptExtension: 'tokens only',
      },
      { id: 'eng', role: 'engineer', name: 'Eng', parentId: 'fe' },
    ],
    contracts: [
      {
        id: 'c1',
        title: 'Build',
        ownerNodeId: 'eng',
        input: 'in',
        output: 'out',
        slot: 'slot',
        available: { tools: ['read'], imports: ['x'] },
        reviewRubric: 'rubric',
        dependsOn: [],
        status: 'queued',
      },
    ],
    queue: [{ from: 'c1', to: 'c2' }],
    branches: [{ nodeId: 'eng', branch: 'eng-work' }],
    status: 'solo',
    nodeStatus: { eng: 'idle' },
  };
}

describe('enum type guards', () => {
  it('isNodeRole accepts every listed role and rejects others', () => {
    for (const r of NODE_ROLES) expect(isNodeRole(r)).toBe(true);
    for (const v of ['boss', '', 123, null, undefined, {}]) expect(isNodeRole(v)).toBe(false);
  });

  it('isNodeStatus accepts every listed status and rejects others', () => {
    for (const s of NODE_STATUSES) expect(isNodeStatus(s)).toBe(true);
    for (const v of ['busy', 42, null]) expect(isNodeStatus(v)).toBe(false);
  });

  it('isContractStatus accepts every listed status and rejects others', () => {
    for (const s of CONTRACT_STATUSES) expect(isContractStatus(s)).toBe(true);
    for (const v of ['done', 'merged ', 0, undefined]) expect(isContractStatus(v)).toBe(false);
  });

  it('isOrgChartRunStatus accepts every listed status and rejects others', () => {
    for (const s of ORG_CHART_RUN_STATUSES) expect(isOrgChartRunStatus(s)).toBe(true);
    for (const v of ['idle', 'running ', false]) expect(isOrgChartRunStatus(v)).toBe(false);
  });
});

describe('emptyOrgChart', () => {
  it('is a valid empty solo chart for the given project', () => {
    const chart = emptyOrgChart('proj-42');
    expect(chart).toEqual({
      projectId: 'proj-42',
      nodes: [],
      contracts: [],
      queue: [],
      branches: [],
      status: 'solo',
      nodeStatus: {},
    });
    expect(isOrgChart(chart)).toBe(true);
  });
});

describe('isOrgChart', () => {
  it('accepts a fully-populated chart', () => {
    expect(isOrgChart(validChart())).toBe(true);
  });

  it('rejects non-objects', () => {
    for (const v of [null, undefined, 'chart', 7, [], true]) expect(isOrgChart(v)).toBe(false);
  });

  it('rejects a missing or mistyped top-level field', () => {
    expect(isOrgChart({ ...validChart(), projectId: 42 })).toBe(false);
    expect(isOrgChart({ ...validChart(), nodes: 'x' })).toBe(false);
    expect(isOrgChart({ ...validChart(), contracts: {} })).toBe(false);
    expect(isOrgChart({ ...validChart(), queue: null })).toBe(false);
    expect(isOrgChart({ ...validChart(), branches: 3 })).toBe(false);
    expect(isOrgChart({ ...validChart(), status: 'bogus' })).toBe(false);
  });

  it('rejects a malformed node', () => {
    expect(isOrgChart({ ...validChart(), nodes: [{ id: 'x', role: 'boss', name: 'X' }] })).toBe(
      false,
    );
    expect(isOrgChart({ ...validChart(), nodes: [{ id: 'x', role: 'ceo' }] })).toBe(false); // no name
  });

  it('rejects a malformed contract (bad available surface)', () => {
    const bad = { ...validChart().contracts[0], available: { tools: [1], imports: [] } };
    expect(isOrgChart({ ...validChart(), contracts: [bad] })).toBe(false);
  });

  it('rejects a malformed queue edge', () => {
    expect(isOrgChart({ ...validChart(), queue: [{ from: 'a' }] })).toBe(false);
  });

  it('rejects a malformed branch ref', () => {
    expect(isOrgChart({ ...validChart(), branches: [{ nodeId: 'x' }] })).toBe(false);
  });

  it('rejects a bad nodeStatus map (array, or an invalid status value)', () => {
    expect(isOrgChart({ ...validChart(), nodeStatus: ['idle'] })).toBe(false);
    expect(isOrgChart({ ...validChart(), nodeStatus: { eng: 'nope' } })).toBe(false);
  });

  it('accepts an optional contract notes string (present or absent)', () => {
    const base = validChart();
    const [c0] = base.contracts;
    expect(c0?.notes).toBeUndefined(); // absent is fine
    expect(isOrgChart(base)).toBe(true);
    const withNotes = { ...base, contracts: [{ ...c0, notes: 'avoid the O(n^2) approach' }] };
    expect(isOrgChart(withNotes)).toBe(true);
  });

  it('rejects a non-string contract notes field', () => {
    const bad = { ...validChart().contracts[0], notes: 42 };
    expect(isOrgChart({ ...validChart(), contracts: [bad] })).toBe(false);
  });

  it('accepts an optional architecture (absent, or a valid one) and rejects a malformed one', () => {
    const base = validChart();
    expect(base.architecture).toBeUndefined(); // absent is fine
    expect(isOrgChart(base)).toBe(true);
    expect(isOrgChart({ ...base, architecture: validArchitecture() })).toBe(true);
    // Malformed architecture (a module entry missing `owner`).
    const badArch = { moduleMap: [{ path: 'src/x.ts', purpose: 'x' }], interfaces: [] };
    expect(isOrgChart({ ...base, architecture: badArch })).toBe(false);
  });
});

/** A structurally-valid architecture (one owned region + one cross-division seam). */
function validArchitecture(): Architecture {
  return {
    moduleMap: [
      { path: 'src/game/state.ts', owner: 'Gameplay', purpose: 'the shared game state' },
      { path: 'src/ui/hud.tsx', owner: 'UI', purpose: 'the heads-up display' },
    ],
    interfaces: [
      {
        name: 'GameState',
        exposedBy: 'Gameplay',
        path: 'src/game/state.ts',
        summary: 'the typed game-state store',
        consumedBy: ['UI'],
      },
    ],
  };
}

describe('Architecture guards', () => {
  it('isModuleEntry accepts a full entry and rejects a mistyped/partial one', () => {
    expect(isModuleEntry({ path: 'p', owner: 'o', purpose: 'why' })).toBe(true);
    expect(isModuleEntry({ path: 'p', owner: 'o' })).toBe(false); // no purpose
    expect(isModuleEntry({ path: 'p', owner: 3, purpose: 'why' })).toBe(false);
    for (const v of [null, undefined, 'x', 7, []]) expect(isModuleEntry(v)).toBe(false);
  });

  it('isInterfaceHandle requires all fields incl. a string[] consumedBy', () => {
    const h = validArchitecture().interfaces[0];
    expect(isInterfaceHandle(h)).toBe(true);
    expect(isInterfaceHandle({ ...h, consumedBy: [1] })).toBe(false); // not string[]
    expect(isInterfaceHandle({ ...h, consumedBy: 'UI' })).toBe(false); // not an array
    expect(isInterfaceHandle({ ...h, exposedBy: undefined })).toBe(false);
  });

  it('isArchitecture validates both arrays and rejects a bad element', () => {
    expect(isArchitecture(validArchitecture())).toBe(true);
    expect(isArchitecture({ moduleMap: [], interfaces: [] })).toBe(true); // empty is valid
    expect(isArchitecture({ moduleMap: 'x', interfaces: [] })).toBe(false);
    expect(isArchitecture({ moduleMap: [{ path: 'p' }], interfaces: [] })).toBe(false);
    for (const v of [null, undefined, 'x', 7]) expect(isArchitecture(v)).toBe(false);
  });
});
