import type { CoordinationEvent } from '@pi-desktop/coordination';
import { describe, expect, it, vi } from 'vitest';
import { render } from '../test-utils.tsx';
import { buildMockCorpRunScript, MOCK_TASK_ID } from './mock-run.ts';
import { initialSituation, reduceSituation, type SituationState } from './situation-model.ts';
import { SituationRoomHost, SituationRoomSurface } from './situation-surface.tsx';

function foldTo(atMs: number): SituationState {
  let state = initialSituation(MOCK_TASK_ID);
  for (const entry of buildMockCorpRunScript()) {
    if (entry.at > atMs) break;
    state = reduceSituation(state, entry.event);
  }
  return state;
}

/** A small live corporation: a root lead, a working manager, one area with a
 * working builder (real action), a done builder, and a queued area. */
const LIVE_CHART_EVENT: CoordinationEvent = {
  type: 'org-chart',
  chart: {
    taskId: 't1',
    nodes: [
      { id: 'ceo', role: 'ceo', name: 'Pi', state: 'working', currentAction: 'thinking' },
      { id: 'mgr', role: 'manager', name: 'Build plan', parentId: 'ceo', state: 'working' },
      { id: 'div-fe', role: 'division', name: 'Frontend', parentId: 'ceo', state: 'idle' },
      {
        id: 'eng-1',
        role: 'engineer',
        name: 'Frontend builder 1',
        parentId: 'div-fe',
        state: 'working',
        currentAction: 'Writing src/ui/emitter.ts',
      },
      {
        id: 'eng-2',
        role: 'engineer',
        name: 'Frontend builder 2',
        parentId: 'div-fe',
        state: 'done',
      },
      {
        id: 'eng-3',
        role: 'engineer',
        name: 'Frontend builder 3',
        parentId: 'div-fe',
        state: 'working',
        currentAction: 'thinking',
      },
    ],
    edges: [
      { from: 'ceo', to: 'mgr' },
      { from: 'ceo', to: 'div-fe' },
      { from: 'div-fe', to: 'eng-1' },
      { from: 'div-fe', to: 'eng-2' },
      { from: 'div-fe', to: 'eng-3' },
    ],
  },
};

describe('SituationRoomSurface', () => {
  it('renders the run mid-dispatch: header, subagent rows, plan, honest ETA', async () => {
    const { container, unmount } = await render(
      <SituationRoomSurface state={foldTo(26_000)} userMode="power" />,
    );
    const room = container.querySelector('[data-testid="situation-room"]');
    expect(room).not.toBeNull();
    // Header: real contract progress + a RANGE, not a countdown.
    expect(container.textContent).toContain('of 48 tasks');
    expect(container.textContent).toMatch(/~\d+–\d+ min left/);
    // The subagent navigator lists the corporation (manager + areas + builders),
    // active rows first, and NEVER the root "you" node.
    const rows = [...container.querySelectorAll('[data-testid="subagent-row"]')];
    expect(rows.length).toBeGreaterThanOrEqual(8);
    expect(rows.some((r) => r.getAttribute('data-node-id') === 'root')).toBe(false);
    expect(rows[0]?.getAttribute('data-state')).toBe('working');
    // A working builder's row carries its LIVE current action.
    expect(rows.some((r) => r.textContent?.includes('Writing '))).toBe(true);
    expect(container.textContent).toContain('Core Engine');
    // The org chart and file map are GONE — the room is a clean navigator.
    expect(container.querySelector('.pd-sitroom-chart')).toBeNull();
    expect(container.querySelector('.pd-sitroom-map')).toBeNull();
    expect(container.querySelector('[data-testid="sitroom-section-team"]')).toBeNull();
    expect(container.querySelector('[data-testid="sitroom-section-feed"]')).toBeNull();
    expect(container.querySelector('[data-testid="sitroom-section-files"]')).toBeNull();
    expect(container.querySelector('[data-testid="sitroom-section-agents"]')).not.toBeNull();
    // The plan groups by division with real checks.
    expect(container.querySelectorAll('.pd-sitroom-plangroup').length).toBe(5);
    expect(
      container.querySelectorAll('.pd-sitroom-task-marker[data-state="done"]').length,
    ).toBeGreaterThan(0);
    await unmount();
  });

  it('enables "peek" only once an artifact exists, and routes it', async () => {
    let peeked: string | undefined;
    const early = await render(<SituationRoomSurface state={foldTo(10_000)} onPeek={() => {}} />);
    const earlyButton = early.container.querySelector('button.pd-btn') as HTMLButtonElement;
    expect(earlyButton.disabled).toBe(true);
    await early.unmount();

    const later = await render(
      <SituationRoomSurface state={foldTo(30_000)} onPeek={(a) => (peeked = a.id)} />,
    );
    const button = [...later.container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Peek'),
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    button.click();
    expect(peeked).toBe('build-v01');
    await later.unmount();
  });

  it('lists subagents active-first with the chat wording, and routes clicks', async () => {
    const onSelectNode = vi.fn();
    const state = reduceSituation(initialSituation('t1'), LIVE_CHART_EVENT);
    const { container, unmount } = await render(
      <SituationRoomSurface state={state} onSelectNode={onSelectNode} />,
    );
    const rows = [...container.querySelectorAll('[data-testid="subagent-row"]')];
    // The root lead ("Pi") is the node the user is already talking to — no row.
    expect(rows.length).toBe(5);
    expect(rows.some((r) => r.getAttribute('data-node-id') === 'ceo')).toBe(false);
    // Active first (working → queued → done), chart order within a rank.
    expect(rows.map((r) => r.getAttribute('data-node-id'))).toEqual([
      'mgr',
      'eng-1',
      'eng-3',
      'div-fe',
      'eng-2',
    ]);
    // A working LEAD reads as coordination, not an echoed action.
    expect(rows[0]?.textContent).toContain('Build plan');
    expect(rows[0]?.textContent).toContain('waiting for other subagents to finish');
    // A working builder shows its bold name + LIVE current action, with the
    // chat activity row's spinner in the icon slot.
    expect(rows[1]?.querySelector('strong')?.textContent).toBe('Frontend builder 1');
    expect(rows[1]?.textContent).toContain('Writing src/ui/emitter.ts');
    expect(rows[1]?.querySelector('.pd-activity-row-icon .pd-loader')).not.toBeNull();
    // The raw "thinking" action reads as a live "thinking…".
    expect(rows[2]?.textContent).toContain('thinking…');
    // Queued and done rows keep honest muted words.
    expect(rows[3]?.textContent).toContain('queued');
    expect(rows[4]?.textContent).toContain('done');
    // The WHOLE row is the button: clicking routes the worker's stream.
    (rows[1] as HTMLButtonElement).click();
    expect(onSelectNode).toHaveBeenCalledTimes(1);
    expect(onSelectNode.mock.calls[0]?.[0]?.id).toBe('eng-1');
    await unmount();
  });

  it('marks exactly the selected node row with data-selected', async () => {
    const state = reduceSituation(initialSituation('t1'), LIVE_CHART_EVENT);
    const { container, unmount } = await render(
      <SituationRoomSurface state={state} selectedNodeId="eng-1" onSelectNode={() => {}} />,
    );
    const selected = container.querySelectorAll('[data-testid="subagent-row"][data-selected]');
    expect(selected.length).toBe(1);
    expect(selected[0]?.getAttribute('data-node-id')).toBe('eng-1');
    await unmount();
  });

  it('settles into the shipped pose on done', async () => {
    const { container, unmount } = await render(
      <SituationRoomSurface state={foldTo(Number.POSITIVE_INFINITY)} />,
    );
    expect(container.querySelector('.pd-sitroom')?.getAttribute('data-status')).toBe('done');
    expect(container.textContent).toContain('View the build');
    await unmount();
  });
});

describe('SituationRoomHost', () => {
  it('folds a live event stream into the surface', async () => {
    async function* stream(): AsyncGenerator<CoordinationEvent> {
      yield { type: 'status', status: 'planning', detail: 'Forming a plan' };
      yield {
        type: 'org-chart',
        chart: {
          taskId: 't1',
          nodes: [
            { id: 'root', role: 'ceo', name: 'Pi', state: 'working' },
            { id: 'mgr', role: 'manager', name: 'Build plan', parentId: 'root', state: 'working' },
          ],
          edges: [{ from: 'root', to: 'mgr' }],
        },
      };
    }
    const { container, unmount } = await render(<SituationRoomHost events={stream()} />);
    // Effects + the async fold flush inside act (render awaits act()).
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(container.textContent).toContain('Forming a plan');
    const rows = [...container.querySelectorAll('[data-testid="subagent-row"]')];
    expect(rows.length).toBe(1);
    expect(rows[0]?.textContent).toContain('Build plan');
    await unmount();
  });

  it('renders a quiet empty state without a stream', async () => {
    const { container, unmount } = await render(<SituationRoomHost />);
    expect(container.textContent).toContain('No live run');
    await unmount();
  });
});
