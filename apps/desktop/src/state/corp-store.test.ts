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
  WorkerActivityEvent,
} from '@pi-desktop/coordination';
import { beforeEach, describe, expect, it } from 'vitest';
import { appendWorkerActivity, type CorpBlock, useCorpStore } from './corp-store';

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
