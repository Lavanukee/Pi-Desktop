/**
 * Pure load/lifecycle policies for the main window, extracted from main.ts so
 * they unit-test in plain Node (quit-hold.ts precedent — main.ts injects the
 * real `app` / BrowserWindow state).
 */

export interface RendererTargetInput {
  /** `app.isPackaged` — packaged builds must never honor VITE_DEV_SERVER_URL. */
  isPackaged: boolean;
  devServerUrl: string | undefined;
  /** PI_E2E=1: threads the `?piE2E=1` opt-in that unlocks `window.__pi_store`
   * (see src/state/pi-connect.ts and tests/e2e/pi-probe.mjs). */
  e2e: boolean;
}

export type RendererTarget =
  | { kind: 'dev-server'; url: string }
  | { kind: 'packaged-file'; query: Record<string, string> | undefined };

/**
 * Decides what createMainWindow loads. Packaged builds ignore the dev-server
 * env var entirely: the window carries the full piDesktop bridge (pi:start
 * with arbitrary cwd → exec-capable agent), so anything able to set the app's
 * environment could otherwise point it at an arbitrary URL — and a stale
 * VITE_DEV_SERVER_URL would break a production launch even benignly. Note
 * will-navigate cannot cover this: loadURL is programmatic navigation.
 */
export function resolveRendererTarget(input: RendererTargetInput): RendererTarget {
  const query = input.e2e ? { piE2E: '1' } : undefined;
  const { devServerUrl } = input;
  if (input.isPackaged || devServerUrl === undefined || devServerUrl === '') {
    return { kind: 'packaged-file', query };
  }
  if (query === undefined) {
    return { kind: 'dev-server', url: devServerUrl };
  }
  const url = new URL(devServerUrl);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return { kind: 'dev-server', url: url.toString() };
}

/** Structural slice of BrowserWindow used by the second-instance policy. */
export interface RestorableWindow {
  isMinimized(): boolean;
  restore(): void;
  focus(): void;
}

/**
 * A second app launch must always surface a window. On macOS the app outlives
 * its last window (window-all-closed only quits elsewhere), so the tracked
 * window can be null while the single-instance lock is still held —
 * restore-or-focus alone would make the relaunch appear dead. Returns the
 * window that should become mainWindow; null only while the app is not yet
 * ready (the lock is acquired before whenReady, whose callback then creates
 * the first window itself).
 */
export function resolveSecondInstanceWindow<W extends RestorableWindow>(input: {
  isReady: boolean;
  window: W | null;
  createWindow: () => W;
}): W | null {
  if (input.window !== null) {
    if (input.window.isMinimized()) input.window.restore();
    input.window.focus();
    return input.window;
  }
  if (!input.isReady) return null;
  return input.createWindow();
}
