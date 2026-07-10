import { act } from 'react';
import { describe, expect, it } from 'vitest';
import type { ArtifactContent } from '../model.ts';
import { render } from '../test-utils.tsx';
import { FileSurface } from './file-surface.tsx';

function text(body: string): ArtifactContent {
  return { kind: 'text', text: body, language: 'typescript' };
}

/** Give a scroller a real, controllable geometry (jsdom does no layout). */
function stubScroller(el: HTMLElement, scrollHeight: number, clientHeight: number): void {
  let top = 0;
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = v;
    },
  });
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientHeight });
}

describe('FileSurface', () => {
  it('opens empty and fills incrementally while streaming (no remount)', async () => {
    const { container, rerender } = await render(
      <FileSurface content={text('')} filename="notes.ts" streaming />,
    );
    const editor = container.querySelector('.cm-editor');
    expect(editor).toBeTruthy();

    // First delta.
    await rerender(<FileSurface content={text('const a = 1;')} filename="notes.ts" streaming />);
    expect(container.querySelector('.cm-editor')).toBe(editor);
    expect(container.textContent).toContain('const a = 1;');

    // Second delta appends live.
    await rerender(
      <FileSurface content={text('const a = 1;\nconst b = 2;')} filename="notes.ts" streaming />,
    );
    expect(container.querySelector('.cm-editor')).toBe(editor);
    expect(container.textContent).toContain('const b = 2;');
  });

  it('renders its filename header', async () => {
    const { container } = await render(<FileSurface content={text('x')} filename="a/b/c.ts" />);
    expect(container.querySelector('.pd-file-name')?.textContent).toBe('a/b/c.ts');
  });

  it('renders markdown files as prose (rendered by default)', async () => {
    const { container } = await render(
      <FileSurface content={{ kind: 'markdown', text: '# Title' }} filename="README.md" />,
    );
    expect(container.querySelector('.pd-canvas-markdown')).toBeTruthy();
    expect(container.textContent).toContain('Title');
  });

  it('renders markdown as raw source in raw mode', async () => {
    const { container } = await render(
      <FileSurface
        content={{ kind: 'markdown', text: '# Title' }}
        filename="README.md"
        mode="raw"
      />,
    );
    expect(container.querySelector('.pd-canvas-markdown')).toBeNull();
    expect(container.querySelector('.cm-editor')).toBeTruthy();
  });

  it('omits the filename header when showFilename is false', async () => {
    const { container } = await render(
      <FileSurface content={text('x')} filename="a/b/c.ts" showFilename={false} />,
    );
    expect(container.querySelector('.pd-file-name')).toBeNull();
  });

  it('sticks to the newest line while the user is pinned at the bottom', async () => {
    const { container, rerender } = await render(
      <FileSurface content={text('line 1')} filename="log.txt" streaming />,
    );
    const scroller = container.querySelector<HTMLElement>('.cm-scroller');
    if (scroller === null) throw new Error('missing scroller');
    stubScroller(scroller, 500, 100);
    // A streaming delta while pinned (the default) snaps to the bottom.
    await rerender(<FileSurface content={text('line 1\nline 2')} filename="log.txt" streaming />);
    expect(scroller.scrollTop).toBe(500);
  });

  it('does NOT snap back after the user scrolls up mid-stream', async () => {
    const { container, rerender } = await render(
      <FileSurface content={text('line 1')} filename="log.txt" streaming />,
    );
    const scroller = container.querySelector<HTMLElement>('.cm-scroller');
    if (scroller === null) throw new Error('missing scroller');
    stubScroller(scroller, 500, 100);
    // The user scrolls UP: a wheel-up releases the pin, and a scroll event away
    // from the bottom keeps it released.
    await act(async () => {
      const wheel = new Event('wheel', { bubbles: true }) as WheelEvent;
      Object.defineProperty(wheel, 'deltaY', { value: -60, configurable: true });
      scroller.dispatchEvent(wheel);
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event('scroll'));
    });
    // A burst of streaming deltas must NOT yank the reader back to the bottom.
    await rerender(
      <FileSurface content={text('line 1\nline 2\nline 3')} filename="log.txt" streaming />,
    );
    expect(scroller.scrollTop).toBe(0);
  });
});
