import type { CoordinationEvent } from '@pi-desktop/coordination';
import { describe, expect, it } from 'vitest';
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

describe('SituationRoomSurface', () => {
  it('renders the growing corporation mid-dispatch: chart, plan, map, honest ETA', async () => {
    const { container, unmount } = await render(
      <SituationRoomSurface state={foldTo(26_000)} userMode="power" />,
    );
    const room = container.querySelector('[data-testid="situation-room"]');
    expect(room).not.toBeNull();
    // Header: real contract progress + a RANGE, not a countdown.
    expect(container.textContent).toContain('of 48 tasks');
    expect(container.textContent).toMatch(/~\d+–\d+ min left/);
    // The org chart drew the corporation.
    expect(container.textContent).toContain('Core Engine');
    expect(container.textContent).toContain('Build plan');
    expect(container.querySelectorAll('.pd-sitroom-node').length).toBeGreaterThanOrEqual(7);
    expect(container.querySelectorAll('.pd-sitroom-crew-dot').length).toBeGreaterThan(0);
    // The module map lights files inside their regions.
    expect(container.textContent).toContain('src/engine/');
    expect(container.querySelectorAll('.pd-sitroom-file').length).toBeGreaterThan(4);
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

  it('highlights exactly one node when a root-parented division is selected', async () => {
    // The real corp engine parents divisions straight to the CEO. A division
    // must render in ONE tier only — selecting it may not light up two copies.
    const chartEvent: CoordinationEvent = {
      type: 'org-chart',
      chart: {
        taskId: 't1',
        nodes: [
          { id: 'ceo', role: 'ceo', name: 'Pi', state: 'working' },
          {
            id: 'architect',
            role: 'specialist',
            name: 'Architecture',
            parentId: 'ceo',
            state: 'done',
          },
          { id: 'div-fe', role: 'division', name: 'Frontend', parentId: 'ceo', state: 'working' },
          { id: 'div-be', role: 'division', name: 'Backend', parentId: 'ceo', state: 'idle' },
        ],
        edges: [
          { from: 'ceo', to: 'architect' },
          { from: 'ceo', to: 'div-fe' },
          { from: 'ceo', to: 'div-be' },
        ],
      },
    };
    const state = reduceSituation(initialSituation('t1'), chartEvent);
    const { container, unmount } = await render(
      <SituationRoomSurface state={state} selectedNodeId="div-fe" onSelectNode={() => {}} />,
    );
    expect(container.querySelectorAll('.pd-sitroom-node[data-selected]').length).toBe(1);
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
          nodes: [{ id: 'root', role: 'ceo', name: 'Pi', state: 'working' }],
          edges: [],
        },
      };
    }
    const { container, unmount } = await render(<SituationRoomHost events={stream()} />);
    // Effects + the async fold flush inside act (render awaits act()).
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(container.textContent).toContain('Forming a plan');
    expect(container.textContent).toContain('Pi');
    await unmount();
  });

  it('renders a quiet empty state without a stream', async () => {
    const { container, unmount } = await render(<SituationRoomHost />);
    expect(container.textContent).toContain('No live run');
    await unmount();
  });
});
