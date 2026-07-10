import { describe, expect, it, vi } from 'vitest';
import { CanvasController, createCanvasController } from './controller.ts';

function seqIds(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `t${n}`;
  };
}

describe('CanvasController', () => {
  it('openTab appends, focuses, and un-collapses; returns the new id', () => {
    const c = new CanvasController({ idFactory: seqIds(), initialState: { collapsed: true } });
    const id = c.openTab({ kind: 'browser', title: 'New tab' });
    expect(id).toBe('t1');
    const state = c.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.activeTabId).toBe('t1');
    expect(state.collapsed).toBe(false);
  });

  it('focusTab activates an existing tab and ignores unknown ids', () => {
    const c = new CanvasController({ idFactory: seqIds() });
    const a = c.openTab({ kind: 'code', title: 'a' });
    const b = c.openTab({ kind: 'code', title: 'b' });
    expect(c.getState().activeTabId).toBe(b);
    c.focusTab(a);
    expect(c.getState().activeTabId).toBe(a);
    c.focusTab('nope');
    expect(c.getState().activeTabId).toBe(a);
  });

  it('upsertTab opens once per key then focuses+merges the same tab', () => {
    const c = new CanvasController({ idFactory: seqIds() });
    const first = c.upsertTab('artifact-7', { kind: 'image', title: 'Preview' });
    const other = c.openTab({ kind: 'code', title: 'code' });
    expect(c.getState().activeTabId).toBe(other);

    const second = c.upsertTab('artifact-7', {
      kind: 'image',
      title: 'Preview v2',
      mediaStatus: 'loaded',
    });
    expect(second).toBe(first); // same tab id — no duplicate
    expect(c.getState().tabs).toHaveLength(2);
    expect(c.getState().activeTabId).toBe(first); // re-opening focuses it
    const tab = c.getState().tabs.find((t) => t.id === first);
    expect(tab?.title).toBe('Preview v2'); // spec merged in
    expect(tab?.mediaStatus).toBe('loaded');
  });

  it('closeTab removes and reassigns active to the left neighbour, then null', () => {
    const c = new CanvasController({ idFactory: seqIds() });
    const a = c.openTab({ kind: 'code', title: 'a' });
    const b = c.openTab({ kind: 'code', title: 'b' });
    const cc = c.openTab({ kind: 'code', title: 'c' });
    c.focusTab(b);
    c.closeTab(b);
    expect(c.getState().tabs.map((t) => t.id)).toEqual([a, cc]);
    expect(c.getState().activeTabId).toBe(a); // left neighbour
    c.closeTab(a);
    c.closeTab(cc);
    expect(c.getState().tabs).toHaveLength(0);
    expect(c.getState().activeTabId).toBeNull();
  });

  it('updateTab merges a patch into a tab (preserving id)', () => {
    const c = new CanvasController({ idFactory: seqIds() });
    const id = c.openTab({ kind: 'browser', title: 'New tab' });
    c.updateTab(id, { url: 'https://example.com', canGoBack: true });
    const tab = c.getState().tabs[0];
    expect(tab?.id).toBe(id);
    expect(tab?.url).toBe('https://example.com');
    expect(tab?.canGoBack).toBe(true);
  });

  it('setCollapsed / setFullscreen toggle and no-op when unchanged', () => {
    const c = createCanvasController({ idFactory: seqIds() });
    const listener = vi.fn();
    c.subscribe(listener);
    c.setCollapsed(true);
    expect(c.getState().collapsed).toBe(true);
    c.setCollapsed(true); // no-op
    c.setFullscreen(true);
    expect(c.getState().fullscreen).toBe(true);
    expect(listener).toHaveBeenCalledTimes(2); // one per real change
  });

  it('notifies subscribers on change and stops after unsubscribe', () => {
    const c = new CanvasController({ idFactory: seqIds() });
    const listener = vi.fn();
    const off = c.subscribe(listener);
    c.openTab({ kind: 'code', title: 'a' });
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    c.openTab({ kind: 'code', title: 'b' });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
