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
  /**
   * Teardown for NON-pi children reaped in the SAME held quit window — the
   * inference utilityProcess+llama-server, the pi-mac helper, and PTYs. Kicked
   * off alongside the pi disposal and awaited (bounded by the same cap) before
   * `app.exit()`, so no llama-server / helper survives quit. Must always resolve
   * (never hang); the cap is the safety net. Runs on EVERY quit — even when no pi
   * bridge is alive — because these children outlive the per-window pi bridges.
   */
  extraTeardown?: () => Promise<void>;
}

export function installPiQuitHold(app: QuitHoldApp, opts: QuitHoldOptions): void {
  let quitting = false;
  app.on('before-quit', (event) => {
    if (quitting) return;
    const survivors = opts.bridges().filter((b) => b.alive);
    // Nothing left to reap (no live pi, no extra teardown) → let the quit
    // proceed after a best-effort dispose.
    if (survivors.length === 0 && opts.extraTeardown === undefined) {
      opts.disposeAll();
      return;
    }
    event.preventDefault();
    quitting = true;
    const exits = survivors.map((b) => b.whenExited());
    opts.disposeAll();
    // `extraTeardown` must never take down the quit: a synchronous throw or a
    // rejected promise is swallowed so the cap/exit path still runs.
    let extra: Promise<void>;
    try {
      extra = opts.extraTeardown?.() ?? Promise.resolve();
    } catch {
      extra = Promise.resolve();
    }
    const cap = new Promise<void>((resolve) => setTimeout(resolve, opts.graceMs + 250));
    const settled = Promise.all([Promise.all(exits), extra.catch(() => {})]);
    void Promise.race([settled, cap]).then(() => {
      for (const b of survivors) {
        if (b.alive) b.killNow();
      }
      // exit(), not quit(): quit() would re-enter before-quit.
      app.exit();
    });
  });
}
