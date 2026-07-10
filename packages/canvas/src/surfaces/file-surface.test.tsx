import { describe, expect, it } from 'vitest';
import type { ArtifactContent } from '../model.ts';
import { render } from '../test-utils.tsx';
import { FileSurface } from './file-surface.tsx';

function text(body: string): ArtifactContent {
  return { kind: 'text', text: body, language: 'typescript' };
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

  it('renders markdown files as prose', async () => {
    const { container } = await render(
      <FileSurface content={{ kind: 'markdown', text: '# Title' }} filename="README.md" />,
    );
    expect(container.querySelector('.pd-canvas-markdown')).toBeTruthy();
    expect(container.textContent).toContain('Title');
  });
});
