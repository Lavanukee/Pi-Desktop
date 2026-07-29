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
import { corpChatView } from '../corp/corp-thread-view';
import { useCorpStore } from '../../state/corp-store';
import {
  AGENT_ACTIVITY_TAB_KEY,
  AGENT_ACTIVITY_TITLE,
  selectCorpNodeAndFocus,
  useCorpCanvasRouting,
} from './corp-canvas-routing';

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

describe('the way back to the CEO', () => {
  /*
   * jedd: "the CEO == the original model right? there's no way back to the CEO,
   * the top of the situation room shows the manager."
   *
   * It listed every node EXCEPT the root, on the reasoning that the root is the
   * conversation you are already in. True — and it meant the hierarchy appeared to
   * start at the manager, and the one agent you might most want to return to was
   * the only one you could not click.
   */
  it('lists the root FIRST, and clicking it pins the CEO back into the chat', async () => {
    const controller = createCanvasController();
    useCorpStore.getState().setTask('t1');
    const { container, unmount } = await render(
      <SituationRoomSurface
        state={situationState(['ceo', 'mgr', 'eng-1'])}
        onSelectNode={(node) => selectCorpNodeAndFocus(controller, 't1', node)}
      />,
    );
    const rows = [...container.querySelectorAll('[data-testid="subagent-row"]')];
    expect(rows[0]?.getAttribute('data-node-id')).toBe('ceo');
    await act(async () => {
      (rows[0] as HTMLElement).click();
    });
    // Pinned → corpChatView renders the CEO's own stream in the chat pane, which
    // is the original model's conversation.
    expect(useCorpStore.getState().pinnedNode?.id).toBe('ceo');
    expect(
      corpChatView({
        taskId: 't1',
        situation: situationState(['ceo', 'mgr', 'eng-1']),
        liveNode: null,
        pinnedNode: useCorpStore.getState().pinnedNode,
      }),
    ).toMatchObject({ kind: 'stream', node: { id: 'ceo' } });
    await unmount();
  });
});

describe('useCorpCanvasRouting — a corp run drives the canvas like a chat', () => {
  it('follows ONLY the shown node, into ONE tab that morphs and never takes focus', async () => {
    const controller = createCanvasController();
    useCorpStore.getState().setTask('t1');

    const { unmount } = await render(
      <CanvasProvider controller={controller}>
        <Bridge controller={controller} />
      </CanvasProvider>,
    );

    // Something the user is already reading, so a focus steal would be visible.
    const homeId = await act(async () =>
      controller.openTab({ kind: 'situation', title: 'Situation room', key: 'situation:t1' }),
    );

    // A team forms: ceo + two builders. The user PINS eng-1 — only the PINNED
    // node's work reaches the canvas.
    await feedChart(['ceo', 'eng-1', 'eng-2']);
    const eng1 = chartOf(['ceo', 'eng-1', 'eng-2']).nodes.find((n) => n.id === 'eng-1');
    await act(async () => {
      if (eng1 !== undefined) useCorpStore.getState().selectNode(eng1);
    });
    expect(useCorpStore.getState().pinnedNode?.id).toBe('eng-1');

    // A NON-shown node writes a file → nothing appears for it.
    await push(
      wa({ nodeId: 'eng-2', kind: 'file', path: 'other/z.ts', content: 'zzz', addedLines: 9 }),
    );
    await flush();
    expect(controller.getState().tabs).toHaveLength(1);

    // The SHOWN node writes → the ONE activity tab appears, carrying the real
    // captured body and the file block's +N — and the user is NOT moved to it.
    await push(
      wa({ kind: 'file', path: 'src/x.ts', label: 'Writing', content: 'a\nb\nc', addedLines: 3 }),
    );
    const first = controller.getState().tabs.find((t) => t.key === AGENT_ACTIVITY_TAB_KEY);
    expect(first).toBeDefined();
    expect(first?.kind).toBe('file');
    expect(first?.title).toBe(AGENT_ACTIVITY_TITLE);
    expect(first?.subtitle).toBe('x.ts');
    expect(first?.artifact?.content.text).toBe('a\nb\nc');
    expect(first?.addedLines).toBe(3);
    expect(controller.getState().activeTabId).toBe(homeId); // stayed put

    // A NEW file is the SAME tab, re-pointed — never a second one.
    await push(wa({ kind: 'file', path: 'src/y.ts', content: 'y1\ny2', addedLines: 2 }));
    const second = controller.getState().tabs.find((t) => t.key === AGENT_ACTIVITY_TAB_KEY);
    expect(second?.id).toBe(first?.id);
    expect(second?.subtitle).toBe('y.ts');
    expect(second?.artifact?.content.text).toBe('y1\ny2');
    expect(controller.getState().tabs).toHaveLength(2); // home + activity, still

    // Then it runs commands: the SAME tab BECOMES a terminal carrying every
    // command in one mirror — the shell you would see sitting next to it.
    await push(
      wa({ kind: 'tool', toolName: 'bash', detail: 'npm run build' }),
      wa({ kind: 'tool', toolName: 'bash', detail: 'npm run build', output: 'Build OK' }),
      wa({ kind: 'tool', toolName: 'bash', detail: 'npm test' }),
      wa({ kind: 'tool', toolName: 'bash', detail: 'npm test', output: 'Tests pass' }),
    );
    const asTerm = controller.getState().tabs.find((t) => t.key === AGENT_ACTIVITY_TAB_KEY);
    expect(asTerm?.id).toBe(first?.id); // morphed in place
    expect(asTerm?.kind).toBe('terminal');
    expect(asTerm?.subtitle).toBe('npm test');
    const mirror = asTerm?.data?.mirrorText as string | undefined;
    expect(mirror).toContain('npm run build');
    expect(mirror).toContain('Build OK');
    expect(mirror).toContain('npm test');
    expect(mirror).toContain('Tests pass');
    expect(controller.getState().tabs).toHaveLength(2);
    expect(controller.getState().activeTabId).toBe(homeId); // still never moved

    await unmount();
  });

  it('types a live write into the activity tab, and shows an html page as the PAGE', async () => {
    const controller = createCanvasController();
    useCorpStore.getState().setTask('t1');

    const { unmount } = await render(
      <CanvasProvider controller={controller}>
        <Bridge controller={controller} />
      </CanvasProvider>,
    );

    await feedChart(['ceo', 'eng-1']);
    const eng1a = chartOf(['ceo', 'eng-1']).nodes.find((n) => n.id === 'eng-1');
    await act(async () => {
      if (eng1a !== undefined) useCorpStore.getState().selectNode(eng1a);
    });

    // The model streams a TEXT-FORM `<function=write>` whose content GROWS across
    // deltas (the qwen grammar-failure shape) — the canvas must render THIS live
    // body, not the (empty mid-run) product peek.
    await push(wa({ kind: 'text', phase: 'start' }));
    await push(
      wa({
        kind: 'text',
        phase: 'delta',
        delta:
          '<function=write><parameter=path>index.html</parameter><parameter=content>\n<!DOCTYPE html>\n<html><body><h1>Hi',
      }),
    );

    // An html file the agent is building shows as the PAGE — watching a site
    // appear is the point — in the one activity tab, streaming.
    const page1 = controller.getState().tabs.find((t) => t.key === AGENT_ACTIVITY_TAB_KEY);
    expect(page1).toBeDefined();
    expect(page1?.kind).toBe('html');
    expect(page1?.subtitle).toBe('index.html');
    expect(page1?.streaming).toBe(true);
    expect(page1?.artifact?.content.text).toContain('<h1>Hi');
    expect(controller.getState().tabs).toHaveLength(1); // no separate preview tab

    // More content streams in — the SAME tab GROWS, then settles when the write
    // closes. Never a new tab.
    await push(
      wa({
        kind: 'text',
        phase: 'delta',
        delta: ' there</h1></body></html>\n</parameter></function>',
      }),
      wa({ kind: 'text', phase: 'end' }),
    );

    const page2 = controller.getState().tabs.find((t) => t.key === AGENT_ACTIVITY_TAB_KEY);
    expect(page2?.id).toBe(page1?.id);
    expect(page2?.artifact?.content.text).toContain('Hi there');
    expect(page2?.streaming).toBe(false);
    expect(controller.getState().tabs).toHaveLength(1);

    await unmount();
  });

  it('delegation shows the room, and clicking a subagent LEAVES YOU THERE', async () => {
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

    // A delegation (a NEW org-chart node) brings the room forward.
    await feedChart(['ceo', 'eng-1']);
    expect(controller.getState().activeTabId).toBe(situationId);

    const { container: room, unmount: unmountRoom } = await render(
      <SituationRoomSurface
        state={situationState(['ceo', 'eng-1'])}
        onSelectNode={(node) => selectCorpNodeAndFocus(controller, 't1', node)}
      />,
    );
    const row = room.querySelector('[data-testid="subagent-row"][data-node-id="eng-1"]');
    await act(async () => {
      (row as HTMLElement).click();
    });
    expect(useCorpStore.getState().pinnedNode?.id).toBe('eng-1');
    // THE POINT: the click changed WHAT the surfaces show, not WHICH one you are
    // looking at. jedd: "keep that tab open instead of moving to the subagent's
    // tab immediately ... we need to be able to quickly swap and monitor."
    expect(controller.getState().activeTabId).toBe(situationId);

    // The pinned node then runs a command — the activity tab fills BEHIND the
    // room, ready when the user wants it, and still does not grab focus.
    await push(wa({ kind: 'tool', toolName: 'bash', detail: 'python -m http.server' }));
    const activity = controller.getState().tabs.find((t) => t.key === AGENT_ACTIVITY_TAB_KEY);
    expect(activity?.kind).toBe('terminal');
    expect(activity?.data?.mirrorText as string | undefined).toContain('python -m http.server');
    expect(controller.getState().activeTabId).toBe(situationId);

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
