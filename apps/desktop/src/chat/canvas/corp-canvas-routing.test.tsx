// @vitest-environment jsdom
/**
 * The corp → canvas bridge ({@link useCorpCanvasRouting}) drives the SHARED
 * CanvasController so a multi-agent run lights the canvas exactly like a normal
 * chat: a worker's bash step opens a live TERMINAL tab (command + streamed
 * output), a worker's file write opens a live FILE tab (with a +N/−N badge), a
 * delegation focuses the SITUATION room, and a subagent-row click brings the
 * situation room forward. Driven entirely from MOCK worker-activity fed into the
 * corp store against a REAL controller (no engine, no app launch).
 */
import {
  type CanvasController,
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
  WorkerActivityEvent,
} from '@pi-desktop/coordination';
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useCorpStore } from '../../state/corp-store';
import { selectCorpNodeAndFocus, useCorpCanvasRouting } from './corp-canvas-routing';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// SituationRoomSurface measures its width via ResizeObserver — stub it for jsdom.
if (typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver === 'undefined') {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

const PEEK = {
  fileCount: 1,
  totalBytes: 20,
  files: [{ path: 'src/x.ts', content: 'a\nb\nc\nd\ne\n', bytes: 10, truncated: false }],
};

beforeEach(() => {
  (window as unknown as { piDesktop: unknown }).piDesktop = {
    invoke: (channel: string) =>
      channel === 'corp:peek' ? Promise.resolve({ peek: PEEK }) : Promise.resolve({}),
  };
  useCorpStore.getState().setTask(null);
});

afterEach(() => {
  useCorpStore.getState().setTask(null);
});

/** A tiny host that mounts the bridge against the given controller. */
function Bridge({ controller }: { controller: CanvasController }): null {
  useCorpCanvasRouting(controller);
  return null;
}

interface RenderResult {
  container: HTMLElement;
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
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/** Flush pending microtasks + a macrotask (the async peek → file-tab open). */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** Push worker-activity deltas into the store (inside act). */
async function push(...events: WorkerActivityEvent[]): Promise<void> {
  await act(async () => {
    for (const e of events) useCorpStore.getState().foldWorkerActivity(e);
  });
}

const wa = (
  fields: Omit<WorkerActivityEvent, 'type' | 'nodeId'> & { nodeId?: string },
): WorkerActivityEvent => ({ type: 'worker-activity', nodeId: 'eng-1', ...fields });

function chartOf(ids: string[]): OrgChartView {
  return {
    taskId: 't1',
    nodes: ids.map((id) =>
      id === 'ceo'
        ? { id: 'ceo', role: 'ceo', name: 'Pi', state: 'working' }
        : { id, role: 'engineer', name: 'Builder', parentId: 'ceo', state: 'working' },
    ),
    edges: [],
  };
}

/** Fold an org-chart snapshot into the store (situation + follow), inside act. */
async function feedChart(ids: string[]): Promise<void> {
  const event: CoordinationEvent = { type: 'org-chart', chart: chartOf(ids) };
  await act(async () => {
    useCorpStore.getState().foldEvent(event);
    useCorpStore.getState().trackChart(event.chart);
  });
}

/** A SituationState with the subagent rows a click can target. */
function situationState(ids: string[]): SituationState {
  let s = initialSituation('t1');
  s = reduceSituation(s, { type: 'status', status: 'working' });
  s = reduceSituation(s, { type: 'org-chart', chart: chartOf(ids) });
  return s;
}

describe('useCorpCanvasRouting — a corp run drives the canvas like a chat', () => {
  it('opens a terminal + file tab, focuses situation on delegation, and on a subagent click', async () => {
    const controller = createCanvasController();
    useCorpStore.getState().setTask('t1');

    const { unmount } = await render(
      <CanvasProvider controller={controller}>
        <Bridge controller={controller} />
      </CanvasProvider>,
    );

    // ChatApp opens the situation room on promotion — simulate that here.
    await act(async () => {
      controller.upsertTab('situation:t1', {
        kind: 'situation',
        title: 'Situation room',
        situationTaskId: 't1',
      });
    });
    const situationId = controller.getState().tabs.find((t) => t.key === 'situation:t1')?.id;
    expect(situationId).toBeDefined();

    // A solo chart first (one node) — NOT a delegation.
    await feedChart(['ceo']);

    // (1) A file write grows +N → a live corpfile tab, streaming, badge = +5/−1.
    await push(
      wa({ kind: 'file', path: 'src/x.ts', label: 'Writing', addedLines: 3 }),
      wa({ kind: 'file', path: 'src/x.ts', addedLines: 2, removedLines: 1 }),
    );
    await flush(); // the async peek → file-tab open resolves

    const file = controller.getState().tabs.find((t) => t.key === 'corpfile:src/x.ts');
    expect(file).toBeDefined();
    expect(file?.kind).toBe('file');
    expect(file?.streaming).toBe(true);
    expect(file?.addedLines).toBe(5);
    expect(file?.removedLines).toBe(1);

    // (2) A bash command with streamed output → a live corpterm tab whose mirror
    // carries BOTH the command and its output.
    await push(
      wa({ kind: 'tool', toolName: 'bash', detail: 'npm run build' }),
      wa({
        kind: 'tool',
        toolName: 'bash',
        detail: 'npm run build',
        output: 'compiling…\nBuild OK',
      }),
    );

    const term = controller.getState().tabs.find((t) => t.key?.startsWith('corpterm:'));
    expect(term).toBeDefined();
    expect(term?.kind).toBe('terminal');
    const mirrorText = term?.data?.mirrorText as string | undefined;
    expect(mirrorText).toContain('npm run build');
    expect(mirrorText).toContain('Build OK');

    // The last execution event (bash) focused its own tab — situation is NOT active.
    expect(controller.getState().activeTabId).toBe(term?.id);
    expect(controller.getState().activeTabId).not.toBe(situationId);

    // (3) A delegation (a NEW org-chart node) focuses the situation room.
    await feedChart(['ceo', 'eng-1']);
    expect(controller.getState().activeTabId).toBe(situationId);

    // (4) A subagent-row click SCOPES the canvas to that node's most-recent
    // surface (STEP 4) — eng-1's live terminal here — dropping the user into its
    // work. Move focus to the situation tab first so the scope is observable.
    await act(async () => {
      if (situationId) controller.focusTab(situationId);
    });
    expect(controller.getState().activeTabId).toBe(situationId);

    const { container: room, unmount: unmountRoom } = await render(
      <SituationRoomSurface
        state={situationState(['ceo', 'eng-1'])}
        onSelectNode={(node) => selectCorpNodeAndFocus(controller, 't1', node)}
      />,
    );
    const row = room.querySelector('[data-testid="subagent-row"]');
    expect(row).not.toBeNull();
    await act(async () => {
      (row as HTMLElement).click();
    });
    // eng-1 pinned + the canvas scoped to its terminal tab (its latest surface).
    expect(useCorpStore.getState().pinnedNode?.id).toBe('eng-1');
    expect(controller.getState().activeTabId).toBe(term?.id);

    await unmountRoom();
    await unmount();
  });

  it('is inert when no corp task is active (normal chat is unaffected)', async () => {
    const controller = createCanvasController();
    // No setTask → taskId is null.
    const { unmount } = await render(<Bridge controller={controller} />);
    await push(wa({ kind: 'tool', toolName: 'bash', detail: 'ls' }));
    await push(wa({ kind: 'file', path: 'src/y.ts', addedLines: 1 }));
    await flush();
    expect(controller.getState().tabs).toHaveLength(0);
    await unmount();
  });
});
