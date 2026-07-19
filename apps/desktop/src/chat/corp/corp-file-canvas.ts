/**
 * Open a LIVE view of a corp run's in-progress file in the canvas — the "peek at
 * what we have so far" for ONE file (the owner's bar (b): a clicked/active file
 * edit shows the file live in the canvas).
 *
 * The content comes FIRST from the store — the streaming write body the worker is
 * typing right now ({@link liveFileContentForPath}), so the file tab renders the
 * ACTUAL content growing character-by-character, identical to the normal chat's
 * streaming write tab. Only when nothing is being written in-store (e.g. a file a
 * tool produced whose body never streamed as text) do we fall back to the neutral
 * {@link ProductPeek} (`peekCorpTask`), since the workspace lives in a temp dir the
 * renderer can't address by absolute path. A peek/store miss NEVER blanks a tab
 * that already shows content (round-blindtest #10's rule, applied to corp).
 */
import type { Artifact, CanvasController, CanvasTabSpec } from '@pi-desktop/canvas';
import { peekCorpTask } from '../../state/corp-connect';
import { useCorpStore } from '../../state/corp-store';
import { fileArtifactFromText } from '../canvas/file-tabs';
import { liveFileContentForPath } from './corp-file-content';

/** Stable canvas-tab key for a corp workspace file — open-or-focus by its path. */
export function corpFileTabKey(relPath: string): string {
  return `corpfile:${relPath}`;
}

/** Stable canvas-tab key for a corp file's LIVE HTML preview (secondary to code). */
export function corpHtmlTabKey(relPath: string): string {
  return `corphtml:${relPath}`;
}

/** The last path segment (the filename shown in the tab bar). */
export function corpFileBaseName(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

/** Live +N/−N line counts for a corp file tab's diff badge (from the file block). */
export interface CorpFileCounts {
  addedLines: number;
  removedLines: number;
}

/** The shared base spec (kind/key/title/path/breadcrumb) for a corp file CODE tab
 * — the one shape both the on-demand open and the live routing hook build from. */
export function corpFileTabSpec(relPath: string): CanvasTabSpec {
  return {
    kind: 'file',
    key: corpFileTabKey(relPath),
    title: corpFileBaseName(relPath),
    filePath: relPath,
    breadcrumb: relPath.split(/[/\\]/).filter(Boolean),
  };
}

/** The streaming HTML artifact for a corp file's live preview surface — the same
 * `content.kind:'html'` shape a normal-chat html artifact carries, so the shared
 * {@link HtmlSurface} morphdom-patches it in place as the page builds. */
export function corpHtmlArtifact(relPath: string, html: string): Artifact {
  return {
    id: corpHtmlTabKey(relPath),
    title: `${corpFileBaseName(relPath)} · Preview`,
    filename: corpFileBaseName(relPath),
    content: { kind: 'html', text: html, mimeType: 'text/html' },
  };
}

/**
 * Open (first time) or refresh a corp file's live HTML PREVIEW tab from the given
 * html, WITHOUT stealing focus — the code tab stays focused; the preview updates
 * alongside / is one click away. A user-closed preview (in `openedHtml`) is not
 * reopened. Returns the preview tab id, or undefined when it was left closed.
 */
export function openOrUpdateCorpHtmlPreview(
  controller: CanvasController,
  relPath: string,
  html: string,
  openedHtml: Set<string>,
): void {
  const key = corpHtmlTabKey(relPath);
  const existing = controller.getState().tabs.find((t) => t.key === key);
  if (existing === undefined) {
    if (openedHtml.has(key)) return; // user closed it — leave it closed
    openedHtml.add(key);
    const prevActive = controller.getState().activeTabId;
    controller.upsertTab(key, {
      kind: 'html',
      key,
      title: `${corpFileBaseName(relPath)} · Preview`,
      artifact: corpHtmlArtifact(relPath, html),
    });
    // The preview is SECONDARY — restore focus to whatever was focused (the code
    // tab), so opening it never yanks the user off the file they're watching type.
    if (prevActive !== null) controller.focusTab(prevActive);
    return;
  }
  if (existing.artifact?.content.text !== html) {
    controller.updateTab(existing.id, { artifact: corpHtmlArtifact(relPath, html) });
  }
}

/**
 * Open (or refresh) the canvas file tab for `relPath`. Content is sourced from the
 * STORE first (the streaming write body the worker is typing), then the run's
 * product peek. Best-effort: a miss shows/keeps whatever is already there (a peek
 * miss must never blank a populated tab), never throws. When `counts` is given the
 * tab carries a live +N/−N diff badge.
 */
export async function openCorpFileInCanvas(
  controller: CanvasController,
  taskId: string,
  relPath: string,
  working: boolean,
  counts?: CorpFileCounts,
): Promise<void> {
  if (relPath.length === 0) return;
  const key = corpFileTabKey(relPath);

  // Live store content wins — the file the worker is typing right now.
  const live = liveFileContentForPath(useCorpStore.getState().workerBlocks, relPath);
  let content = live?.content;
  if (content === undefined) {
    const peek = await peekCorpTask(taskId);
    content =
      peek?.files.find((f) => f.path === relPath)?.content ??
      peek?.files.find((f) => f.path.endsWith(relPath))?.content;
  }

  const existing = controller.getState().tabs.find((t) => t.key === key);
  const spec: CanvasTabSpec = {
    ...corpFileTabSpec(relPath),
    streaming: working,
    ...(counts !== undefined
      ? { addedLines: counts.addedLines, removedLines: counts.removedLines }
      : {}),
  };
  // Only set/replace the artifact when we actually HAVE content — a miss must not
  // blank a tab that already shows the file (round-blindtest #10, corp edition).
  if (content !== undefined && content.length > 0) {
    spec.artifact = fileArtifactFromText(relPath, content);
  } else if (existing?.artifact === undefined) {
    spec.artifact = fileArtifactFromText(relPath, content ?? '');
  }
  controller.upsertTab(key, spec);
}
