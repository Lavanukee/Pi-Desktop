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
  type CanvasTabKind,
  type CanvasTabSpec,
  type FileTreeNode,
  type OpenWithApp,
  useCanvasTabs,
} from '@pi-desktop/canvas';
import type { ChatMsg } from '@pi-desktop/engine';
import { useEffect, useRef } from 'react';
import { usePiStore } from '../../state/pi-slice';
import { useProjectStore } from '../../state/project-store';
import { pdFileUrl, previewKindForExt } from './file-preview';
import { basename, detectFileWrites, dirname } from './file-writes';

/** Same `?piE2E=1` opt-in as the other E2E hooks — skips the real app-list
 * shell-out (sips/duti) so probes stay fast + deterministic. */
const IS_E2E = new URLSearchParams(window.location.search).has('piE2E');

/**
 * The file-tree root for a file tab: the active project's working folder (round-8
 * #15), else the session cwd, else the file's own directory. The label names the
 * top of the tree (the project / working folder).
 */
function treeRootFor(absPath: string, cwd: string | undefined): { root: string; label: string } {
  const root = useProjectStore.getState().activePath ?? cwd ?? dirname(absPath);
  return { root, label: basename(root) };
}

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
const HTML_EXT = new Set(['html', 'htm']);
const SVG_EXT = new Set(['svg']);

/**
 * The artifact content-kind for a file by extension — the RENDERABLE kinds
 * (markdown/html/svg) get their real kind so the canvas can offer a rendered↔raw
 * toggle (jedd); everything else is `code` (raw source only). The raw view still
 * works for the renderable kinds — it reads `content.text` with `language` below,
 * so an html file's Raw tab is syntax-highlighted HTML and its Rendered tab is
 * the live frame.
 */
function fileContentKind(ext: string): 'markdown' | 'html' | 'svg' | 'code' {
  if (MARKDOWN_EXT.has(ext)) return 'markdown';
  if (HTML_EXT.has(ext)) return 'html';
  if (SVG_EXT.has(ext)) return 'svg';
  return 'code';
}

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
  return {
    id: fileTabKey(absPath),
    title: filename,
    filename,
    content: {
      kind: fileContentKind(ext),
      text: read.text ?? '',
      language: LANGUAGE_BY_EXT[ext] ?? 'text',
    },
  };
}

/** A file artifact built from in-memory text (a whole-file write's args, or the
 * buffer a user just saved) — no disk round-trip. */
export function fileArtifactFromText(absPath: string, text: string): Artifact {
  return fileArtifact(absPath, {
    text,
    truncated: false,
    tooLarge: false,
    binary: false,
    bytes: text.length,
  });
}

/** An in-flight file artifact from content we already have (a whole-file write's
 * args), before the authoritative disk read lands. */
function hintArtifact(absPath: string, text: string): Artifact {
  return fileArtifactFromText(absPath, text);
}

async function readFile(absPath: string): Promise<ReadFileResult | null> {
  try {
    return await window.piDesktop.invoke('fs:read-file', { path: absPath });
  } catch {
    return null;
  }
}

/**
 * True when a read carries something DISPLAYABLE: real text (an empty file reads
 * as `''`, which counts), or a binary / too-large NOTICE. A bare `{ text: null }`
 * means the file couldn't be read (missing / vanished / raced), which carries
 * nothing — callers must NOT overwrite already-shown content with it (round-
 * blindtest #10: a failed read was blanking the file surface).
 */
function readHasContent(read: ReadFileResult | null): read is ReadFileResult {
  return read !== null && (read.text !== null || read.binary || read.tooLarge);
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Read a file, retrying a few times while it momentarily reads as MISSING. A
 * just-written file can lag its tool result by a beat (buffered write / atomic
 * rename), and a single read that lands in that gap otherwise leaves the tab
 * blank forever (round-blindtest #10). Returns the first usable read, else the
 * last attempt (so callers can still clear `streaming`).
 */
async function readFileSettled(absPath: string, attempts = 3): Promise<ReadFileResult | null> {
  let last: ReadFileResult | null = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = await readFile(absPath);
    if (readHasContent(last)) return last;
    if (attempt < attempts - 1) await delay(120 * (attempt + 1));
  }
  return last;
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

/** Base spec (kind/key/title/path/breadcrumb) for a file tab. Breadcrumb + tree
 * root follow the active project's working folder when set (round-8 #15/#6). */
function fileTabSpec(absPath: string, cwd: string | undefined): CanvasTabSpec {
  const { label } = treeRootFor(absPath, cwd);
  const base = useProjectStore.getState().activePath ?? cwd;
  return {
    kind: 'file',
    key: fileTabKey(absPath),
    title: basename(absPath),
    filePath: absPath,
    breadcrumb: fileBreadcrumb(absPath, base),
    fileTreeRootLabel: label,
  };
}

/** Spec for a binary MODALITY preview tab (image/video/audio/pdf/model/doc): a
 * media-style tab whose surface streams the file over `pd-file://`. It keeps the
 * same key/breadcrumb/tree-root as a file tab (so re-open focuses, and the
 * operation bar can still Open/Reveal the real file) and carries `filePath` for
 * that Open/Reveal targeting. `mediaType` picks the concrete renderer. */
function previewTabSpec(
  absPath: string,
  cwd: string | undefined,
  preview: { kind: CanvasTabKind; mediaType: string },
): CanvasTabSpec {
  const { label } = treeRootFor(absPath, cwd);
  const base = useProjectStore.getState().activePath ?? cwd;
  return {
    kind: preview.kind,
    key: fileTabKey(absPath),
    title: basename(absPath),
    filePath: absPath,
    breadcrumb: fileBreadcrumb(absPath, base),
    fileTreeRootLabel: label,
    mediaSrc: pdFileUrl(absPath),
    mediaType: preview.mediaType,
  };
}

/**
 * Fetch the system apps that can open this file (round-8 #14) and set the tab's
 * `defaultApp` + `openApps` so the "Open" split button shows the default's icon
 * and lists the rest. Lazy + best-effort; skipped under E2E (the real
 * sips/duti shell-out is slow + machine-specific — probes inject apps directly).
 */
async function hydrateOpenApps(
  controller: CanvasController,
  key: string,
  absPath: string,
): Promise<void> {
  if (IS_E2E) return;
  try {
    const res = await window.piDesktop.invoke('canvas:list-open-apps', { path: absPath });
    const tab = controller.getState().tabs.find((t) => t.key === key);
    if (tab === undefined) return;
    const apps = res.apps as OpenWithApp[];
    const defaultApp =
      res.defaultAppId !== null ? apps.find((a) => a.id === res.defaultAppId) : undefined;
    controller.updateTab(tab.id, { openApps: apps, ...(defaultApp ? { defaultApp } : {}) });
  } catch {
    // best-effort — the "Open" button still opens the OS default.
  }
}

/** Stable upsert key for the single full-canvas file-tree surface. */
const FILE_TREE_TAB_KEY = 'pi:files';

/**
 * Open (or focus) the full-canvas project FILE TREE surface (round-10 #4) — the
 * `+ › Files` entry point. Rooted at the active project's working folder (else
 * the session cwd); the tree is read from `fs:list-tree` and picking a file
 * routes through the tree's onSelect → `openFileInCanvas`. A stable key means
 * re-opening focuses the same surface instead of piling up (NOT a blank
 * "untitled" file, which was the bug).
 */
export async function openProjectFileTree(
  controller: CanvasController,
  cwd?: string,
): Promise<void> {
  const root = useProjectStore.getState().activePath ?? cwd ?? null;
  const label = root ? basename(root) : 'Files';
  controller.upsertTab(FILE_TREE_TAB_KEY, {
    kind: 'filetree',
    key: FILE_TREE_TAB_KEY,
    title: 'Files',
    fileTreeRootLabel: label,
  });
  if (root === null) return;
  const tree = await readTree(root);
  const tab = controller.getState().tabs.find((t) => t.key === FILE_TREE_TAB_KEY);
  if (tab) controller.updateTab(tab.id, { fileTree: tree });
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
  const preview = previewKindForExt(extname(basename(absPath)));
  const existing = controller.getState().tabs.find((t) => t.key === key);
  if (existing) controller.focusTab(existing.id);
  else if (preview !== null) controller.upsertTab(key, previewTabSpec(absPath, cwd, preview));
  else controller.upsertTab(key, { ...fileTabSpec(absPath, cwd), streaming: false });

  const { root } = treeRootFor(absPath, cwd);
  if (preview !== null) {
    // A binary modality (image/video/audio/pdf/3D/doc): the surface streams the
    // bytes over `pd-file://` — there is NOTHING to read as text. Still populate
    // the file tree + the "Open with" app list in the background.
    const tree = await readTree(root);
    const tab = controller.getState().tabs.find((t) => t.key === key);
    if (tab !== undefined) controller.updateTab(tab.id, { fileTree: tree });
    void hydrateOpenApps(controller, key, absPath);
    return;
  }

  const [read, tree] = await Promise.all([readFileSettled(absPath), readTree(root)]);
  const tab = controller.getState().tabs.find((t) => t.key === key);
  if (tab === undefined) return;
  controller.updateTab(tab.id, {
    streaming: false,
    fileTree: tree,
    // Only replace content with a read that actually loaded — a missing/raced
    // read must never blank the surface (round-blindtest #10).
    ...(readHasContent(read) ? { artifact: fileArtifact(absPath, read) } : {}),
  });
  void hydrateOpenApps(controller, key, absPath);
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
      const preview = previewKindForExt(extname(basename(ev.path)));
      const existing = controller.getState().tabs.find((t) => t.key === key);

      if (preview !== null) {
        // A binary modality write (image/pdf/3D/doc): there's no partial text to
        // stream and fetching a half-written file would flash an error, so open
        // the preview tab only when the write COMPLETES. A user-closed tab is not
        // reopened; a later write to an already-open tab reloads the bytes via a
        // cache-busting `?v=` (the pathname is unchanged, so the fence still hits).
        if (existing === undefined && !ev.running && !opened.current.has(key)) {
          opened.current.add(key);
          controller.upsertTab(key, previewTabSpec(ev.path, cwd, preview));
          const { root } = treeRootFor(ev.path, cwd);
          void readTree(root).then((tree) => {
            const tab = controller.getState().tabs.find((t) => t.key === key);
            if (tab) controller.updateTab(tab.id, { fileTree: tree });
          });
          void hydrateOpenApps(controller, key, ev.path);
        } else if (existing !== undefined && !ev.running && !finalized.current.has(ev.callId)) {
          finalized.current.add(ev.callId);
          controller.updateTab(existing.id, {
            streaming: false,
            mediaSrc: `${pdFileUrl(ev.path)}?v=${encodeURIComponent(ev.callId)}`,
          });
        }
        continue;
      }

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
        // Populate the file-tree panel (rooted at the working folder) + the
        // "Open with" app list in the background.
        const { root } = treeRootFor(ev.path, cwd);
        void readTree(root).then((tree) => {
          const tab = controller.getState().tabs.find((t) => t.key === key);
          if (tab) controller.updateTab(tab.id, { fileTree: tree });
        });
        void hydrateOpenApps(controller, key, ev.path);
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

      // Finalize once from disk when the write completes. Always drop the
      // `streaming` flag; only REPLACE the shown content with a read that
      // actually loaded (retried, since a fresh write can lag a beat) so a
      // missing/raced read never blanks the tab (round-blindtest #10).
      if (!ev.running && !finalized.current.has(ev.callId)) {
        finalized.current.add(ev.callId);
        void readFileSettled(ev.path).then((read) => {
          const tab = controller.getState().tabs.find((t) => t.key === key);
          if (tab === undefined) return;
          controller.updateTab(tab.id, {
            streaming: false,
            ...(readHasContent(read) ? { artifact: fileArtifact(ev.path, read) } : {}),
          });
        });
      }
    }
  }, [messages, cwd, controller]);
}

/**
 * Recover a file tab that became active while showing NOTHING — its first read
 * raced the write, or the file wasn't there yet — by re-reading from disk when
 * it gains focus and filling it once real content lands (round-blindtest #10:
 * "opened file → only line 1, no text"). Also picks up out-of-band changes when
 * the user revisits an empty tab.
 *
 * Deliberately scoped to EMPTY tabs (no artifact, or empty text) and never fires
 * while `streaming`, so it can NEVER clobber a populated tab's unsaved in-editor
 * edits — a populated tab is left exactly as the user last saw it.
 */
export function useFileTabRefresh(): void {
  const { controller, activeTabId, tabs } = useCanvasTabs();
  const active = tabs.find((t) => t.id === activeTabId);
  const filePath = active?.kind === 'file' ? active.filePath : undefined;
  const needsLoad =
    active?.kind === 'file' &&
    active.streaming !== true &&
    (active.artifact === undefined || active.artifact.content.text === '');

  useEffect(() => {
    if (filePath === undefined || !needsLoad) return;
    let cancelled = false;
    void readFileSettled(filePath).then((read) => {
      // Only fill when there's REAL text to show — an empty read leaves the
      // (already empty) tab untouched, and a still-missing read never blanks it.
      if (cancelled || !readHasContent(read) || read.text === null || read.text === '') return;
      const tab = controller.getState().tabs.find((t) => t.key === fileTabKey(filePath));
      if (tab !== undefined && tab.streaming !== true) {
        controller.updateTab(tab.id, { artifact: fileArtifact(filePath, read) });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [filePath, needsLoad, controller]);
}
