import { describe, expect, it } from 'vitest';
import type { ArtifactContent } from '../model.ts';
import { render } from '../test-utils.tsx';
import { CodeSurface } from './code-surface.tsx';

function code(text: string): ArtifactContent {
  return { kind: 'code', text, language: 'javascript' };
}

describe('CodeSurface', () => {
  it('mounts a read-only CodeMirror viewer with the initial content', async () => {
    const { container } = await render(<CodeSurface content={code('const a = 1;')} streaming />);
    expect(container.querySelector('.cm-editor')).toBeTruthy();
    expect(container.textContent).toContain('const a = 1;');
  });

  it('streams appended text into the existing editor (no remount)', async () => {
    const { container, rerender } = await render(
      <CodeSurface content={code('const a = 1;')} streaming />,
    );
    const editor = container.querySelector('.cm-editor');
    await rerender(<CodeSurface content={code('const a = 1;\nconst b = 2;')} streaming />);
    // Same editor element — appended, not rebuilt.
    expect(container.querySelector('.cm-editor')).toBe(editor);
    expect(container.textContent).toContain('const b = 2;');
  });
});
