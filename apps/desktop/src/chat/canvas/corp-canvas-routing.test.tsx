// @vitest-environment jsdom
/**
 * The corp → canvas bridge ({@link useCorpCanvasRouting}) drives the SHARED
 * CanvasController so a multi-agent run lights the canvas like a normal chat —
 * scoped to what the user is watching:
 *
 *  - C5: ONLY the followed subagent (pinned, else live-followed) opens/updates a
 *    tab. Another node's writes/commands never open one.
 *  - C1/C2: a file write TYPES IN the actual captured body, with the file block's
 *    +N/−N as the one authoritative badge.
 *  - C4: the followed node's newest write REPLACES the prior file tab (one tab,
 *    never stacked per write).
 *  - C6: a node's shell commands append into ONE terminal tab (keyed by node).
 *
 * Driven entirely from MOCK worker-activity fed into the corp store against a REAL
 * controller (no engine, no app launch).
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

/** Push worker-activity deltas into the store (inside act). Defaults to eng-1. */
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

/** Fold an org-chart snapshot into the store (situation + follow), inside act. The
 * deepest working node becomes the followed (shown) node — an engineer over the CEO. */
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
  it('follows ONLY the shown node; one file tab (reused), one terminal (appended)', async () => {
    const controller = createCanvasController();
    useCorpStore.getState().setTask('t1');

    const { unmount } = await render(
      <CanvasProvider controller={controller}>
        <Bridge controller={controller} />
      </CanvasProvider>,
    );

    // A team forms: ceo + two builders. The deepest working node (eng-1) is the
    // followed/shown node — the only one whose work reaches the canvas.
    await feedChart(['ceo', 'eng-1', 'eng-2']);
    expect(useCorpStore.getState().liveNode?.id).toBe('eng-1');

    // (C5) A NON-shown node (eng-2) writes a file → NO tab opens for it.
    await push(
      wa({ nodeId: 'eng-2', kind: 'file', path: 'other/z.ts', content: 'zzz', addedLines: 9 }),
    );
    await flush();
    expect(controller.getState().tabs.find((t) => t.key === 'corpfile:other/z.ts')).toBeUndefined();

    // (C1/C2) The SHOWN node writes a file, its captured body carried end-to-end →
    // a live file tab renders the ACTUAL content, +N from the file block (not a
    // content-derived count), streaming settled (a structured write lands complete).
    await push(
      wa({ kind: 'file', path: 'src/x.ts', label: 'Writing', content: 'a\nb\nc', addedLines: 3 }),
    );
    const fileX = controller.getState().tabs.find((t) => t.key === 'corpfile:src/x.ts');
    expect(fileX).toBeDefined();
    expect(fileX?.kind).toBe('file');
    expect(fileX?.artifact?.content.text).toBe('a\nb\nc');
    expect(fileX?.addedLines).toBe(3);
    expect(fileX?.streaming).toBe(false);
    // The new file tab focused (auto-swap to the execution).
    expect(controller.getState().activeTabId).toBe(fileX?.id);

    // (C4) A NEW file for the same node REPLACES the tab — the prior corpfile is
    // CLOSED, not stacked. Exactly one corp file tab remains.
    await push(wa({ kind: 'file', path: 'src/y.ts', content: 'y1\ny2\ny3\ny4', addedLines: 4 }));
    expect(controller.getState().tabs.find((t) => t.key === 'corpfile:src/x.ts')).toBeUndefined();
    const fileY = controller.getState().tabs.find((t) => t.key === 'corpfile:src/y.ts');
    expect(fileY?.artifact?.content.text).toBe('y1\ny2\ny3\ny4');
    expect(fileY?.addedLines).toBe(4);
    expect(controller.getState().tabs.filter((t) => t.key?.startsWith('corpfile:'))).toHaveLength(
      1,
    );

    // (C6) Two shell commands for the shown node → ONE terminal tab (keyed by node),
    // both commands appended into the same mirror — never a tab per command.
    await push(
      wa({ kind: 'tool', toolName: 'bash', detail: 'npm run build' }),
      wa({ kind: 'tool', toolName: 'bash', detail: 'npm run build', output: 'Build OK' }),
      wa({ kind: 'tool', toolName: 'bash', detail: 'npm test' }),
      wa({ kind: 'tool', toolName: 'bash', detail: 'npm test', output: 'Tests pass' }),
    );
    const terms = controller.getState().tabs.filter((t) => t.key?.startsWith('corpterm:'));
    expect(terms).toHaveLength(1);
    expect(terms[0]?.key).toBe('corpterm:eng-1');
    const mirror = terms[0]?.data?.mirrorText as string | undefined;
    expect(mirror).toContain('npm run build');
    expect(mirror).toContain('Build OK');
    expect(mirror).toContain('npm test');
    expect(mirror).toContain('Tests pass');

    // (C5, again) eng-2 never got a surface — only the followed node's work showed.
    expect(controller.getState().tabs.find((t) => t.key === 'corpterm:eng-2')).toBeUndefined();

    await unmount();
  });

  it('types a file in live from the streamed write body + opens a live HTML preview (code focused)', async () => {
    const controller = createCanvasController();
    useCorpStore.getState().setTask('t1');

    const { unmount } = await render(
      <CanvasProvider controller={controller}>
        <Bridge controller={controller} />
      </CanvasProvider>,
    );

    // Make eng-1 the followed node so its work reaches the canvas (C5).
    await feedChart(['ceo', 'eng-1']);

    // The model streams a TEXT-FORM `<function=write>` whose content GROWS across
    // deltas (the qwen grammar-failure shape) — the corp canvas must render THIS
    // live body, not the (empty mid-run) product peek.
    await push(wa({ kind: 'text', phase: 'start' }));
    await push(
      wa({
        kind: 'text',
        phase: 'delta',
        delta:
          '<function=write><parameter=path>index.html</parameter><parameter=content>\n<!DOCTYPE html>\n<html><body><h1>Hi',
      }),
    );

    // (1) The file CODE tab renders the ACTUAL streaming write body, streaming, and
    // is FOCUSED (the code tab, not the preview).
    const code1 = controller.getState().tabs.find((t) => t.key === 'corpfile:index.html');
    expect(code1).toBeDefined();
    expect(code1?.kind).toBe('file');
    expect(code1?.streaming).toBe(true);
    expect(code1?.artifact?.content.text).toBe('<!DOCTYPE html>\n<html><body><h1>Hi');
    expect(controller.getState().activeTabId).toBe(code1?.id);

    // (2) A live HTML PREVIEW opened alongside it (secondary — NOT focused).
    const preview1 = controller.getState().tabs.find((t) => t.key === 'corphtml:index.html');
    expect(preview1).toBeDefined();
    expect(preview1?.kind).toBe('html');
    expect(preview1?.artifact?.content.kind).toBe('html');
    expect(preview1?.artifact?.content.text).toContain('<h1>Hi');
    expect(controller.getState().activeTabId).not.toBe(preview1?.id);

    // (3) More content streams in — the SAME tabs GROW in place, then settle when
    // the write closes (streaming:false), never a new tab, never a focus steal.
    await push(
      wa({
        kind: 'text',
        phase: 'delta',
        delta: ' there</h1></body></html>\n</parameter></function>',
      }),
      wa({ kind: 'text', phase: 'end' }),
    );

    const code2 = controller.getState().tabs.find((t) => t.key === 'corpfile:index.html');
    expect(code2?.id).toBe(code1?.id); // grew in place
    expect(code2?.artifact?.content.text).toContain('Hi there');
    expect(code2?.artifact?.content.text.length ?? 0).toBeGreaterThan(
      code1?.artifact?.content.text.length ?? 0,
    );
    expect(code2?.streaming).toBe(false); // the write closed → settled

    const preview2 = controller.getState().tabs.find((t) => t.key === 'corphtml:index.html');
    expect(preview2?.id).toBe(preview1?.id);
    expect(preview2?.artifact?.content.text).toContain('Hi there');

    await unmount();
  });

  it('delegation focuses the situation room; a subagent click scopes to its latest surface', async () => {
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

    // A delegation (a NEW org-chart node) focuses the situation room.
    await feedChart(['ceo', 'eng-1']);
    expect(controller.getState().activeTabId).toBe(situationId);

    // eng-1 (the followed node) runs a shell command → its ONE terminal opens.
    await push(wa({ kind: 'tool', toolName: 'bash', detail: 'python -m http.server' }));
    const term = controller.getState().tabs.find((t) => t.key === 'corpterm:eng-1');
    expect(term).toBeDefined();
    expect(term?.data?.mirrorText as string | undefined).toContain('python -m http.server');

    // A subagent-row click SCOPES the canvas to that node's most-recent surface
    // (STEP 4) — eng-1's live terminal here. Focus the room first so the scope is
    // observable.
    await act(async () => {
      if (situationId) controller.focusTab(situationId);
    });
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
