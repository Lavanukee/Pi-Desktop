import type {
  Activity,
  ChecklistItem,
  CoordinationEvent,
  OrgChartView,
  OrgNodeView,
} from '@pi-desktop/coordination';
import { describe, expect, it } from 'vitest';
import {
  contractProgress,
  crossGroupWaits,
  fillModuleRegions,
  followTarget,
  formatEta,
  groupChecklist,
  initialSituation,
  reduceSituation,
  type SituationState,
  workingCount,
} from './situation-model.ts';

function fold(events: readonly CoordinationEvent[], start?: SituationState): SituationState {
  return events.reduce(reduceSituation, start ?? initialSituation('t1'));
}

function touch(path: string, timestamp = 1000): CoordinationEvent {
  const activity: Activity = { kind: 'file-touch', summary: `wrote ${path}`, path, timestamp };
  return { type: 'activity', activity };
}

describe('reduceSituation', () => {
  it('folds status, eta, artifacts and done', () => {
    const state = fold([
      { type: 'status', status: 'planning', detail: 'forming' },
      { type: 'eta', eta: { lowMinutes: 20, highMinutes: 40, confidence: 'low' } },
      {
        type: 'artifact',
        artifact: { id: 'a1', title: 'v0.1', kind: 'html', timestamp: 5 },
      },
      { type: 'done', result: { outcome: 'completed', summary: 'shipped' } },
    ]);
    expect(state.status).toBe('done');
    expect(state.eta?.highMinutes).toBe(40);
    expect(state.artifacts).toHaveLength(1);
    expect(state.result?.summary).toBe('shipped');
  });

  it('maps aborted/failed outcomes onto terminal statuses', () => {
    expect(fold([{ type: 'done', result: { outcome: 'aborted' } }]).status).toBe('aborted');
    expect(fold([{ type: 'done', result: { outcome: 'failed', error: 'x' } }]).status).toBe(
      'error',
    );
  });

  it('deduplicates file touches by path and keeps the latest touch time', () => {
    const state = fold([touch('src/a.ts', 100), touch('src/b.ts', 200), touch('src/a.ts', 300)]);
    expect(state.files).toHaveLength(2);
    expect(state.files[0]).toMatchObject({ path: 'src/a.ts', touches: 2, lastTouch: 300 });
    expect(state.activityCount).toBe(3);
  });

  it('tracks the file-touch lifecycle: active while start/progress, deltas accumulate', () => {
    const at = (phase: 'start' | 'progress' | 'end', added?: number, removed?: number) =>
      ({
        type: 'activity',
        activity: {
          kind: 'file-touch',
          summary: `${phase} src/a.ts`,
          path: 'src/a.ts',
          phase,
          ...(added !== undefined ? { linesAdded: added } : {}),
          ...(removed !== undefined ? { linesRemoved: removed } : {}),
          timestamp: 100,
        },
      }) satisfies CoordinationEvent;

    const started = fold([at('start')]);
    expect(started.files[0]).toMatchObject({ path: 'src/a.ts', active: true, added: 0 });

    const mid = fold([at('progress', 40, 3)], started);
    expect(mid.files[0]).toMatchObject({
      active: true,
      added: 40,
      removed: 3,
      lastDeltaAdded: 40,
    });

    const done = fold([at('end', 24, 1)], mid);
    expect(done.files[0]).toMatchObject({ active: false, added: 64, removed: 4, touches: 3 });
  });

  it('folds exercise sessions (the browse/test/run activity panel)', () => {
    const running = fold([
      {
        type: 'exercise',
        session: { id: 'x1', kind: 'test', status: 'running', title: 'Running the test suite' },
      },
    ]);
    expect(running.exercise?.status).toBe('running');
    const passed = fold(
      [
        {
          type: 'exercise',
          session: { id: 'x1', kind: 'test', status: 'passed', title: 'Running the test suite' },
        },
      ],
      running,
    );
    expect(passed.exercise?.status).toBe('passed');
  });

  it('ignores permission events (app chrome, not room content)', () => {
    const base = initialSituation('t1');
    const state = reduceSituation(base, {
      type: 'permission',
      request: { id: 'p1', kind: 'git', summary: 'use git?' },
    });
    expect(state).toBe(base);
  });
});

describe('derived readings', () => {
  const checklist: ChecklistItem[] = [
    { id: 'a1', label: 'A one', group: 'Alpha', state: 'done' },
    { id: 'a2', label: 'A two', group: 'Alpha', state: 'in-progress', dependsOn: ['a1'] },
    { id: 'b1', label: 'B one', group: 'Beta', state: 'queued', dependsOn: ['a2'] },
  ];

  it('counts contract progress from checklist state only', () => {
    const state = fold([{ type: 'checklist', items: checklist }]);
    expect(contractProgress(state)).toEqual({ done: 1, total: 3 });
  });

  it('groups the checklist by division in first-seen order', () => {
    const groups = groupChecklist(checklist);
    expect(groups.map((g) => g.name)).toEqual(['Alpha', 'Beta']);
    expect(groups[0]?.done).toBe(1);
  });

  it('exposes cross-division waits until the dependency completes', () => {
    expect(crossGroupWaits(checklist[2] as ChecklistItem, checklist)).toEqual(['Alpha']);
    // Same-division deps are not "cross" waits.
    expect(crossGroupWaits(checklist[1] as ChecklistItem, checklist)).toEqual([]);
    // A merged dependency stops being a wait.
    const resolved = checklist.map((c) => (c.id === 'a2' ? { ...c, state: 'done' as const } : c));
    expect(crossGroupWaits(resolved[2] as ChecklistItem, resolved)).toEqual([]);
  });

  it('fills module regions by longest path prefix', () => {
    const state = fold([
      {
        type: 'org-chart',
        chart: {
          taskId: 't1',
          nodes: [],
          edges: [],
          modules: [
            { path: 'src/', owner: 'Core' },
            { path: 'src/ui/', owner: 'UI' },
          ],
        },
      },
      touch('src/loop.ts'),
      touch('src/ui/hud.tsx'),
    ]);
    const regions = fillModuleRegions(state);
    expect(regions.find((r) => r.path === 'src/')?.files.map((f) => f.path)).toEqual([
      'src/loop.ts',
    ]);
    expect(regions.find((r) => r.path === 'src/ui/')?.files.map((f) => f.path)).toEqual([
      'src/ui/hud.tsx',
    ]);
  });

  it('formats the ETA as an honest range, never a countdown', () => {
    expect(formatEta(undefined)).toBe('');
    expect(formatEta({ lowMinutes: 12, highMinutes: 18 })).toBe('~12–18 min left');
    expect(formatEta({ lowMinutes: 3, highMinutes: 3 })).toBe('~3 min left');
    expect(formatEta({ lowMinutes: 0.2, highMinutes: 0.8 })).toBe('under a minute left');
  });
});

describe('action feed (the live "Area · current action" rows)', () => {
  const chartWith = (nodes: OrgNodeView[]): CoordinationEvent => ({
    type: 'org-chart',
    chart: {
      taskId: 't1',
      nodes,
      edges: [],
    },
  });
  const div: OrgNodeView = { id: 'div-a', role: 'division', name: 'Core Engine', state: 'idle' };
  const eng = (state: OrgNodeView['state'], currentAction?: string): OrgNodeView => ({
    id: 'e1',
    role: 'engineer',
    name: 'Core Engine builder 1',
    parentId: 'div-a',
    state,
    ...(currentAction !== undefined ? { currentAction } : {}),
  });

  it('opens a row per working node action, labeled by its AREA', () => {
    const state = fold([chartWith([div, eng('working', 'Writing src/engine/renderer.ts')])]);
    expect(state.actionFeed).toHaveLength(1);
    expect(state.actionFeed[0]).toMatchObject({
      nodeId: 'e1',
      area: 'Core Engine',
      action: 'Writing src/engine/renderer.ts',
      done: false,
    });
  });

  it('a changed action closes the old row and opens a new one at the bottom', () => {
    const state = fold([
      chartWith([div, eng('working', 'thinking')]),
      chartWith([div, eng('working', 'Writing src/engine/renderer.ts')]),
    ]);
    expect(state.actionFeed.map((r) => [r.action, r.done])).toEqual([
      ['thinking', true],
      ['Writing src/engine/renderer.ts', false],
    ]);
    // Stable identity: the seq advances per opened row.
    expect(state.actionFeed[1]?.seq).toBeGreaterThan(state.actionFeed[0]?.seq as number);
  });

  it('an unchanged action across chart pulses does NOT churn the feed', () => {
    const one = fold([chartWith([div, eng('working', 'thinking')])]);
    const two = fold([chartWith([div, eng('working', 'thinking')])], one);
    expect(two.actionFeed).toHaveLength(1);
  });

  it('a node leaving `working` settles its open row (spinner → done)', () => {
    const state = fold([
      chartWith([div, eng('working', 'thinking')]),
      chartWith([div, eng('done')]),
    ]);
    expect(state.actionFeed).toEqual([expect.objectContaining({ action: 'thinking', done: true })]);
  });

  it('activities fill in for charts without currentAction — only for working nodes', () => {
    const at = (summary: string, phase?: 'start' | 'progress' | 'end'): CoordinationEvent => ({
      type: 'activity',
      activity: {
        nodeId: 'e1',
        kind: 'file-touch',
        summary,
        path: 'src/a.ts',
        ...(phase !== undefined ? { phase } : {}),
        timestamp: 100,
      },
    });
    // Node idle → no row (honest: never a live row for a settled node).
    const idle = fold([chartWith([div, eng('idle')]), at('Writing src/a.ts', 'start')]);
    expect(idle.actionFeed).toHaveLength(0);
    // Working → the activity opens the row; phase `end` settles it, no new row.
    const state = fold([
      chartWith([div, eng('working')]),
      at('Writing src/a.ts', 'start'),
      at('Writing src/a.ts', 'progress'), // identical text → no churn
      at('Finished src/a.ts', 'end'),
    ]);
    expect(state.actionFeed).toEqual([
      expect.objectContaining({ area: 'Core Engine', action: 'Writing src/a.ts', done: true }),
    ]);
  });

  it('the terminal done event settles every open row', () => {
    const state = fold([
      chartWith([div, eng('working', 'thinking')]),
      { type: 'done', result: { outcome: 'completed' } },
    ]);
    expect(state.actionFeed.every((r) => r.done)).toBe(true);
  });
});

describe('followTarget (the never-blank auto-follow)', () => {
  const node = (
    id: string,
    role: OrgNodeView['role'],
    state: OrgNodeView['state'],
    parentId?: string,
  ): OrgNodeView => ({
    id,
    role,
    name: id,
    state,
    ...(parentId !== undefined ? { parentId } : {}),
  });

  const chart = (nodes: OrgNodeView[]): OrgChartView => ({
    taskId: 't1',
    nodes,
    edges: [],
  });

  it('picks the top-most working node (the lead forming the vision first)', () => {
    const c = chart([node('root', 'solo', 'working')]);
    expect(followTarget(c)?.id).toBe('root');
  });

  it('moves down to the running builder once the lead goes idle', () => {
    const c = chart([
      node('root', 'ceo', 'idle'),
      node('div-a', 'division', 'idle', 'root'),
      node('e1', 'engineer', 'working', 'div-a'),
    ]);
    expect(followTarget(c, 'root')?.id).toBe('e1');
  });

  it('is sticky: a parallel sibling starting does not steal the pane', () => {
    const c = chart([node('e1', 'engineer', 'working'), node('e2', 'engineer', 'working')]);
    expect(followTarget(c, 'e2')?.id).toBe('e2');
  });

  it('stays on the producing builder while the lead idly coordinates (always streaming)', () => {
    // The lead staying "working" (coordinating) must NOT pull the pane off the
    // engineer that is actually producing output — otherwise the chat goes static.
    const c = chart([node('root', 'ceo', 'working'), node('e1', 'engineer', 'working')]);
    expect(followTarget(c, 'e1')?.id).toBe('e1');
  });

  it('descends into the builder even from the lead (follows the deepest producer)', () => {
    const c = chart([node('root', 'ceo', 'working'), node('e1', 'engineer', 'working')]);
    expect(followTarget(c, 'root')?.id).toBe('e1');
  });

  it('keeps the previous node when nothing is running (never blank)', () => {
    const c = chart([node('root', 'ceo', 'idle'), node('e1', 'engineer', 'idle')]);
    expect(followTarget(c, 'e1')?.id).toBe('e1');
    expect(followTarget(chart([]), undefined)).toBeUndefined();
  });

  it('counts only actually-working nodes for the live summary', () => {
    const c = chart([
      node('root', 'ceo', 'idle'),
      node('e1', 'engineer', 'working'),
      node('e2', 'engineer', 'done'),
    ]);
    expect(workingCount(c)).toBe(1);
  });
});
