/**
 * Canvas FILE tabs (round-7). Two entry points share one set of helpers:
 *   - `useFileWriteCanvasRouting()` — watches the pi stream for file-writing
 *     tool calls (edit/write/patch + bash `>`/`>>`/`tee`) and opens a LIVE file
 *     tab per path: streaming while the write is in flight, finalized from disk
 *     on completion. Mounted alongside the artifact router in CanvasTabsPanel.
 *   - `openFileInCanvas()` — opens/focuses a file tab on demand (the file-tree
 *     panel's `onFileTreeSelect`), reading the file + its sibling tree from main.
 *
 * File content is read through the bounded `fs:read-file` IPC (size-capped,
 * binary-flagged); the file-tree panel is populated from `fs:list-tree`. Both
 * are best-effort — a failed read leaves whatever content we already showed.
 */
import {
  type Artifact,
  type CanvasController,
  type CanvasTabSpec,
  type FileTreeNode,
  useCanvasTabs,
} from '@pi-desktop/canvas';
import type { ChatMsg } from '@pi-desktop/engine';
import { useEffect, useRef } from 'react';
import { usePiStore } from '../../state/pi-slice';
import { basename, detectFileWrites, dirname } from './file-writes';

/** Stable upsert key for a file path → its canvas tab (open-or-focus by path). */
export function fileTabKey(absPath: string): string {
  return `file:${absPath}`;
}

/** Breadcrumb segments for the operation bar: relative to `cwd` when the file is
 * under it (so it reads "project / src / x.ts"), else the whole path. */
export function fileBreadcrumb(absPath: string, cwd: string | undefined): string[] {
  if (cwd && absPath.startsWith(`${cwd.replace(/\/+$/, '')}/`)) {
    const rel = absPath.slice(cwd.replace(/\/+$/, '').length + 1);
    const root = basename(cwd);
    return [root, ...rel.split(/[/\\]/).filter(Boolean)];
  }
  return absPath.split(/[/\\]/).filter(Boolean);
}

const MARKDOWN_EXT = new Set(['md', 'markdown', 'mdx']);

/** Extension → CodeMirror language id for the read-only code viewer. */
const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  css: 'css',
  scss: 'css',
  html: 'html',
  htm: 'html',
  svg: 'xml',
  xml: 'xml',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  sql: 'sql',
  md: 'markdown',
};

function extname(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase();
}

type ReadFileResult = {
  text: string | null;
  truncated: boolean;
  tooLarge: boolean;
  binary: boolean;
  bytes: number;
};

/** Build the file surface's Artifact from a bounded read result. Too-large /
 * binary files show a short note instead of the (missing) content. */
export function fileArtifact(absPath: string, read: ReadFileResult): Artifact {
  const filename = basename(absPath);
  const ext = extname(filename);
  if (read.binary) {
    return {
      id: fileTabKey(absPath),
      title: filename,
      filename,
      content: { kind: 'text', text: `Binary file (${read.bytes} bytes) — preview unavailable.` },
    };
  }
  if (read.tooLarge) {
    return {
      id: fileTabKey(absPath),
      title: filename,
      filename,
      content: {
        kind: 'text',
        text: `File is ${read.bytes} bytes — too large to preview live.\nOpen it with an external editor from the Open ▾ menu.`,
      },
    };
  }
  const isMarkdown = MARKDOWN_EXT.has(ext);
  return {
    id: fileTabKey(absPath),
    title: filename,
    filename,
    content: {
      kind: isMarkdown ? 'markdown' : 'code',
      text: read.text ?? '',
      language: LANGUAGE_BY_EXT[ext] ?? 'text',
    },
  };
}

/** An in-flight file artifact from content we already have (a whole-file write's
 * args), before the authoritative disk read lands. */
function hintArtifact(absPath: string, text: string): Artifact {
  return fileArtifact(absPath, {
    text,
    truncated: false,
    tooLarge: false,
    binary: false,
    bytes: text.length,
  });
}

async function readFile(absPath: string): Promise<ReadFileResult | null> {
  try {
    return await window.piDesktop.invoke('fs:read-file', { path: absPath });
  } catch {
    return null;
  }
}

async function readTree(rootDir: string): Promise<FileTreeNode[]> {
  try {
    const res = await window.piDesktop.invoke('fs:list-tree', { root: rootDir });
    // FsTreeNode is a structural mirror of FileTreeNode.
    return res.tree as unknown as FileTreeNode[];
  } catch {
    return [];
  }
}

/** Base spec (kind/key/title/path/breadcrumb) for a file tab. */
function fileTabSpec(absPath: string, cwd: string | undefined): CanvasTabSpec {
  return {
    kind: 'file',
    key: fileTabKey(absPath),
    title: basename(absPath),
    filePath: absPath,
    breadcrumb: fileBreadcrumb(absPath, cwd),
  };
}

/**
 * Open (or focus) a file tab and fill it from disk. Used by the file-tree
 * panel's select handler. Focuses the tab and un-collapses the canvas.
 */
export async function openFileInCanvas(
  controller: CanvasController,
  absPath: string,
  cwd?: string,
): Promise<void> {
  const key = fileTabKey(absPath);
  const existing = controller.getState().tabs.find((t) => t.key === key);
  if (existing) controller.focusTab(existing.id);
  else controller.upsertTab(key, { ...fileTabSpec(absPath, cwd), streaming: false });
  const [read, tree] = await Promise.all([readFile(absPath), readTree(dirname(absPath))]);
  const tab = controller.getState().tabs.find((t) => t.key === key);
  if (tab === undefined) return;
  controller.updateTab(tab.id, {
    streaming: false,
    fileTree: tree,
    ...(read ? { artifact: fileArtifact(absPath, read) } : {}),
  });
}

/**
 * Watch the stream for file writes and mirror each into a live canvas file tab.
 * A path is opened once (a user-closed tab is not nagged back open); subsequent
 * writes to it refresh quietly. While a write runs, we show any whole-file
 * content hint from the tool args; on completion we read the authoritative bytes
 * from disk and drop `streaming`.
 */
export function useFileWriteCanvasRouting(): void {
  const { controller } = useCanvasTabs();
  const messages = usePiStore((s) => s.messages) as ChatMsg[];
  const cwd = usePiStore((s) => s.session?.cwd ?? undefined);

  const opened = useRef<Set<string>>(new Set());
  const finalized = useRef<Set<string>>(new Set());

  useEffect(() => {
    for (const ev of detectFileWrites(messages, cwd)) {
      const key = fileTabKey(ev.path);
      const existing = controller.getState().tabs.find((t) => t.key === key);

      if (existing === undefined) {
        // Open once per path; a tab the user closed is not reopened.
        if (opened.current.has(key)) continue;
        opened.current.add(key);
        controller.upsertTab(key, {
          ...fileTabSpec(ev.path, cwd),
          streaming: ev.running,
          ...(ev.contentHint !== undefined
            ? { artifact: hintArtifact(ev.path, ev.contentHint) }
            : {}),
        });
        // Populate the file-tree panel in the background.
        void readTree(dirname(ev.path)).then((tree) => {
          const tab = controller.getState().tabs.find((t) => t.key === key);
          if (tab) controller.updateTab(tab.id, { fileTree: tree });
        });
      } else {
        // Live refresh: reflect the running flag + any newer content hint.
        const patch: Record<string, unknown> = {};
        if (existing.streaming !== ev.running) patch.streaming = ev.running;
        if (
          ev.contentHint !== undefined &&
          existing.artifact?.content.text !== ev.contentHint &&
          ev.running
        ) {
          patch.artifact = hintArtifact(ev.path, ev.contentHint);
        }
        if (Object.keys(patch).length > 0) controller.updateTab(existing.id, patch);
      }

      // Finalize once from disk when the write completes.
      if (!ev.running && !finalized.current.has(ev.callId)) {
        finalized.current.add(ev.callId);
        void readFile(ev.path).then((read) => {
          if (read === null) return;
          const tab = controller.getState().tabs.find((t) => t.key === key);
          if (tab)
            controller.updateTab(tab.id, {
              streaming: false,
              artifact: fileArtifact(ev.path, read),
            });
        });
      }
    }
  }, [messages, cwd, controller]);
}
