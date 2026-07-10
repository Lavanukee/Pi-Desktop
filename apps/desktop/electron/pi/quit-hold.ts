/**
 * App-quit hold for pi bridges. dispose()'s SIGTERM → SIGKILL ladder runs on
 * an unref'd timer that dies with the process, so a plain before-quit dispose
 * orphans any pi that ignores SIGTERM (e.g. wedged in native inference).
 * Instead: hold the quit, dispose, wait for real exits (capped just past the
 * kill grace), SIGKILL survivors, then exit for real.
 *
 * Structural app/bridge slices keep this module electron-free and testable in
 * plain Node; pi-main.ts injects the real `app` and bridge registry.
 */

/** Slice of PiBridge used by the hold. */
export interface QuitHoldBridge {
  readonly alive: boolean;
  whenExited(): Promise<void>;
  killNow(): void;
}

/** Slice of Electron's `app`. */
export interface QuitHoldApp {
  on(event: 'before-quit', listener: (event: { preventDefault(): void }) => void): void;
  exit(): void;
}

export interface QuitHoldOptions {
  /** Live view of the bridge registry (snapshotted before disposeAll empties it). */
  bridges: () => QuitHoldBridge[];
  disposeAll: () => void;
  /** The bridges' killGraceMs; the hold caps at this plus a small margin. */
  graceMs: number;
}

export function installPiQuitHold(app: QuitHoldApp, opts: QuitHoldOptions): void {
  let quitting = false;
  app.on('before-quit', (event) => {
    if (quitting) return;
    const survivors = opts.bridges().filter((b) => b.alive);
    if (survivors.length === 0) {
      opts.disposeAll();
      return;
    }
    event.preventDefault();
    quitting = true;
    const exits = survivors.map((b) => b.whenExited());
    opts.disposeAll();
    const cap = new Promise<void>((resolve) => setTimeout(resolve, opts.graceMs + 250));
    void Promise.race([Promise.all(exits), cap]).then(() => {
      for (const b of survivors) {
        if (b.alive) b.killNow();
      }
      // exit(), not quit(): quit() would re-enter before-quit.
      app.exit();
    });
  });
}
