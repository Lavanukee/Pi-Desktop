/**
 * Open a LIVE view of a corp run's in-progress file in the canvas — the "peek at
 * what we have so far" for ONE file (the owner's bar (b): a clicked/active file
 * edit shows the file live in the canvas). The corp workspace lives in a temp dir
 * the renderer can't address by absolute path, so the content comes from the
 * neutral {@link ProductPeek} (`peekCorpTask`) rather than a disk read; the tab
 * shows it as a streaming file surface while the write is in flight (it reconciles
 * appended text and auto-scrolls to the newest line).
 */
import type { CanvasController } from '@pi-desktop/canvas';
import { peekCorpTask } from '../../state/corp-connect';
import { fileArtifactFromText } from '../canvas/file-tabs';

/** Stable canvas-tab key for a corp workspace file — open-or-focus by its path. */
export function corpFileTabKey(relPath: string): string {
  return `corpfile:${relPath}`;
}

/** The last path segment (the filename shown in the tab bar). */
function baseName(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

/**
 * Open (or refresh) the canvas file tab for `relPath`, reading the current bytes
 * out of the run's product peek. Best-effort: a peek miss shows an empty surface
 * (the file may not have landed yet), never throws.
 */
export async function openCorpFileInCanvas(
  controller: CanvasController,
  taskId: string,
  relPath: string,
  working: boolean,
): Promise<void> {
  if (relPath.length === 0) return;
  const peek = await peekCorpTask(taskId);
  const file =
    peek?.files.find((f) => f.path === relPath) ??
    peek?.files.find((f) => f.path.endsWith(relPath)) ??
    null;
  const key = corpFileTabKey(relPath);
  controller.upsertTab(key, {
    kind: 'file',
    key,
    title: baseName(relPath),
    filePath: relPath,
    breadcrumb: relPath.split(/[/\\]/).filter(Boolean),
    streaming: working,
    artifact: fileArtifactFromText(relPath, file?.content ?? ''),
  });
}
