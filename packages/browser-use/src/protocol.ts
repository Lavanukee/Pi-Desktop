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
  | 'setDriving'
  // Canvas-awareness (round-10): the model asks "what is on the canvas right
  // now?" before every LLM call. MAIN answers from the renderer-reported
  // snapshot, enriching browser url/title from the live WebContentsView.
  | 'getCanvasState';

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

/**
 * One surface open on the canvas, described compactly for the model's context
 * (the `<canvas_state>` block). Every field is optional except `kind` so the
 * renderer only sends what a given surface actually has; MAIN enriches the
 * browser `url`/`title` from the authoritative live view keyed by `tabId`.
 */
export interface CanvasSurfaceState {
  /**
   * Surface kind — mirrors @pi-desktop/canvas's `CanvasTabKind` (browser | file
   * | terminal | image | pdf | html | svg | markdown | code | subagent |
   * filetree). Kept a bare string so this pure protocol module never imports the
   * canvas React package.
   */
  readonly kind: string;
  /** Tab title shown to the user. */
  readonly title?: string;
  /** Browser: the tab id MAIN uses to enrich url/title from the live view. */
  readonly tabId?: string;
  /** Browser: current URL. */
  readonly url?: string;
  /** File/code: the open file's path. */
  readonly filePath?: string;
  /** File/code: a short, length-capped excerpt of the file contents. */
  readonly excerpt?: string;
  /** File/code: unsaved edits or an in-flight write. */
  readonly dirty?: boolean;
  /** Terminal: working directory. */
  readonly cwd?: string;
  /** Terminal: the most recent command, when known. */
  readonly lastCommand?: string;
  /** Media (image/pdf): the media MIME/type label. */
  readonly mediaType?: string;
}

/**
 * A compact snapshot of everything on the canvas right now — the model's "what
 * is the user looking at" context. Reported renderer→main over
 * `canvas:report-state`, cached per-window, and served to the pi child via the
 * `getCanvasState` bridge method so the `context` hook can inject it.
 */
export interface CanvasState {
  /** The focused surface, or null when the canvas is empty. */
  readonly active: CanvasSurfaceState | null;
  /** The other open surfaces (excludes `active`), left→right. */
  readonly others: readonly CanvasSurfaceState[];
}
