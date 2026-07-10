import { describe, expect, it, vi } from 'vitest';
import { click, render } from '../test-utils.tsx';
import { CanvasTabs } from './canvas-tabs.tsx';
import { CanvasController } from './controller.ts';

function seededController(): CanvasController {
  let n = 0;
  const c = new CanvasController({
    idFactory: () => {
      n += 1;
      return `t${n}`;
    },
  });
  c.openTab({ kind: 'browser', title: 'New tab' });
  c.openTab({
    kind: 'svg',
    title: 'Chart',
    artifact: { id: 's', content: { kind: 'svg', text: '<svg><rect/></svg>' } },
  });
  c.openTab({ kind: 'image', title: 'Render', mediaSrc: 'a.png', mediaType: 'PNG' });
  return c;
}

describe('CanvasTabs', () => {
  it('renders a tab per controller tab with its label', async () => {
    const c = seededController();
    const { container } = await render(<CanvasTabs controller={c} />);
    const labels = [...container.querySelectorAll('.pd-canvas-tab-label')].map(
      (n) => n.textContent,
    );
    expect(labels).toEqual(['New tab', 'Chart', 'Render']);
    // Last-opened is active and its (media) surface is mounted.
    expect(
      container.querySelector('.pd-canvas-tab[data-active] .pd-canvas-tab-label')?.textContent,
    ).toBe('Render');
    expect(container.querySelector('.pd-media')).toBeTruthy();
  });

  it('focuses a tab on click and swaps the surface', async () => {
    const c = seededController();
    const { container } = await render(<CanvasTabs controller={c} />);
    const svgTabMain = container.querySelectorAll('.pd-canvas-tab-main')[1];
    await click(svgTabMain ?? null);
    expect(c.getState().activeTabId).toBe('t2');
    expect(container.querySelector('.pd-canvas-svg')).toBeTruthy();
    expect(container.querySelector('.pd-media')).toBeNull();
  });

  it('closes a tab from its close control', async () => {
    const c = seededController();
    const { container } = await render(<CanvasTabs controller={c} />);
    await click(container.querySelector('.pd-canvas-tab-close'));
    expect(c.getState().tabs.map((t) => t.id)).toEqual(['t2', 't3']);
  });

  it('+ opens a new tab', async () => {
    const c = seededController();
    const { container } = await render(<CanvasTabs controller={c} />);
    await click(container.querySelector('[aria-label="New tab"]'));
    expect(c.getState().tabs).toHaveLength(4);
  });

  it('drops the fullscreen, ›› minimize, and left-sidebar controls from the bar', async () => {
    const c = seededController();
    const { container } = await render(<CanvasTabs controller={c} />);
    expect(container.querySelector('[aria-label="Expand to fullscreen"]')).toBeNull();
    expect(container.querySelector('[aria-label="Restore size"]')).toBeNull();
    expect(container.querySelector('[aria-label="Minimize canvas"]')).toBeNull();
    expect(container.querySelector('[aria-label="Toggle sidebar"]')).toBeNull();
  });

  it('panel-toggle emits onCollapse and leaves internal collapse to the app', async () => {
    const c = seededController();
    const onCollapse = vi.fn();
    const { container } = await render(<CanvasTabs controller={c} onCollapse={onCollapse} />);
    await click(container.querySelector('[aria-label="Toggle canvas panel"]'));
    expect(onCollapse).toHaveBeenCalledTimes(1);
    // The app owns the slide; internal collapsed state is untouched.
    expect(c.getState().collapsed).toBe(false);
  });

  it('panel-toggle collapses to the restore rail when onCollapse is not wired', async () => {
    const c = seededController();
    const { container } = await render(<CanvasTabs controller={c} />);
    await click(container.querySelector('[aria-label="Toggle canvas panel"]'));
    expect(c.getState().collapsed).toBe(true);
    expect(container.querySelector('.pd-canvas-tabs--collapsed')).toBeTruthy();
    // The rail reopens the panel.
    await click(container.querySelector('[aria-label="Open canvas panel"]'));
    expect(c.getState().collapsed).toBe(false);
  });

  it('copies the active surface content and swaps to a check', async () => {
    const c = seededController();
    const onCopy = vi.fn();
    // Active tab is the image render (mediaSrc 'a.png') → copies its src.
    const { container } = await render(<CanvasTabs controller={c} onCopy={onCopy} />);
    const copyBtn = container.querySelector('[aria-label="Copy"]');
    expect(copyBtn).toBeTruthy();
    await click(copyBtn);
    expect(onCopy).toHaveBeenCalledWith('a.png');
    // Feedback: the control now reads "Copied".
    expect(container.querySelector('[aria-label="Copied"]')).toBeTruthy();
  });

  it('routes browser navigation through the handler contract', async () => {
    const c = new CanvasController({ idFactory: () => 'b1' });
    c.openTab({ kind: 'browser', title: 'New tab' });
    const onSurfaceMount = vi.fn();
    await render(<CanvasTabs controller={c} handlers={{ onSurfaceMount }} />);
    // The active browser tab reports its native mount slot keyed by (tabId, kind).
    expect(onSurfaceMount).toHaveBeenCalledWith('b1', 'browser', expect.anything());
  });
});
