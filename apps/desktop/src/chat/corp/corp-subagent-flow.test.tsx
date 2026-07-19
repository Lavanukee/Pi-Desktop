// @vitest-environment jsdom
/**
 * The corp/subagent-run UX flow (Points 1–6), driven end-to-end against a REAL
 * corp store + canvas controller (no engine, no app launch). One scripted run —
 * a promotion (CEO + node A + node B), A working then done, B idle — proves:
 *
 *  1. the chat shows the CEO "Waiting for N…" indicator when nothing is pinned;
 *  2. clicking that indicator focuses the situation-room canvas tab;
 *  3. a subagent row shows a live m:ss timer that freezes into "finished in Nm Ns";
 *  4. selecting node A pins it AND scopes the canvas to its live surface;
 *  5. a not-started node B reads "Not yet queued" with its contract still shown;
 *  6. when the pinned node A finishes, the pin auto-drops (return to overview).
 */
import {
  CanvasProvider,
  createCanvasController,
  initialSituation,
  reduceSituation,
  SituationRoomSurface,
  type SituationState,
} from '@pi-desktop/canvas';
import type {
  CoordinationEvent,
  OrgChartView,
  OrgNodeView,
  WorkerTranscriptView,
} from '@pi-desktop/coordination';
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCorpStore } from '../../state/corp-store';
import { focusSituationTab, selectCorpNodeAndFocus } from '../canvas/corp-canvas-routing';
import { CorpInlineTurn } from './CorpInlineTurn';
import { CorpWorkerFeed } from './CorpWorkerPane';
import { corpChatView, corpPeekAvailable } from './corp-thread-view';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// SituationRoomSurface measures its width via ResizeObserver — stub it for jsdom.
if (typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver === 'undefined') {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

// ---------------------------------------------------------------------------
// Fixtures — a promoted run: CEO + a working builder A + an idle builder B.
// ---------------------------------------------------------------------------

const A_WORKING: OrgNodeView = {
  id: 'a',
  role: 'engineer',
  name: 'Emitter',
  parentId: 'ceo',
  state: 'working',
  currentAction: 'writing emitter.ts',
};
const A_DONE: OrgNodeView = { ...A_WORKING, state: 'done', currentAction: undefined };
const B_IDLE: OrgNodeView = {
  id: 'b',
  role: 'engineer',
  name: 'HUD',
  parentId: 'ceo',
  state: 'idle',
};

function chart(a: OrgNodeView): OrgChartView {
  return {
    taskId: 't1',
    nodes: [{ id: 'ceo', role: 'ceo', name: 'Pi', state: 'working' }, a, B_IDLE],
    edges: [
      { from: 'ceo', to: 'a' },
      { from: 'ceo', to: 'b' },
    ],
  };
}

const PROMOTED_EVENTS: readonly CoordinationEvent[] = [
  { type: 'status', status: 'working' },
  { type: 'org-chart', chart: chart(A_WORKING) },
  {
    type: 'checklist',
    items: [
      { id: 'c1', label: 'Renderer core', state: 'done' },
      { id: 'c2', label: 'Particle emitter', state: 'in-progress' },
    ],
  },
];

function foldSituation(events: readonly CoordinationEvent[]): SituationState {
  let s = initialSituation('t1');
  for (const e of events) s = reduceSituation(s, e);
  return s;
}

// ---------------------------------------------------------------------------
// react-dom + act() render harness (the repo's plain pattern).
// ---------------------------------------------------------------------------

interface RenderResult {
  container: HTMLElement;
  rerender: (node: ReactNode) => Promise<void>;
  unmount: () => Promise<void>;
}

async function render(node: ReactNode): Promise<RenderResult> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  return {
    container,
    async rerender(next) {
      await act(async () => {
        root.render(next);
      });
    },
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

const fetchNone = (): Promise<WorkerTranscriptView | null> => Promise.resolve(null);

beforeEach(() => {
  (window as unknown as { piDesktop: unknown }).piDesktop = { invoke: () => Promise.resolve({}) };
  useCorpStore.getState().setTask('t1');
});
afterEach(() => {
  useCorpStore.getState().setTask(null);
  vi.restoreAllMocks();
});

describe('corp/subagent-run UX flow', () => {
  it('(1) shows the CEO "Waiting for N…" indicator when the team formed and nothing is pinned', async () => {
    const situation = foldSituation(PROMOTED_EVENTS);
    // The thread decision (pure): promoted + unpinned → the waiting indicator,
    // NOT an auto-followed leaf (even though a live worker exists).
    const view = corpChatView({
      taskId: 't1',
      situation,
      liveNode: A_WORKING,
      pinnedNode: null,
    });
    expect(view).toEqual({ kind: 'waiting' });

    const { container, unmount } = await render(
      <CorpInlineTurn
        taskId="t1"
        state={situation}
        fetchTranscript={fetchNone}
        peekAvailable={corpPeekAvailable(situation)}
      />,
    );
    expect(container.textContent).toContain('Waiting for 1 of 2 tasks to finish');
    await unmount();
  });

  it('(2) clicking the waiting indicator focuses the situation-room canvas tab', async () => {
    const controller = createCanvasController();
    const situationId = controller.upsertTab('situation:t1', {
      kind: 'situation',
      title: 'Situation room',
      situationTaskId: 't1',
    });
    // Focus lives elsewhere first, so the jump-back is observable.
    const otherId = controller.openTab({ kind: 'terminal', title: 'Terminal' });
    expect(controller.getState().activeTabId).toBe(otherId);

    const { container, unmount } = await render(
      <CorpInlineTurn
        taskId="t1"
        state={foldSituation(PROMOTED_EVENTS)}
        fetchTranscript={fetchNone}
        peekAvailable={false}
        onFocusSituation={() => focusSituationTab(controller, 't1')}
      />,
    );
    await act(async () => {
      (container.querySelector('[data-testid="corp-inline-summary"]') as HTMLElement).click();
    });
    expect(controller.getState().activeTabId).toBe(situationId);
    await unmount();
  });

  it('(3) a subagent row shows a live m:ss timer that freezes into "finished in Nm Ns"', async () => {
    // Freeze the clock: A started at t=1000, "now" is t=6000 → 5s elapsed.
    vi.spyOn(Date, 'now').mockReturnValue(6000);
    const workingState = reduceSituation(initialSituation('t1'), {
      type: 'org-chart',
      chart: chart(A_WORKING),
    });
    const { container, rerender, unmount } = await render(
      <SituationRoomSurface state={workingState} nodeTiming={{ a: { startedAt: 1000 } }} />,
    );
    // While working: the live m:ss timer chip on A's row reads 0:05.
    const timer = container.querySelector('[data-node-id="a"] [data-testid="subagent-timer"]');
    expect(timer?.textContent).toBe('0:05');

    // A finishes: 125s span (started 1000 → finished 126000). The chip is gone
    // and the row's status FREEZES into "finished in 2m 5s".
    const doneState = reduceSituation(initialSituation('t1'), {
      type: 'org-chart',
      chart: chart(A_DONE),
    });
    await rerender(
      <SituationRoomSurface
        state={doneState}
        nodeTiming={{ a: { startedAt: 1000, finishedAt: 126000 } }}
      />,
    );
    const doneRow = container.querySelector('[data-node-id="a"]');
    expect(doneRow?.textContent).toContain('finished in 2m 5s');
    expect(doneRow?.querySelector('[data-testid="subagent-timer"]')).toBeNull();
    await unmount();
  });

  it('(4) selecting node A pins it and scopes the canvas to its live surface', async () => {
    const controller = createCanvasController();
    const situationId = controller.upsertTab('situation:t1', {
      kind: 'situation',
      title: 'Situation room',
    });
    // A has written a file — its most-recent live surface (a corpfile tab).
    useCorpStore.getState().foldWorkerActivity({
      type: 'worker-activity',
      nodeId: 'a',
      kind: 'file',
      path: 'src/a.ts',
      addedLines: 3,
    });
    const fileId = controller.upsertTab('corpfile:src/a.ts', {
      kind: 'file',
      key: 'corpfile:src/a.ts',
      title: 'a.ts',
    });
    // Move focus to the situation tab (off the file tab), then click A's row.
    controller.focusTab(situationId);
    expect(controller.getState().activeTabId).toBe(situationId);

    selectCorpNodeAndFocus(controller, 't1', A_WORKING);
    // Pinned in the store (the chat pane drills into it) …
    expect(useCorpStore.getState().pinnedNode?.id).toBe('a');
    // … and the canvas scoped to A's file tab.
    expect(controller.getState().activeTabId).toBe(fileId);
  });

  it('(5) a not-started node B reads "Not yet queued" with its contract still shown', async () => {
    const briefingOnly: WorkerTranscriptView = {
      nodeId: 'b',
      role: 'engineer',
      briefing: {
        workerName: 'HUD',
        roleLine: 'Builder',
        title: 'Build the HUD overlay',
        goal: 'Deliver src/ui/hud.ts against its contract.',
        deliverables: ['src/ui/hud.ts'],
      },
      lines: [],
    };
    const { container, unmount } = await render(
      <CanvasProvider>
        <CorpWorkerFeed
          transcript={briefingOnly}
          working={false}
          loading={false}
          nodeState="idle"
        />
      </CanvasProvider>,
    );
    // The contract briefing is still shown …
    expect(container.textContent).toContain('Build the HUD overlay');
    // … and the honest not-yet-picked-up tail.
    expect(container.textContent).toContain('Not yet queued');
    await unmount();
  });

  it('(6) when the pinned node A finishes, the pin auto-drops (return to the overview)', async () => {
    const store = useCorpStore.getState();
    // Track the promoted chart, then pin the working node A.
    store.foldEvent({ type: 'org-chart', chart: chart(A_WORKING) });
    store.trackChart(chart(A_WORKING));
    store.selectNode(A_WORKING);
    expect(useCorpStore.getState().pinnedNode?.id).toBe('a');

    // A transitions working → done: the pin drops (followLive), so the chat
    // returns to the CEO-waiting overview to pick another / the CEO.
    store.foldEvent({ type: 'org-chart', chart: chart(A_DONE) });
    store.trackChart(chart(A_DONE));
    expect(useCorpStore.getState().pinnedNode).toBeNull();

    // With no pin, the thread view falls back to the CEO waiting indicator.
    const view = corpChatView({
      taskId: 't1',
      situation: useCorpStore.getState().situation,
      liveNode: useCorpStore.getState().liveNode,
      pinnedNode: useCorpStore.getState().pinnedNode,
    });
    expect(view.kind).toBe('waiting');
  });
});
