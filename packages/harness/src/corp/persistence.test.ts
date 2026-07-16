import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyOrgChart, type OrgChart } from './org-chart.js';
import {
  loadOrgChart,
  makeNodeOrgChartFs,
  ORG_CHART_RELATIVE_PATH,
  ORG_CHART_SCHEMA_VERSION,
  type OrgChartFs,
  orgChartPath,
  parseOrgChart,
  saveOrgChart,
  serializeOrgChart,
} from './persistence.js';

/** A fully-populated chart so the round-trip exercises every field, not just the empty case. */
function sampleChart(): OrgChart {
  return {
    projectId: 'proj-1',
    nodes: [
      { id: 'ceo', role: 'ceo', name: 'CEO' },
      { id: 'mgr', role: 'manager', name: 'Manager', parentId: 'ceo', promptId: 'manager' },
      {
        id: 'fe',
        role: 'division',
        name: 'Frontend',
        parentId: 'mgr',
        promptId: 'frontend-dev',
        promptExtension: 'use design tokens',
      },
    ],
    contracts: [
      {
        id: 'c1',
        title: 'Scaffold',
        ownerNodeId: 'fe',
        input: 'in',
        output: 'out',
        slot: 'src/app.tsx',
        available: { tools: ['read', 'write'], imports: ['@pi-desktop/ui'] },
        reviewRubric: 'renders',
        dependsOn: [],
        workspace: 'shared',
        status: 'merged',
      },
    ],
    queue: [{ from: 'c1', to: 'c2' }],
    branches: [{ nodeId: 'fe', branch: 'fe-work', worktreePath: '/tmp/wt' }],
    status: 'running',
    nodeStatus: { ceo: 'idle', fe: 'working' },
  };
}

/** In-memory fs seam so the load/save wiring is testable without touching disk. */
function memFs(): { fs: OrgChartFs; store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    fs: {
      readText: (path) => store.get(path),
      writeText: (path, text) => {
        store.set(path, text);
      },
    },
  };
}

describe('orgChartPath', () => {
  it('joins the project dir with the .pi project-data location', () => {
    expect(orgChartPath('/work/proj')).toBe(`/work/proj/${ORG_CHART_RELATIVE_PATH}`);
  });
});

describe('serialize/parse (pure)', () => {
  it('round-trips a fully-populated chart', () => {
    expect(parseOrgChart(serializeOrgChart(sampleChart()))).toEqual(sampleChart());
  });

  it('writes a pretty, version-stamped, newline-terminated envelope', () => {
    const text = serializeOrgChart(emptyOrgChart('p'));
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('\n  '); // 2-space pretty indent
    const decoded = JSON.parse(text) as { version: number; chart: OrgChart };
    expect(decoded.version).toBe(ORG_CHART_SCHEMA_VERSION);
    expect(decoded.chart).toEqual(emptyOrgChart('p'));
  });

  it('returns undefined for non-JSON (a corrupt chart must never crash a resume)', () => {
    expect(parseOrgChart('{ not json')).toBeUndefined();
    expect(parseOrgChart('')).toBeUndefined();
    expect(parseOrgChart('null')).toBeUndefined();
    expect(parseOrgChart('42')).toBeUndefined();
  });

  it('returns undefined when the envelope shape is wrong', () => {
    expect(parseOrgChart(JSON.stringify({ chart: emptyOrgChart('p') }))).toBeUndefined(); // no version
    expect(
      parseOrgChart(JSON.stringify({ version: ORG_CHART_SCHEMA_VERSION, chart: { bogus: true } })),
    ).toBeUndefined(); // chart fails isOrgChart
  });

  it('refuses a future schema version rather than misreading it', () => {
    const future = JSON.stringify({
      version: ORG_CHART_SCHEMA_VERSION + 1,
      chart: emptyOrgChart('p'),
    });
    expect(parseOrgChart(future)).toBeUndefined();
  });
});

describe('load/save over an injected fs seam', () => {
  it('round-trips save → load through the seam', () => {
    const { fs, store } = memFs();
    saveOrgChart('/work/proj', sampleChart(), fs);
    expect([...store.keys()]).toEqual([orgChartPath('/work/proj')]);
    expect(loadOrgChart('/work/proj', fs)).toEqual(sampleChart());
  });

  it('returns undefined when no chart exists yet', () => {
    expect(loadOrgChart('/work/proj', memFs().fs)).toBeUndefined();
  });

  it('returns undefined (never throws) when the stored file is corrupt', () => {
    const { fs, store } = memFs();
    store.set(orgChartPath('/work/proj'), 'garbage');
    expect(loadOrgChart('/work/proj', fs)).toBeUndefined();
  });
});

describe('makeNodeOrgChartFs (real disk)', () => {
  const dirs: string[] = [];
  const scratch = () => {
    const d = mkdtempSync(join(tmpdir(), 'corp-persist-'));
    dirs.push(d);
    return d;
  };

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('creates parent dirs and writes atomically (no .tmp left behind)', () => {
    const dir = scratch();
    const fs = makeNodeOrgChartFs();
    const path = orgChartPath(dir); // includes a .pi/ subdir that must be created
    fs.writeText(path, 'hello');
    expect(existsSync(path)).toBe(true);
    expect(fs.readText(path)).toBe('hello');
    // Atomic write = temp file + rename; nothing dangling once it returns.
    expect(readdirSync(join(dir, '.pi')).some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('overwrites an existing chart in place', () => {
    const dir = scratch();
    const fs = makeNodeOrgChartFs();
    saveOrgChart(dir, emptyOrgChart('p1'), fs);
    saveOrgChart(dir, sampleChart(), fs);
    expect(loadOrgChart(dir, fs)).toEqual(sampleChart());
  });

  it('reads back undefined for an absent file instead of throwing', () => {
    expect(makeNodeOrgChartFs().readText(join(scratch(), 'nope.json'))).toBeUndefined();
  });

  it('save → load round-trips against the default node fs', () => {
    const dir = scratch();
    saveOrgChart(dir, sampleChart());
    expect(loadOrgChart(dir)).toEqual(sampleChart());
  });
});
