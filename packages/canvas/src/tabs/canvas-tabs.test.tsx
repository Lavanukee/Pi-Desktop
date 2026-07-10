import { act } from 'react';
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

  it('+ opens a menu and picks a new tab kind', async () => {
    const c = seededController();
    const { container } = await render(<CanvasTabs controller={c} />);
    // The + is a menu trigger now (round-8 #10) — no tab until a kind is picked.
    await click(container.querySelector('.pd-canvas-newtab'));
    const labels = [...container.querySelectorAll('.pd-canvas-menu-anchor .pd-menu-item')].map(
      (n) => n.textContent,
    );
    expect(labels).toEqual(['Files⌘P', 'Browser⌘T', 'Terminal', 'Subagents']);
    const browser = [...container.querySelectorAll('.pd-menu-item')].find((n) =>
      n.textContent?.includes('Browser'),
    );
    await click(browser ?? null);
    expect(c.getState().tabs).toHaveLength(4);
    expect(c.getState().tabs[3]?.kind).toBe('browser');
  });

  it('renders a live subagent tab and fires onSubagentSelect on a row click', async () => {
    const c = new CanvasController({ idFactory: () => 'sa' });
    c.openTab({
      kind: 'subagent',
      title: 'Subagents',
      subagents: [
        { id: 'w1', name: 'Research', step: 'Reading files…', status: 'running' },
        { id: 'w2', name: 'Refactor', step: 'Done', status: 'done' },
      ],
    });
    const onSubagentSelect = vi.fn();
    const { container } = await render(
      <CanvasTabs controller={c} handlers={{ onSubagentSelect }} />,
    );
    const rows = [...container.querySelectorAll('.pd-subagent-row')];
    expect(rows.map((r) => r.querySelector('.pd-subagent-name')?.textContent)).toEqual([
      'Research',
      'Refactor',
    ]);
    await click(rows[0] ?? null);
    expect(onSubagentSelect).toHaveBeenCalledWith('sa', 'w1');

    // Live update: pushing new SubagentItem[] via the controller re-renders rows.
    await act(async () => {
      c.updateTab('sa', {
        subagents: [{ id: 'w1', name: 'Research', step: 'Summarizing…', status: 'running' }],
      });
    });
    const stepText = container.querySelector('.pd-subagent-step')?.textContent;
    expect(stepText).toBe('Summarizing…');
  });

  it('opens a subagent tab from the + menu', async () => {
    const c = seededController();
    const { container } = await render(<CanvasTabs controller={c} />);
    await click(container.querySelector('.pd-canvas-newtab'));
    const subagents = [...container.querySelectorAll('.pd-menu-item')].find((n) =>
      n.textContent?.includes('Subagents'),
    );
    await click(subagents ?? null);
    expect(c.getState().tabs[3]?.kind).toBe('subagent');
  });

  it('+ menu routes the chosen kind through onNewTab', async () => {
    const c = seededController();
    const onNewTab = vi.fn();
    const { container } = await render(<CanvasTabs controller={c} onNewTab={onNewTab} />);
    await click(container.querySelector('.pd-canvas-newtab'));
    const terminal = [...container.querySelectorAll('.pd-menu-item')].find((n) =>
      n.textContent?.includes('Terminal'),
    );
    await click(terminal ?? null);
    expect(onNewTab).toHaveBeenCalledWith('terminal');
    // The handler owns creation → the canvas does not open a tab itself.
    expect(c.getState().tabs).toHaveLength(3);
  });

  it('places the new-tab + immediately after the ACTIVE tab', async () => {
    const c = seededController(); // active is the last (image "Render") tab
    const { container } = await render(<CanvasTabs controller={c} />);
    // The + lives inside the active tab's slot (not in the right-hand controls).
    const activeSlot = container
      .querySelector('.pd-canvas-tab[data-active]')
      ?.closest('.pd-canvas-tab-slot');
    expect(activeSlot?.querySelector('.pd-canvas-newtab')).toBeTruthy();
    expect(container.querySelector('.pd-canvas-tabbar-controls [aria-label="New tab"]')).toBeNull();
    // Only the active tab carries a +.
    expect(container.querySelectorAll('.pd-canvas-newtab')).toHaveLength(1);

    // Focus the FIRST tab → the + follows it now.
    await click(container.querySelector('.pd-canvas-tab-main'));
    const firstSlot = container.querySelectorAll('.pd-canvas-tab-slot')[0];
    expect(firstSlot?.querySelector('.pd-canvas-newtab')).toBeTruthy();
  });

  it('renders the per-kind operation bar for the active tab', async () => {
    const c = seededController(); // active image tab → media operation bar
    const { container } = await render(<CanvasTabs controller={c} />);
    const opbar = container.querySelector('.pd-canvas-opbar');
    expect(opbar?.getAttribute('data-kind')).toBe('image');
    expect(opbar?.querySelector('.pd-media-title')?.textContent).toContain('Render');

    // Switch to the browser tab → browser operation bar (URL + nav).
    await click(container.querySelector('.pd-canvas-tab-main'));
    expect(container.querySelector('.pd-canvas-opbar[data-kind="browser"]')).toBeTruthy();
    expect(container.querySelector('.pd-canvas-opbar .pd-browser-url')).toBeTruthy();
  });

  it('routes the operation-bar media download through the handler contract', async () => {
    const c = seededController(); // active image tab
    const onMediaDownload = vi.fn();
    const { container } = await render(
      <CanvasTabs controller={c} handlers={{ onMediaDownload }} />,
    );
    await click(container.querySelector('.pd-canvas-opbar .pd-media-download button'));
    expect(onMediaDownload).toHaveBeenCalledWith('t3', 'PNG');
  });

  it('drops the fullscreen, ›› minimize, and left-sidebar controls from the bar', async () => {
    const c = seededController();
    const { container } = await render(<CanvasTabs controller={c} />);
    expect(container.querySelector('[aria-label="Expand to fullscreen"]')).toBeNull();
    expect(container.querySelector('[aria-label="Restore size"]')).toBeNull();
    expect(container.querySelector('[aria-label="Minimize canvas"]')).toBeNull();
    expect(container.querySelector('[aria-label="Toggle sidebar"]')).toBeNull();
  });

  it('panel-toggle shows an X (Close) when open and emits onCollapse', async () => {
    const c = seededController();
    const onCollapse = vi.fn();
    const { container } = await render(<CanvasTabs controller={c} onCollapse={onCollapse} />);
    // Open canvas → the toggle is a "Close canvas panel" control (X glyph, #16).
    await click(container.querySelector('[aria-label="Close canvas panel"]'));
    expect(onCollapse).toHaveBeenCalledTimes(1);
    // The app owns the slide; internal collapsed state is untouched.
    expect(c.getState().collapsed).toBe(false);
  });

  it('panel-toggle collapses to the restore rail (panel icon) when onCollapse is not wired', async () => {
    const c = seededController();
    const { container } = await render(<CanvasTabs controller={c} />);
    await click(container.querySelector('[aria-label="Close canvas panel"]'));
    expect(c.getState().collapsed).toBe(true);
    expect(container.querySelector('.pd-canvas-tabs--collapsed')).toBeTruthy();
    // The rail reopens the panel (panel icon → open).
    await click(container.querySelector('[aria-label="Open canvas panel"]'));
    expect(c.getState().collapsed).toBe(false);
  });

  it('panel-toggle glyph follows the app-owned panelOpen prop', async () => {
    const c = seededController();
    const { container, rerender } = await render(
      <CanvasTabs controller={c} panelOpen onCollapse={() => {}} />,
    );
    expect(container.querySelector('[aria-label="Close canvas panel"]')).toBeTruthy();
    await rerender(<CanvasTabs controller={c} panelOpen={false} onCollapse={() => {}} />);
    expect(container.querySelector('[aria-label="Open canvas panel"]')).toBeTruthy();
  });

  it('toggles a markdown file tab between rendered prose and raw source', async () => {
    const c = new CanvasController({ idFactory: () => 'f1' });
    c.openTab({
      kind: 'file',
      title: 'Doc',
      filePath: 'README.md',
      artifact: { id: 'a', filename: 'README.md', content: { kind: 'markdown', text: '# Hello' } },
    });
    const { container } = await render(<CanvasTabs controller={c} />);
    // Markdown defaults to rendered → prose, and the filename is NOT duplicated
    // in the surface (only the op-bar breadcrumb names it — #12).
    expect(container.querySelector('.pd-canvas-markdown')).toBeTruthy();
    expect(container.querySelector('.pd-file-name')).toBeNull();
    // Switch to Raw → the CodeMirror source viewer.
    const raw = [...container.querySelectorAll('.pd-segment')].find((n) => n.textContent === 'Raw');
    await click(raw ?? null);
    expect(container.querySelector('.cm-editor')).toBeTruthy();
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
