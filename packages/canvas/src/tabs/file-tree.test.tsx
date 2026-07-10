import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { click, render } from '../test-utils.tsx';
import { FileTree, filterFileTree } from './file-tree.tsx';
import type { FileTreeNode } from './tab-model.ts';

const tree: FileTreeNode[] = [
  {
    name: 'src',
    path: 'src',
    kind: 'dir',
    children: [
      { name: 'index.ts', path: 'src/index.ts', kind: 'file' },
      { name: 'app.tsx', path: 'src/app.tsx', kind: 'file' },
    ],
  },
  { name: 'README.md', path: 'README.md', kind: 'file' },
];

/** Type into the filter input via the native setter so onChange fires. */
async function typeFilter(input: HTMLInputElement | null, value: string): Promise<void> {
  if (!input) throw new Error('no filter input');
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setValue?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('filterFileTree', () => {
  it('returns the tree unchanged for an empty query', () => {
    expect(filterFileTree(tree, '')).toBe(tree);
  });

  it('keeps a matching file and its ancestor directory', () => {
    const out = filterFileTree(tree, 'index');
    expect(out).toHaveLength(1);
    expect(out[0]?.name).toBe('src');
    expect(out[0]?.children?.map((n) => n.name)).toEqual(['index.ts']);
  });

  it('keeps the whole subtree when a directory name matches', () => {
    const out = filterFileTree(tree, 'src');
    expect(out[0]?.children).toHaveLength(2);
  });

  it('is case-insensitive and prunes non-matches', () => {
    const out = filterFileTree(tree, 'README');
    expect(out).toEqual([{ name: 'README.md', path: 'README.md', kind: 'file' }]);
    expect(filterFileTree(tree, 'zzz')).toEqual([]);
  });
});

describe('FileTree', () => {
  it('renders directories expanded with their files', async () => {
    const { container } = await render(<FileTree tree={tree} />);
    const names = [...container.querySelectorAll('.pd-file-tree-name')].map((n) => n.textContent);
    expect(names).toEqual(['src', 'index.ts', 'app.tsx', 'README.md']);
  });

  it('collapses a directory when its row is clicked', async () => {
    const { container } = await render(<FileTree tree={tree} />);
    const srcRow = container.querySelector('.pd-file-tree-row[data-kind="dir"]');
    await click(srcRow);
    const names = [...container.querySelectorAll('.pd-file-tree-name')].map((n) => n.textContent);
    expect(names).toEqual(['src', 'README.md']);
  });

  it('emits onSelect for a file (not a directory)', async () => {
    const onSelect = vi.fn();
    const { container } = await render(<FileTree tree={tree} onSelect={onSelect} />);
    // Click the directory row first — should NOT select.
    await click(container.querySelector('.pd-file-tree-row[data-kind="dir"]'));
    expect(onSelect).not.toHaveBeenCalled();
    // README.md file row.
    const fileRows = container.querySelectorAll('.pd-file-tree-row[data-kind="file"]');
    await click(fileRows[fileRows.length - 1] ?? null);
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'README.md', kind: 'file' }),
    );
  });

  it('filters the tree from the "Filter files…" input', async () => {
    const { container } = await render(<FileTree tree={tree} />);
    await typeFilter(container.querySelector<HTMLInputElement>('.pd-file-tree-input'), 'index');
    const names = [...container.querySelectorAll('.pd-file-tree-name')].map((n) => n.textContent);
    expect(names).toEqual(['src', 'index.ts']);
  });

  it('shows an empty message when nothing matches', async () => {
    const { container } = await render(<FileTree tree={tree} />);
    await typeFilter(container.querySelector<HTMLInputElement>('.pd-file-tree-input'), 'zzz');
    expect(container.querySelector('.pd-file-tree-empty')?.textContent).toBe('No matching files');
  });

  it('nests the tree under a configurable root folder (#15)', async () => {
    const { container } = await render(<FileTree tree={tree} rootLabel="my-project" />);
    const names = [...container.querySelectorAll('.pd-file-tree-name')].map((n) => n.textContent);
    // The chosen folder is the top level, expanded by default over the tree.
    expect(names[0]).toBe('my-project');
    expect(names).toContain('src');
    // Collapsing the root hides everything beneath it.
    await click(container.querySelector('.pd-file-tree-row[data-kind="dir"]'));
    expect([...container.querySelectorAll('.pd-file-tree-name')].map((n) => n.textContent)).toEqual(
      ['my-project'],
    );
  });
});
