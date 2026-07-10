import type { CanvasTab } from '@pi-desktop/canvas';
import { describe, expect, it } from 'vitest';
import { toCanvasState } from './canvas-state-report';

const tab = (t: Partial<CanvasTab> & { id: string; kind: CanvasTab['kind'] }): CanvasTab =>
  ({ title: t.id, ...t }) as CanvasTab;

describe('toCanvasState', () => {
  it('marks the active tab and lists the rest as others', () => {
    const tabs = [
      tab({ id: 'b1', kind: 'browser', title: 'Sandboxels', url: 'https://neal.fun/' }),
      tab({ id: 'f1', kind: 'file', filePath: 'src/App.tsx' }),
    ];
    const state = toCanvasState(tabs, 'b1');
    expect(state.active).toEqual({
      kind: 'browser',
      title: 'Sandboxels',
      tabId: 'b1',
      url: 'https://neal.fun/',
    });
    expect(state.others).toEqual([{ kind: 'file', title: 'f1', filePath: 'src/App.tsx' }]);
  });

  it('includes tabId for browser surfaces so main can enrich url/title', () => {
    const state = toCanvasState([tab({ id: 'b1', kind: 'browser' })], 'b1');
    expect(state.active?.tabId).toBe('b1');
  });

  it('reports a streaming file as dirty and caps the excerpt', () => {
    const big = 'x'.repeat(1000);
    const tabs = [
      tab({
        id: 'f1',
        kind: 'file',
        filePath: 'a.txt',
        streaming: true,
        artifact: { id: 'a', content: { kind: 'code', text: big } },
      } as Partial<CanvasTab> & { id: string; kind: CanvasTab['kind'] }),
    ];
    const state = toCanvasState(tabs, 'f1');
    expect(state.active?.dirty).toBe(true);
    expect((state.active?.excerpt ?? '').length).toBeLessThanOrEqual(240);
  });

  it('is empty when there are no tabs', () => {
    expect(toCanvasState([], null)).toEqual({ active: null, others: [] });
  });

  it('puts every tab in others when nothing is focused', () => {
    const tabs = [tab({ id: 'b1', kind: 'browser' }), tab({ id: 'b2', kind: 'terminal' })];
    const state = toCanvasState(tabs, null);
    expect(state.active).toBeNull();
    expect(state.others).toHaveLength(2);
  });
});
