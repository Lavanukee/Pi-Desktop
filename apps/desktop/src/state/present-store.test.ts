import { beforeEach, describe, expect, it } from 'vitest';
import { classifyPresented, extOf, usePresentStore } from './present-store';

describe('classifyPresented', () => {
  it('opens an image as an image', () => {
    expect(classifyPresented('/a/logo.png')).toEqual({ kind: 'image', tab: 'image' });
  });

  it('renders a page rather than showing its source', () => {
    expect(classifyPresented('/a/index.html')).toEqual({ kind: 'page', tab: 'html' });
  });

  /* The Godot run wrote 14 files and opened none. A tree is the surface that
   * makes "does this actually contain a game?" answerable at a glance. */
  it('treats an extensionless path as a project, opened as a tree', () => {
    expect(classifyPresented('/a/platformer_game')).toEqual({ kind: 'project', tab: 'filetree' });
  });

  it('falls back to a plain file surface for anything unknown', () => {
    expect(classifyPresented('/a/thing.bin')).toEqual({ kind: 'file', tab: 'file' });
  });

  it('is case-insensitive about extensions', () => {
    expect(classifyPresented('/a/SHOT.PNG').kind).toBe('image');
  });
});

describe('extOf', () => {
  it('ignores dots in parent directories', () => {
    expect(extOf('/a.b/c/file')).toBe('');
  });
  it('takes the last extension', () => {
    expect(extOf('/a/x.tar.gz')).toBe('gz');
  });
});

describe('usePresentStore', () => {
  beforeEach(() => usePresentStore.getState().clear());

  it('records what was presented, with its kind', () => {
    usePresentStore.getState().add({ path: '/a/logo.png', note: 'third pass' });
    const [item] = usePresentStore.getState().items;
    expect(item).toMatchObject({ path: '/a/logo.png', kind: 'image', note: 'third pass' });
  });

  /* Iterating on one artefact is the normal case — present, look, fix, present
   * again. That must update the row, not stack duplicates. */
  it('replaces a re-presented artefact instead of duplicating it', () => {
    const s = usePresentStore.getState();
    s.add({ path: '/a/logo.png', note: 'first' });
    s.add({ path: '/a/other.png' });
    s.add({ path: '/a/logo.png', note: 'fixed' });
    const items = usePresentStore.getState().items;
    expect(items).toHaveLength(2);
    expect(items[items.length - 1]).toMatchObject({ path: '/a/logo.png', note: 'fixed' });
  });

  it('keeps presentation order', () => {
    const s = usePresentStore.getState();
    s.add({ path: '/a/1.png' });
    s.add({ path: '/a/2.png' });
    expect(usePresentStore.getState().items.map((i) => i.path)).toEqual(['/a/1.png', '/a/2.png']);
  });
});
