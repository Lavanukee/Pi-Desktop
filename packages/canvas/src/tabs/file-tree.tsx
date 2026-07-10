import { FileExtIcon, IconChevronDown, IconChevronRight, IconSearch } from '@pi-desktop/ui';
import { type ReactNode, useMemo, useState } from 'react';
import { IconFolder } from '../tab-icons.tsx';
import type { FileTreeNode } from './tab-model.ts';

export type { FileTreeNode };

/**
 * Filter a file tree by a case-insensitive substring of the node NAME. A file is
 * kept when its name matches; a directory is kept when its name matches (whole
 * subtree retained) OR when any descendant matches (pruned to matching leaves +
 * their ancestors). An empty query returns the tree unchanged. Pure — exported
 * for unit tests and reuse.
 */
export function filterFileTree(nodes: FileTreeNode[], query: string): FileTreeNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return nodes;
  const walk = (list: FileTreeNode[]): FileTreeNode[] => {
    const out: FileTreeNode[] = [];
    for (const node of list) {
      const selfMatch = node.name.toLowerCase().includes(q);
      if (node.kind === 'dir') {
        // A matching dir keeps its whole subtree; otherwise keep only the
        // branches that lead to a match.
        const children = selfMatch ? (node.children ?? []) : walk(node.children ?? []);
        if (selfMatch || children.length > 0) out.push({ ...node, children });
      } else if (selfMatch) {
        out.push(node);
      }
    }
    return out;
  };
  return walk(nodes);
}

/** Collect the paths of every directory that has at least one descendant. */
function allDirPaths(nodes: FileTreeNode[], acc: Set<string> = new Set()): Set<string> {
  for (const node of nodes) {
    if (node.kind === 'dir') {
      acc.add(node.path);
      allDirPaths(node.children ?? [], acc);
    }
  }
  return acc;
}

export interface FileTreeProps {
  /** The tree to render (nested dirs + files). */
  tree: FileTreeNode[];
  /** Fired when a FILE node is chosen (rows for dirs toggle disclosure instead). */
  onSelect?: (node: FileTreeNode) => void;
  /** Path of the currently-open file, highlighted in the tree. */
  activePath?: string;
  /**
   * Optional top-level folder label (the file's directory OR a working/project
   * folder). When set, the whole `tree` nests under one expandable root row so
   * the top level is the chosen folder; the app supplies it.
   */
  rootLabel?: string;
  /** Path for the synthetic root row (defaults to `rootLabel`). */
  rootPath?: string;
  className?: string;
}

/**
 * FileTree — the filterable file panel the file operation bar toggles (img59): a
 * "Filter files…" input over a nested list with folder disclosure and per-file
 * extension icons. Directories expand/collapse; files emit `onSelect`. When a
 * filter is active every surviving directory is force-expanded so matches show.
 */
export function FileTree({
  tree,
  onSelect,
  activePath,
  rootLabel,
  rootPath,
  className,
}: FileTreeProps) {
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  // With a rootLabel, nest the whole tree under a single expandable root folder
  // so the top level is the chosen project/working folder (open by default).
  const displayTree = useMemo<FileTreeNode[]>(
    () =>
      rootLabel
        ? [{ name: rootLabel, path: rootPath ?? rootLabel, kind: 'dir', children: tree }]
        : tree,
    [tree, rootLabel, rootPath],
  );
  const filtered = useMemo(() => filterFileTree(displayTree, query), [displayTree, query]);
  const filtering = query.trim().length > 0;
  // While filtering, ignore the manual collapse set so every match is visible.
  const expandedDirs = useMemo(
    () => (filtering ? allDirPaths(filtered) : null),
    [filtering, filtered],
  );

  const isOpen = (node: FileTreeNode): boolean =>
    expandedDirs ? expandedDirs.has(node.path) : !collapsed.has(node.path);

  const toggle = (node: FileTreeNode): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(node.path)) next.delete(node.path);
      else next.add(node.path);
      return next;
    });
  };

  const rows: ReactNode[] = [];
  const pushRows = (list: FileTreeNode[], depth: number): void => {
    for (const node of list) {
      const open = node.kind === 'dir' && isOpen(node);
      rows.push(
        <button
          key={node.path}
          type="button"
          className="pd-file-tree-row"
          data-kind={node.kind}
          data-active={node.path === activePath || undefined}
          style={{ paddingInlineStart: `calc(${depth} * var(--pd-space-md) + var(--pd-space-xs))` }}
          onClick={() => (node.kind === 'dir' ? toggle(node) : onSelect?.(node))}
        >
          <span className="pd-file-tree-caret" aria-hidden="true">
            {node.kind === 'dir' ? (
              open ? (
                <IconChevronDown size={12} />
              ) : (
                <IconChevronRight size={12} />
              )
            ) : null}
          </span>
          <span className="pd-file-tree-glyph" aria-hidden="true">
            {node.kind === 'dir' ? (
              <IconFolder size={14} />
            ) : (
              <FileExtIcon ext={ext(node.name)} size={16} />
            )}
          </span>
          <span className="pd-file-tree-name">{node.name}</span>
        </button>,
      );
      if (node.kind === 'dir' && open) pushRows(node.children ?? [], depth + 1);
    }
  };
  pushRows(filtered, 0);

  const rootClass = ['pd-file-tree', className].filter(Boolean).join(' ');
  return (
    <div className={rootClass}>
      <div className="pd-file-tree-filter">
        <IconSearch size={14} />
        <input
          className="pd-file-tree-input"
          type="text"
          placeholder="Filter files…"
          aria-label="Filter files"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className="pd-file-tree-list pd-scroll" role="tree">
        {rows.length > 0 ? (
          rows
        ) : (
          <p className="pd-file-tree-empty">{filtering ? 'No matching files' : 'No files'}</p>
        )}
      </div>
    </div>
  );
}

/** Bare extension (no dot) for the file-ext badge; '' when there is none. */
function ext(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1) : '';
}
