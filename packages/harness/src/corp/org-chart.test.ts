import { describe, expect, it } from 'vitest';
import {
  CONTRACT_STATUSES,
  emptyOrgChart,
  isContractStatus,
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
});
