import { EditorView } from '@codemirror/view';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ArtifactContent } from '../model.ts';
import { render } from '../test-utils.tsx';
import { CodeSurface, rawSourceContent } from './code-surface.tsx';

function code(text: string): ArtifactContent {
  return { kind: 'code', text, language: 'javascript' };
}

describe('CodeSurface', () => {
  it('mounts a read-only CodeMirror viewer with the initial content', async () => {
    const { container } = await render(<CodeSurface content={code('const a = 1;')} streaming />);
    expect(container.querySelector('.cm-editor')).toBeTruthy();
    expect(container.textContent).toContain('const a = 1;');
    // Read-only by default: the content DOM is not editable.
    expect(container.querySelector('.cm-content')?.getAttribute('contenteditable')).not.toBe(
      'true',
    );
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

  it('is editable and emits onChange on a user edit when editable', async () => {
    const onChange = vi.fn();
    const { container } = await render(
      <CodeSurface content={code('a')} streaming={false} editable onChange={onChange} />,
    );
    const dom = container.querySelector<HTMLElement>('.cm-editor');
    expect(container.querySelector('.cm-content')?.getAttribute('contenteditable')).toBe('true');
    const view = dom ? EditorView.findFromDOM(dom) : null;
    expect(view).toBeTruthy();
    await act(async () => {
      view?.dispatch({ changes: { from: 1, insert: 'b' }, userEvent: 'input.type' });
    });
    expect(onChange).toHaveBeenCalledWith('ab');
  });

  it('becomes editable + ⌘S-saveable when editable flips true after streaming (no remount) [SB-5]', async () => {
    const onChange = vi.fn();
    const onSave = vi.fn();
    // A tab that is still streaming: read-only, editable=false.
    const { container, rerender } = await render(
      <CodeSurface
        content={code('x')}
        streaming
        editable={false}
        onChange={onChange}
        onSave={onSave}
      />,
    );
    const before = container.querySelector('.cm-editor');
    expect(container.querySelector('.cm-content')?.getAttribute('contenteditable')).not.toBe(
      'true',
    );

    // Stream finishes → editable flips true on the SAME surface (no tab switch,
    // no remount). Previously the mount-once [] effect never rebuilt, so the tab
    // stayed read-only until a tab switch remounted it.
    await rerender(
      <CodeSurface
        content={code('x')}
        streaming={false}
        editable
        onChange={onChange}
        onSave={onSave}
      />,
    );
    // Same editor element — the compartment was reconfigured, not remounted, so
    // scroll/selection survive.
    expect(container.querySelector('.cm-editor')).toBe(before);
    expect(container.querySelector('.cm-content')?.getAttribute('contenteditable')).toBe('true');

    // The edit extensions are now live: a user edit reaches onChange.
    const dom = container.querySelector<HTMLElement>('.cm-editor');
    const view = dom ? EditorView.findFromDOM(dom) : null;
    expect(view).toBeTruthy();
    await act(async () => {
      view?.dispatch({ changes: { from: 1, insert: 'y' }, userEvent: 'input.type' });
    });
    expect(onChange).toHaveBeenCalledWith('xy');
  });

  it('does NOT echo a programmatic (streaming) change back through onChange', async () => {
    const onChange = vi.fn();
    const { container, rerender } = await render(
      <CodeSurface content={code('a')} streaming={false} editable onChange={onChange} />,
    );
    // A prop-driven update (e.g. finalize-from-disk) is not a user edit.
    await rerender(
      <CodeSurface content={code('a-updated')} streaming={false} editable onChange={onChange} />,
    );
    expect(container.textContent).toContain('a-updated');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('coerces any content into a highlighted code payload for the raw view', () => {
    expect(rawSourceContent({ kind: 'svg', text: '<svg/>' })).toEqual({
      kind: 'code',
      text: '<svg/>',
      language: 'svg',
    });
    expect(rawSourceContent({ kind: 'html', text: '<b/>', language: 'html' }).language).toBe(
      'html',
    );
  });
});
