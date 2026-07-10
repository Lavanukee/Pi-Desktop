import { EditorSelection, EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { streamingUpdateSpec } from './code-append.ts';

function stateWith(doc: string, caret: number): EditorState {
  return EditorState.create({ doc, selection: EditorSelection.single(caret) });
}

describe('streamingUpdateSpec', () => {
  it('appends a streamed delta and preserves a caret before the edit', () => {
    const state = stateWith('const x =', 3);
    const spec = streamingUpdateSpec(state, 'const x = 1;');
    expect(spec).not.toBeNull();
    const next = state.update(spec ?? {}).state;
    expect(next.doc.toString()).toBe('const x = 1;');
    // Caret at column 3 is untouched by an append at the end.
    expect(next.selection.main.head).toBe(3);
  });

  it('keeps a caret parked at the old end when text is appended after it', () => {
    const state = stateWith('const x =', 9);
    const next = state.update(streamingUpdateSpec(state, 'const x = 1;') ?? {}).state;
    expect(next.selection.main.head).toBe(9);
  });

  it('returns null when the document already matches (no-op)', () => {
    const state = stateWith('done', 0);
    expect(streamingUpdateSpec(state, 'done')).toBeNull();
  });

  it('replaces only the diverging suffix on a mid-stream correction', () => {
    const state = stateWith('helo', 2);
    const next = state.update(streamingUpdateSpec(state, 'hello world') ?? {}).state;
    expect(next.doc.toString()).toBe('hello world');
    expect(next.selection.main.head).toBe(2);
  });
});
