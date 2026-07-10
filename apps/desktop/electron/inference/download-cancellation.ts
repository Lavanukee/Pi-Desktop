/**
 * Pure download-cancellation bookkeeping + partial-file cleanup, extracted from
 * supervisor-entry.ts so the pause/cancel state machine and the `.part` discard
 * are unit-testable WITHOUT the utilityProcess parentPort side effects (the
 * entry module talks to parentPort at import time). Electron/IO-free: the file
 * ops are injected. See download-cancellation.test.ts.
 */

/** Why an in-flight download's AbortController was fired. `null` while running
 * normally — a genuine transfer error leaves it null so the catch distinguishes
 * a deliberate pause/cancel from a failure. */
export type DownloadIntent = 'pause' | 'cancel' | null;

/**
 * Tracks the single in-flight download's AbortController + its abort intent.
 * One download at a time: {@link begin} throws if one is already running, so the
 * UI can't fork two writers onto the same `.part`.
 */
export class DownloadCancellation {
  private controller: AbortController | null = null;
  private _intent: DownloadIntent = null;

  /** True while a download is in flight. */
  get running(): boolean {
    return this.controller !== null;
  }

  /** The current abort intent (`null` unless pause/cancel was requested). */
  get intent(): DownloadIntent {
    return this._intent;
  }

  /** Start a fresh download; returns the signal to thread into the transfer.
   * Callers guard on {@link running} first; calling while running throws. */
  begin(): AbortSignal {
    if (this.controller !== null) throw new Error('a download is already running');
    this.controller = new AbortController();
    this._intent = null;
    return this.controller.signal;
  }

  private abortWith(intent: 'pause' | 'cancel'): boolean {
    if (this.controller === null) return false;
    this._intent = intent;
    this.controller.abort();
    return true;
  }

  /** Abort but keep the `.part` (a later download resumes). No-op when idle. */
  pause(): boolean {
    return this.abortWith('pause');
  }

  /** Abort and mark for `.part` discard. No-op when idle. */
  cancel(): boolean {
    return this.abortWith('cancel');
  }

  /** Clear bookkeeping once a download settles (call in a `finally`). */
  clear(): void {
    this.controller = null;
    this._intent = null;
  }
}

/** A model's on-disk files, minimally typed for cleanup. */
export interface PartialFile {
  name: string;
  quant: string;
}

/**
 * Absolute `.part` sidecar paths for a model's files — all files, or just the
 * ones matching `quant`. `join` is injected (node:path.join in production).
 */
export function partialPaths(
  modelDir: string,
  files: readonly PartialFile[],
  quant: string | undefined,
  join: (dir: string, name: string) => string,
): string[] {
  const selected = quant !== undefined ? files.filter((f) => f.quant === quant) : files;
  return selected.map((f) => `${join(modelDir, f.name)}.part`);
}

/**
 * Unlink each `.part` sidecar so a cancelled download leaves nothing half-written
 * for a later resume to pick up. Tolerates already-absent files (the common
 * case: the transfer may never have flushed a `.part`).
 */
export async function discardPartials(
  paths: readonly string[],
  unlink: (p: string) => Promise<void>,
): Promise<void> {
  for (const p of paths) {
    await unlink(p).catch(() => {});
  }
}
