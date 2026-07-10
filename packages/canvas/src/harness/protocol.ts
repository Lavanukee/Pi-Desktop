/**
 * The `pd-preview://` harness contract — the single source of truth shared by
 * the host React component (`HtmlSurface`), the in-iframe harness runtime
 * (`harness-entry.ts` → `harness/harness.js`), and the tests.
 *
 * ── Protocol (custom scheme the APP registers) ───────────────────────────────
 * The app registers a privileged, standard, secure custom protocol
 * `pd-preview://` in Electron whose handler serves the static files under this
 * package's `harness/` directory. The iframe's `src` is `PD_PREVIEW_HARNESS_URL`
 * (`pd-preview://canvas/index.html`). Because the scheme is registered
 * `standard`, the harness page gets a stable, opaque-to-the-app origin
 * (`pd-preview://canvas`) that is DISTINCT from the app origin — combined with a
 * frame sandbox of `allow-scripts` WITHOUT `allow-same-origin`, the frame cannot
 * reach the app origin, its cookies/storage, or the preload bridge.
 *
 * ── postMessage message shapes ───────────────────────────────────────────────
 * All messages carry `channel: 'pd-canvas'` so they never collide with other
 * postMessage traffic. The host posts to `iframe.contentWindow` with
 * `targetOrigin: '*'` (a sandboxed opaque origin cannot be named) and validates
 * inbound messages by `event.source === iframe.contentWindow`. The harness only
 * accepts messages whose `event.source === window.parent`.
 */
export const PD_CANVAS_CHANNEL = 'pd-canvas' as const;

export const PD_PREVIEW_SCHEME = 'pd-preview' as const;
/** The authority/host segment the protocol handler answers for. */
export const PD_PREVIEW_HARNESS_HOST = 'canvas' as const;
/** Path the protocol handler maps to `harness/index.html`. */
export const PD_PREVIEW_HARNESS_PATH = '/index.html' as const;
/** The full URL the app serves and the iframe loads by default. */
export const PD_PREVIEW_HARNESS_URL =
  `${PD_PREVIEW_SCHEME}://${PD_PREVIEW_HARNESS_HOST}${PD_PREVIEW_HARNESS_PATH}` as const;

/** Host → frame: apply an HTML snapshot in place (morphdom patch, no reload). */
export interface PatchMessage {
  channel: typeof PD_CANVAS_CHANNEL;
  type: 'patch';
  /** Monotonic sequence id; the frame echoes it back in `applied`. */
  seq: number;
  /** The FULL current HTML snapshot (body markup) — the harness diffs it. */
  html: string;
}

/** Host → frame: clear the document back to an empty body. */
export interface ResetMessage {
  channel: typeof PD_CANVAS_CHANNEL;
  type: 'reset';
}

/** Host → frame: liveness probe; the frame replies with `ready`. */
export interface PingMessage {
  channel: typeof PD_CANVAS_CHANNEL;
  type: 'ping';
}

export type HostToFrameMessage = PatchMessage | ResetMessage | PingMessage;

/** Frame → host: harness booted and is ready to receive patches. */
export interface ReadyMessage {
  channel: typeof PD_CANVAS_CHANNEL;
  type: 'ready';
}

/** Frame → host: a patch with `seq` was applied. */
export interface AppliedMessage {
  channel: typeof PD_CANVAS_CHANNEL;
  type: 'applied';
  seq: number;
}

/** Frame → host: a patch failed to apply. */
export interface ErrorMessage {
  channel: typeof PD_CANVAS_CHANNEL;
  type: 'error';
  message: string;
  seq?: number;
}

/** Frame → host: content height changed (optional auto-sizing hint). */
export interface ResizeMessage {
  channel: typeof PD_CANVAS_CHANNEL;
  type: 'resize';
  height: number;
}

export type FrameToHostMessage = ReadyMessage | AppliedMessage | ErrorMessage | ResizeMessage;

function isChannelMessage(data: unknown): data is { channel: string; type: string } {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { channel?: unknown }).channel === PD_CANVAS_CHANNEL &&
    typeof (data as { type?: unknown }).type === 'string'
  );
}

export function isHostToFrameMessage(data: unknown): data is HostToFrameMessage {
  if (!isChannelMessage(data)) return false;
  return data.type === 'patch' || data.type === 'reset' || data.type === 'ping';
}

export function isFrameToHostMessage(data: unknown): data is FrameToHostMessage {
  if (!isChannelMessage(data)) return false;
  return (
    data.type === 'ready' ||
    data.type === 'applied' ||
    data.type === 'error' ||
    data.type === 'resize'
  );
}
