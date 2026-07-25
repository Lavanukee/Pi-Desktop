/**
 * Renderer crash recovery — the app must never need a force quit.
 *
 * When a window's renderer PROCESS dies (V8 heap OOM, a GPU/driver reset, a
 * native crash), Electron does NOT destroy the WebContents and does not reload
 * it. The window simply paints its `backgroundColor` forever — jedd's report:
 * "the whole app just gets bricked and goes totally blank solid color screen,
 * pressing cmd r doesn't do anything either, app has to be quit." Cmd+R is inert
 * for the same reason the page is blank: the process that would service the
 * accelerator no longer exists, so recovery has to come from the MAIN process.
 *
 * (A stale comment in canvas/browser-manager.ts claimed "the app renderer has
 * the same recovery in pi/pi-sessions.ts" — it does not. That handler only LOGS
 * and keeps the pi bridge alive *for* a reload, expecting someone else to
 * trigger one. Nobody did. This module is that someone.)
 *
 * Policy: reload once, immediately, and stay quiet about it — a transparent
 * recovery beats a dialog. But a page that dies *on load* would reload forever,
 * so repeated deaths inside {@link CRASH_COOLDOWN_MS} are counted and recovery
 * stops after {@link MAX_CONSECUTIVE_RECOVERIES}, leaving the window as-is with
 * a loud log rather than pinning a CPU in a crash loop. A clean exit (an orderly
 * teardown / app quit) is never treated as a crash.
 *
 * Pure and injectable so the policy is unit-testable without Electron.
 */

/** Deaths closer together than this are treated as one repeating failure. */
export const CRASH_COOLDOWN_MS = 10_000;
/** Consecutive rapid deaths before we stop trying (a reload storm helps nobody). */
export const MAX_CONSECUTIVE_RECOVERIES = 3;

/** The subset of Electron's `render-process-gone` details we act on. */
export interface RenderProcessGoneDetails {
  readonly reason: string;
  readonly exitCode?: number;
}

export interface RendererRecoveryDeps {
  /** Reload the dead WebContents. */
  readonly reload: () => void;
  /** True when the WebContents is already torn down (never recover those). */
  readonly isDestroyed: () => boolean;
  /** Injected clock (tests). */
  readonly now: () => number;
  readonly log: (message: string, meta: Record<string, unknown>) => void;
}

export interface RendererRecovery {
  /** Feed an Electron `render-process-gone` event. Returns what was decided. */
  onRenderProcessGone: (details: RenderProcessGoneDetails) => 'reloaded' | 'ignored' | 'gave-up';
}

export function createRendererRecovery(deps: RendererRecoveryDeps): RendererRecovery {
  let lastRecoveryAt: number | undefined;
  let consecutive = 0;

  return {
    onRenderProcessGone: (details) => {
      // An orderly shutdown is not a crash (fires on quit / deliberate close).
      if (details.reason === 'clean-exit') return 'ignored';
      // Torn down: there is nothing left to reload.
      if (deps.isDestroyed()) return 'ignored';

      const now = deps.now();
      const rapid = lastRecoveryAt !== undefined && now - lastRecoveryAt < CRASH_COOLDOWN_MS;
      consecutive = rapid ? consecutive + 1 : 1;
      lastRecoveryAt = now;

      if (consecutive > MAX_CONSECUTIVE_RECOVERIES) {
        deps.log('renderer died repeatedly; giving up on auto-recovery', {
          reason: details.reason,
          exitCode: details.exitCode,
          consecutive,
        });
        return 'gave-up';
      }

      deps.log('renderer process gone; reloading to recover', {
        reason: details.reason,
        exitCode: details.exitCode,
        consecutive,
      });
      deps.reload();
      return 'reloaded';
    },
  };
}
