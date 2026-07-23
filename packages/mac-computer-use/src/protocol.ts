/**
 * Wire protocol for the mac-agent bridge — the seam between the pi child (this
 * extension) and the Electron main process that owns the `pi-mac` Swift helper.
 *
 * Why a socket (identical rationale to browser-use/protocol.ts): pi extensions
 * run INSIDE the spawned pi child (a separate `ELECTRON_RUN_AS_NODE` process),
 * which cannot post CGEvents under the signed-bundle TCC identity. The app
 * therefore spawns `pi-mac` from MAIN (so the Accessibility + Screen-Recording
 * grants attribute to Pi Desktop.app, not the unstable pi-child exec path),
 * stands up a local line-delimited JSON-RPC server on a Unix-domain socket, and
 * publishes its path + a random token onto the child's env before spawn (see
 * apps/desktop/electron/mac/mac-agent.ts). The extension connects to that socket
 * and issues the methods below; the app runs them against the helper and returns
 * a response.
 *
 * Framing: one JSON object per line, `\n`-delimited, UTF-8. Pure types + string
 * constants so BOTH sides depend on it without coupling.
 */

/** Env var carrying the bridge socket path (Unix socket / Windows pipe). */
export const MAC_AGENT_SOCK_ENV = 'PI_MAC_SOCK';
/** Env var carrying the shared secret every request must echo. */
export const MAC_AGENT_TOKEN_ENV = 'PI_MAC_TOKEN';

/** RPC methods the app's bridge implements. */
export type MacAgentMethod =
  | 'check'
  | 'promptGrants'
  | 'snapshot'
  | 'click'
  | 'type'
  | 'key'
  | 'scroll'
  | 'launch'
  | 'screenshot'
  | 'bounds'
  | 'frontmost'
  | 'setDriving';

/** One request on the wire. */
export interface MacAgentRequest {
  readonly id: number;
  readonly token: string;
  readonly method: MacAgentMethod;
  readonly params?: Record<string, unknown>;
}

/** One response on the wire. Never throws across the boundary — failures are
 * `{ ok: false, error }` so tools can degrade instead of crashing. */
export interface MacAgentResponse {
  readonly id: number;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: string;
}

/** One indexed AX element as the model sees it (mirror of browser-use's
 * SnapshotElement). Coordinates are SCREEN points, resolved app-side by index. */
export interface MacElement {
  readonly index: number;
  readonly role: string;
  readonly name: string;
  readonly bbox: { x: number; y: number; w: number; h: number };
  readonly editable?: boolean;
  readonly focused?: boolean;
  readonly enabled?: boolean;
  readonly value?: string;
  readonly actions?: string[];
}

/** The snapshot payload returned by the `snapshot` method. */
export interface MacSnapshot {
  readonly app: string;
  /** PID of the resolved target app. Threaded back onto click/type so concurrent
   * sessions driving different apps resolve indices in their own namespace. */
  readonly pid?: number;
  readonly window: string;
  /** CGWindowID of the snapshotted window, when it is a window — lets the
   * screenshot target exactly that window (occluded / non-frontmost, focus-free). */
  readonly windowId?: number;
  readonly elements: MacElement[];
  readonly summary: {
    readonly app: string;
    readonly window: string;
    readonly elementCount: number;
    readonly truncated: boolean;
  };
  /** The snapshotted window's frame in global screen points (top-left origin),
   * when the root was a real window — drives the app's cursor overlay. */
  readonly windowBounds?: { x: number; y: number; w: number; h: number };
  /** Optional screenshot (present when requested). Per-window capture when a
   * windowId is known, else a whole-screen fallback. */
  readonly screenshot?: { path: string; base64?: string; mimeType?: string; windowId?: number };
}

/** The ack a click/type returns. `background: true` means the act ran with NO
 * focus steal — via Accessibility (AXPress / AXSetValue / AXConfirm) or via
 * pid-targeted event delivery (postToPid); false means it fell back to the
 * legacy foreground CGEvent path (shared-cursor click / focused keystroke).
 * `mode` names the concrete path taken. `x`/`y` echo the acted-on point
 * (screen points) so the app can animate the phantom cursor to it. */
export interface MacActAck {
  readonly found: boolean;
  readonly mode?: string;
  readonly background?: boolean;
  readonly submitted?: boolean;
  readonly x?: number;
  readonly y?: number;
}

/** Live window geometry returned by the `bounds` method (screen points). The
 * launch flow polls this until the opened app has a window; the overlay tracks
 * it; probes assert `frontmost` stays false for a background-controlled app. */
export interface MacWindowBounds {
  readonly ok: boolean;
  readonly app?: string;
  readonly pid?: number;
  readonly x?: number;
  readonly y?: number;
  readonly w?: number;
  readonly h?: number;
  readonly windowId?: number;
  readonly windowTitle?: string;
  readonly frontmost?: boolean;
  readonly error?: string;
}

/** The ack the bridge's `launch` method returns. A successful background
 * launch has waited for the app's window to exist, so `pid` (and usually
 * `bounds`) are resolved — the tool can snapshot immediately. */
export interface MacLaunchAck {
  readonly ok: boolean;
  readonly app: string;
  readonly pid?: number;
  readonly bounds?: MacWindowBounds;
  readonly error?: string;
}

/** TCC status returned by the `check` method. */
export interface MacTccStatus {
  readonly accessibility: boolean;
  readonly screenRecording: boolean;
}
