/**
 * corp-store `situation` fold (the inline-corp-turn reframe): the store folds
 * the task's CoordinationEvent stream through `reduceSituation` exactly the way
 * `SituationRoomHost` does — same initial state (`initialSituation(taskId)`),
 * one fold per event — so `CorpInlineTurn` renders the identical state the
 * situation room would have. `setTask` starts every run clean.
 */
import { initialSituation, reduceSituation } from '@pi-desktop/canvas';
import type {
  ChecklistItem,
  CoordinationEvent,
  OrgChartView,
  OrgNodeView,
  WorkerActivityEvent,
} from '@pi-desktop/coordination';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendWorkerActivity,
  type CorpBlock,
  corpNodeElapsedMs,
  useCorpStore,
} from './corp-store';

const CHART: OrgChartView = {
  taskId: 't1',
  nodes: [
    { id: 'ceo', role: 'ceo', name: 'Pi', state: 'working' },
    {
      id: 'eng',
      role: 'engineer',
      name: 'Emitter',
      parentId: 'ceo',
      state: 'working',
      currentAction: 'writing emitter.ts',
    },
  ],
  edges: [],
};

const ITEMS: readonly ChecklistItem[] = [
  { id: 'c1', label: 'Renderer core', state: 'done' },
  { id: 'c2', label: 'Particle emitter', state: 'in-progress' },
];

const EVENTS: readonly CoordinationEvent[] = [
  { type: 'status', status: 'working' },
  { type: 'org-chart', chart: CHART },
  { type: 'checklist', items: ITEMS },
];

beforeEach(() => {
  useCorpStore.getState().setTask(null);
});

describe('useCorpStore.foldEvent (the inline corp turn state)', () => {
  it('folds events into a SituationState identical to the SituationRoomHost fold', () => {
    useCorpStore.getState().setTask('t1');
    for (const event of EVENTS) useCorpStore.getState().foldEvent(event);

    let expected = initialSituation('t1');
    for (const event of EVENTS) expected = reduceSituation(expected, event);

    expect(useCorpStore.getState().situation).toEqual(expected);
    expect(useCorpStore.getState().situation?.status).toBe('working');
    expect(useCorpStore.getState().situation?.chart.nodes).toHaveLength(2);
    expect(useCorpStore.getState().situation?.checklist).toHaveLength(2);
  });

  it('is null until the first event arrives, and seeds the initial state with the task id', () => {
    useCorpStore.getState().setTask('t1');
    expect(useCorpStore.getState().situation).toBeNull();

    useCorpStore.getState().foldEvent({ type: 'status', status: 'working' });
    // The seed is initialSituation(taskId) — the empty chart carries the id.
    expect(useCorpStore.getState().situation?.chart.taskId).toBe('t1');
  });

  it('setTask resets the previous run’s situation (each run starts clean)', () => {
    useCorpStore.getState().setTask('t1');
    useCorpStore.getState().foldEvent({ type: 'status', status: 'working' });
    expect(useCorpStore.getState().situation).not.toBeNull();

    useCorpStore.getState().setTask('t2');
    expect(useCorpStore.getState().situation).toBeNull();
  });
});

const wa = (fields: Omit<WorkerActivityEvent, 'type' | 'nodeId'>): WorkerActivityEvent => ({
  type: 'worker-activity',
  nodeId: 'ceo',
  ...fields,
});

describe('appendWorkerActivity (the PUSH block accumulator)', () => {
  it('grows ONE text block from start + deltas (per-token), settling on end', () => {
    let blocks: CorpBlock[] = [];
    blocks = appendWorkerActivity(blocks, wa({ kind: 'text', phase: 'start' }));
    blocks = appendWorkerActivity(blocks, wa({ kind: 'text', phase: 'delta', delta: 'Hello ' }));
    blocks = appendWorkerActivity(blocks, wa({ kind: 'text', phase: 'delta', delta: 'world' }));
    expect(blocks).toEqual([{ kind: 'text', text: 'Hello world', streaming: true }]);
    // `end` settles the SAME block (no duplicate), keeping the accumulated text.
    blocks = appendWorkerActivity(blocks, wa({ kind: 'text', phase: 'end' }));
    expect(blocks).toEqual([{ kind: 'text', text: 'Hello world', streaming: false }]);
  });

  it('keeps thinking + text as separate blocks and closes the tail when a tool starts', () => {
    let blocks: CorpBlock[] = [];
    blocks = appendWorkerActivity(blocks, wa({ kind: 'thinking', phase: 'start', delta: 'hmm' }));
    // A tool step closes the open reasoning tail and lands its own row.
    blocks = appendWorkerActivity(blocks, wa({ kind: 'tool', toolName: 'read', detail: 'x.ts' }));
    expect(blocks).toEqual([
      { kind: 'thinking', text: 'hmm', streaming: false },
      { kind: 'tool', toolName: 'read', detail: 'x.ts' },
    ]);
  });

  it('accumulates a file row’s +N/−N across repeat writes to the same path', () => {
    let blocks: CorpBlock[] = [];
    blocks = appendWorkerActivity(blocks, wa({ kind: 'file', path: 'src/x.ts', addedLines: 3 }));
    blocks = appendWorkerActivity(
      blocks,
      wa({ kind: 'file', path: 'src/x.ts', addedLines: 2, removedLines: 1 }),
    );
    expect(blocks).toEqual([{ kind: 'file', path: 'src/x.ts', addedLines: 5, removedLines: 1 }]);
  });

  it('carries the written BODY end-to-end (C1): the file block keeps its content', () => {
    let blocks: CorpBlock[] = [];
    // The write's START opens the row (path only, no body yet)…
    blocks = appendWorkerActivity(blocks, wa({ kind: 'file', path: 'src/x.ts', label: 'Writing' }));
    // …its COMPLETION lands the authoritative +N AND the whole captured body, which
    // the live file canvas renders — folded onto the SAME row, not a new one.
    blocks = appendWorkerActivity(
      blocks,
      wa({ kind: 'file', path: 'src/x.ts', addedLines: 3, content: 'a\nb\nc' }),
    );
    expect(blocks).toEqual([
      {
        kind: 'file',
        path: 'src/x.ts',
        label: 'Writing',
        addedLines: 3,
        removedLines: 0,
        content: 'a\nb\nc',
      },
    ]);
    // A newer body to the same tail path wins; a body-less tick keeps the last body.
    blocks = appendWorkerActivity(
      blocks,
      wa({ kind: 'file', path: 'src/x.ts', addedLines: 1, content: 'a\nb\nc\nd' }),
    );
    expect((blocks[0] as Extract<CorpBlock, { kind: 'file' }>).content).toBe('a\nb\nc\nd');
    blocks = appendWorkerActivity(blocks, wa({ kind: 'file', path: 'src/x.ts', addedLines: 1 }));
    expect((blocks[0] as Extract<CorpBlock, { kind: 'file' }>).content).toBe('a\nb\nc\nd');
  });

  it('folds a bash command’s streamed output onto the SAME tool row (no duplicate)', () => {
    let blocks: CorpBlock[] = [];
    // The command lands first (no output), then its result arrives (partial → final)
    // — all folded onto ONE bash row whose `output` is replaced in place as it grows.
    blocks = appendWorkerActivity(
      blocks,
      wa({ kind: 'tool', toolName: 'bash', detail: 'npm run build' }),
    );
    blocks = appendWorkerActivity(
      blocks,
      wa({ kind: 'tool', toolName: 'bash', detail: 'npm run build', output: 'compiling…' }),
    );
    blocks = appendWorkerActivity(
      blocks,
      wa({
        kind: 'tool',
        toolName: 'bash',
        detail: 'npm run build',
        output: 'compiling…\nBuild OK',
      }),
    );
    expect(blocks).toEqual([
      { kind: 'tool', toolName: 'bash', detail: 'npm run build', output: 'compiling…\nBuild OK' },
    ]);
  });

  it('seeds a tool row from an output update that outran its start', () => {
    // If the result arrives with no matching row yet, a row is created carrying it.
    const blocks = appendWorkerActivity([], wa({ kind: 'tool', toolName: 'bash', output: 'hi' }));
    expect(blocks).toEqual([{ kind: 'tool', toolName: 'bash', output: 'hi' }]);
  });

  it('foldWorkerActivity keys blocks by nodeId and gives a fresh array per delta', () => {
    useCorpStore.getState().setTask('t1');
    const fold = useCorpStore.getState().foldWorkerActivity;
    fold({ type: 'worker-activity', nodeId: 'eng-1', kind: 'text', phase: 'delta', delta: 'a' });
    const first = useCorpStore.getState().workerBlocks['eng-1'];
    fold({ type: 'worker-activity', nodeId: 'eng-1', kind: 'text', phase: 'delta', delta: 'b' });
    const second = useCorpStore.getState().workerBlocks['eng-1'];
    expect(second).not.toBe(first); // new ref → the shown-node selector re-renders
    expect(second?.[0]).toMatchObject({ kind: 'text', text: 'ab' });
    // A different node keeps its own bucket.
    fold({ type: 'worker-activity', nodeId: 'eng-2', kind: 'text', phase: 'delta', delta: 'z' });
    expect(useCorpStore.getState().workerBlocks['eng-2']?.[0]).toMatchObject({ text: 'z' });
    // setTask clears every node's blocks.
    useCorpStore.getState().setTask('t2');
    expect(useCorpStore.getState().workerBlocks).toEqual({});
  });
});

// A chart with two subagents at chosen states (STEP 1 timing transitions).
const timingChart = (aState: OrgNodeView['state'], bState: OrgNodeView['state']): OrgChartView => ({
  taskId: 't1',
  nodes: [
    { id: 'ceo', role: 'ceo', name: 'Pi', state: 'working' },
    { id: 'a', role: 'engineer', name: 'A', parentId: 'ceo', state: aState },
    { id: 'b', role: 'engineer', name: 'B', parentId: 'ceo', state: bState },
  ],
  edges: [],
});

describe('trackChart per-node timing (STEP 1)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('stamps startedAt when a node first enters working (once), finishedAt on working→done', () => {
    const now = vi.spyOn(Date, 'now');
    useCorpStore.getState().setTask('t1');

    // A enters working at t=1000; B is still idle → no timing for B.
    now.mockReturnValue(1000);
    useCorpStore.getState().trackChart(timingChart('working', 'idle'));
    let timing = useCorpStore.getState().nodeTiming;
    expect(timing.a).toEqual({ startedAt: 1000 });
    expect(timing.b).toBeUndefined();

    // A still working at t=5000 → startedAt is NOT re-stamped (idempotent).
    now.mockReturnValue(5000);
    useCorpStore.getState().trackChart(timingChart('working', 'idle'));
    timing = useCorpStore.getState().nodeTiming;
    expect(timing.a).toEqual({ startedAt: 1000 });

    // A leaves working → done at t=9000 → finishedAt lands once.
    now.mockReturnValue(9000);
    useCorpStore.getState().trackChart(timingChart('done', 'idle'));
    timing = useCorpStore.getState().nodeTiming;
    expect(timing.a).toEqual({ startedAt: 1000, finishedAt: 9000 });

    // A stays done at t=12000 → finishedAt is NOT re-stamped.
    now.mockReturnValue(12000);
    useCorpStore.getState().trackChart(timingChart('done', 'idle'));
    expect(useCorpStore.getState().nodeTiming.a).toEqual({ startedAt: 1000, finishedAt: 9000 });
  });

  it('never stamps finishedAt for a node that reaches done without ever working', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(2000);
    useCorpStore.getState().setTask('t1');
    // B goes straight to done — no startedAt was ever recorded → no timing at all.
    useCorpStore.getState().trackChart(timingChart('working', 'done'));
    expect(useCorpStore.getState().nodeTiming.b).toBeUndefined();
    expect(now).toHaveBeenCalled();
  });

  it('keeps the SAME nodeTiming object when nothing transitioned (referential signal)', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    useCorpStore.getState().setTask('t1');
    useCorpStore.getState().trackChart(timingChart('working', 'idle'));
    const first = useCorpStore.getState().nodeTiming;
    // Same states again → no stamp → same object reference (no needless re-render).
    useCorpStore.getState().trackChart(timingChart('working', 'idle'));
    expect(useCorpStore.getState().nodeTiming).toBe(first);
  });

  it('corpNodeElapsedMs: live = now − startedAt; frozen = finishedAt − startedAt; else undefined', () => {
    const s = { nodeTiming: { a: { startedAt: 1000 }, b: { startedAt: 1000, finishedAt: 4000 } } };
    expect(corpNodeElapsedMs(s, 'a', 6000)).toBe(5000); // live
    expect(corpNodeElapsedMs(s, 'b', 999999)).toBe(3000); // frozen (now ignored)
    expect(corpNodeElapsedMs(s, 'missing', 6000)).toBeUndefined();
  });

  it('auto-returns: a pinned node finishing (working→done) drops the pin (STEP 5)', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    useCorpStore.getState().setTask('t1');
    const working = timingChart('working', 'idle');
    useCorpStore.getState().trackChart(working);
    // Pin the working node A.
    const a = working.nodes.find((n) => n.id === 'a') as OrgNodeView;
    useCorpStore.getState().selectNode(a);
    expect(useCorpStore.getState().pinnedNode?.id).toBe('a');

    // A finishes → the pin auto-drops (followLive).
    useCorpStore.getState().trackChart(timingChart('done', 'idle'));
    expect(useCorpStore.getState().pinnedNode).toBeNull();
  });

  it('a pinned node still working is kept (no spurious auto-return)', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    useCorpStore.getState().setTask('t1');
    const working = timingChart('working', 'idle');
    useCorpStore.getState().trackChart(working);
    useCorpStore.getState().selectNode(working.nodes.find((n) => n.id === 'a') as OrgNodeView);
    // B advances but A keeps working → the pin on A stays.
    useCorpStore.getState().trackChart(timingChart('working', 'working'));
    expect(useCorpStore.getState().pinnedNode?.id).toBe('a');
  });
});
