import { describe, expect, it } from 'vitest';
import { emptyOrgChart, isOrgChart } from './org-chart.js';
import {
  applyCreateHierarchy,
  CREATE_PRODUCTION_HIERARCHY,
  CREATE_PRODUCTION_HIERARCHY_TOOL,
  type CreateHierarchyArgs,
  DEFAULT_PROMOTION_PROJECT_ID,
  PROMOTION_SYSTEM_PROMPT,
  parseCreateHierarchyArgs,
} from './promotion.js';

describe('PROMOTION_SYSTEM_PROMPT', () => {
  it('names the promotion tool and the "one focused pass" trigger', () => {
    expect(PROMOTION_SYSTEM_PROMPT).toContain(CREATE_PRODUCTION_HIERARCHY);
    expect(PROMOTION_SYSTEM_PROMPT).toContain('single focused pass');
  });

  it('bounds the worker: stop the moment the promotion tool is called (no ramble)', () => {
    expect(PROMOTION_SYSTEM_PROMPT).toContain('you are finished');
    expect(PROMOTION_SYSTEM_PROMPT).toContain('output nothing after the tool call');
  });
});

describe('CREATE_PRODUCTION_HIERARCHY_TOOL', () => {
  it('is a well-formed OpenAI function tool with reason + divisions params', () => {
    const t = CREATE_PRODUCTION_HIERARCHY_TOOL;
    expect(t.type).toBe('function');
    expect(t.function.name).toBe(CREATE_PRODUCTION_HIERARCHY);
    // Description makes the WHEN explicit.
    expect(t.function.description.toLowerCase()).toContain('too large');

    const params = t.function.parameters as {
      type: string;
      required: string[];
      properties: Record<string, { type: string; items?: { required?: string[] } }>;
    };
    expect(params.type).toBe('object');
    expect(params.required).toEqual(expect.arrayContaining(['reason', 'divisions']));
    expect(params.properties.reason?.type).toBe('string');
    expect(params.properties.divisions?.type).toBe('array');
    expect(params.properties.divisions?.items?.required).toEqual(
      expect.arrayContaining(['name', 'purpose']),
    );
  });
});

describe('parseCreateHierarchyArgs', () => {
  it('accepts a well-formed call and trims whitespace', () => {
    const got = parseCreateHierarchyArgs({
      reason: '  too big  ',
      divisions: [{ name: '  Frontend ', purpose: ' the UI ' }],
    });
    expect(got).toEqual({
      reason: 'too big',
      divisions: [{ name: 'Frontend', purpose: 'the UI' }],
    });
  });

  it('drops division entries missing a name or purpose but keeps the good ones', () => {
    const got = parseCreateHierarchyArgs({
      reason: 'x',
      divisions: [
        { name: 'Backend', purpose: 'the API' },
        { name: '', purpose: 'no name' },
        { name: 'No purpose' },
        'garbage',
      ],
    });
    expect(got?.divisions).toEqual([{ name: 'Backend', purpose: 'the API' }]);
  });

  it('returns undefined when there is no usable division or the shape is wrong', () => {
    expect(parseCreateHierarchyArgs({ reason: 'x', divisions: [] })).toBeUndefined();
    expect(parseCreateHierarchyArgs({ reason: 'x', divisions: [{ name: '' }] })).toBeUndefined();
    expect(parseCreateHierarchyArgs({ reason: 'x' })).toBeUndefined();
    expect(parseCreateHierarchyArgs(null)).toBeUndefined();
    expect(parseCreateHierarchyArgs('nope')).toBeUndefined();
  });

  it('tolerates a missing reason (defaults to empty) when divisions are valid', () => {
    const got = parseCreateHierarchyArgs({ divisions: [{ name: 'A', purpose: 'p' }] });
    expect(got).toEqual({ reason: '', divisions: [{ name: 'A', purpose: 'p' }] });
  });
});

describe('applyCreateHierarchy', () => {
  const args: CreateHierarchyArgs = {
    reason: 'multi-part game',
    divisions: [
      { name: 'Frontend', purpose: 'the UI' },
      { name: '3D Assets', purpose: 'models and textures' },
    ],
  };

  it('builds a valid running chart: CEO + manager block + one node per division', () => {
    const chart = applyCreateHierarchy(null, args);
    expect(isOrgChart(chart)).toBe(true);
    expect(chart.status).toBe('running');
    expect(chart.projectId).toBe(DEFAULT_PROMOTION_PROJECT_ID);

    const ceo = chart.nodes.find((n) => n.role === 'ceo');
    const manager = chart.nodes.find((n) => n.role === 'manager');
    const divisions = chart.nodes.filter((n) => n.role === 'division');
    expect(ceo).toMatchObject({ id: 'ceo', promptId: 'ceo' });
    expect(manager).toMatchObject({ id: 'manager', parentId: 'ceo', promptId: 'manager' });
    expect(divisions).toHaveLength(2);
    // Manager block owns the divisions; purpose is carried as a light extension.
    for (const d of divisions) expect(d.parentId).toBe('manager');
    expect(divisions[0]).toMatchObject({ name: 'Frontend', promptExtension: 'the UI' });
    // Names slugify into readable, collision-free ids.
    expect(divisions[1]?.id).toBe('division-3d-assets');
  });

  it('marks every node idle', () => {
    const chart = applyCreateHierarchy(null, args);
    for (const node of chart.nodes) expect(chart.nodeStatus[node.id]).toBe('idle');
  });

  it('generates collision-free ids for duplicate/blank division names', () => {
    const chart = applyCreateHierarchy(null, {
      reason: 'r',
      divisions: [
        { name: 'Core', purpose: 'a' },
        { name: 'Core', purpose: 'b' },
        { name: '!!!', purpose: 'c' },
      ],
    });
    const ids = chart.nodes.filter((n) => n.role === 'division').map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length); // all unique
    expect(ids).toContain('division-core');
    expect(ids).toContain('division-core-2');
  });

  it('keeps the base project id and never mutates the base chart', () => {
    const base = emptyOrgChart('proj-99');
    const snapshot = structuredClone(base);
    const chart = applyCreateHierarchy(base, args);
    expect(chart.projectId).toBe('proj-99');
    expect(base).toEqual(snapshot); // base untouched (fresh chart built)
    expect(base.nodes).toHaveLength(0);
  });

  it('honors an explicit project id override', () => {
    const chart = applyCreateHierarchy(null, args, 'explicit-id');
    expect(chart.projectId).toBe('explicit-id');
  });
});
