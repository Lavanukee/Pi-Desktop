/**
 * Wire protocol for the browser-agent bridge — the seam between the pi child
 * (this extension) and the Electron main process that owns the canvas browser
 * WebContentsView.
 *
 * Why a socket: pi extensions run INSIDE the spawned pi child (a separate
 * `ELECTRON_RUN_AS_NODE` process), which has no access to Electron's `ipcMain`
 * or the WebContentsView. The app therefore stands up a local line-delimited
 * JSON-RPC server on a Unix-domain socket and publishes its path + a random
 * token onto the child's env before spawn (see apps/desktop/electron/canvas/
 * browser-agent.ts, mirroring how afm-main.ts injects PI_AFM_HELPER_PATH). The
 * extension connects to that socket and issues the methods below; the app runs
 * them against the browser tab and returns a response.
 *
 * Framing: one JSON object per line, `\n`-delimited, UTF-8. This module is pure
 * types + string constants so BOTH sides can depend on it without coupling.
 */

/** Env var carrying the bridge socket path (Unix socket / Windows pipe). */
export const BROWSER_AGENT_SOCK_ENV = 'PI_BROWSER_AGENT_SOCK';
/** Env var carrying the shared secret every request must echo. */
export const BROWSER_AGENT_TOKEN_ENV = 'PI_BROWSER_AGENT_TOKEN';

/** The DOM attribute the perception snapshot stamps on each indexed element so
 * the app's action scripts can resolve `index → element` reliably (no coord
 * math, robust to re-query). Shared contract between the two packages. */
export const DATA_IDX_ATTR = 'data-pi-idx';

/** RPC methods the app's bridge implements. */
export type BrowserAgentMethod =
  | 'ensureTab'
  | 'navigate'
  | 'evaluate'
  | 'screenshot'
  | 'click'
  | 'clickElement'
  | 'type'
  | 'key'
  | 'back'
  | 'forward'
  | 'reload'
  | 'waitForLoad'
  | 'setDriving';

/** One request on the wire. */
export interface BrowserAgentRequest {
  readonly id: number;
  readonly token: string;
  readonly method: BrowserAgentMethod;
  readonly params?: Record<string, unknown>;
}

/** One response on the wire. Never throws across the boundary — failures are
 * `{ ok: false, error }` so tools can degrade instead of crashing. */
export interface BrowserAgentResponse {
  readonly id: number;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: string;
}

/** Basic tab state returned by ensureTab / navigate / waitForLoad. */
export interface TabState {
  readonly tabId: string;
  readonly url: string;
  readonly title: string;
}
