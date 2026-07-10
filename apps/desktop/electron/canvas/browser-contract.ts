/**
 * Native browser-tab (WebContentsView) IPC contract. Pure types + a runtime
 * channel list — no electron/node imports — so the sandboxed preload bundle and
 * the renderer can both consume it (composed into ../ipc-contract.ts alongside
 * the pi contract). One WebContentsView per browser canvas tab is created,
 * positioned, and destroyed in the main process (electron/canvas/browser-manager.ts);
 * the renderer drives it over these channels and reflects `browser:state` events
 * back into the CanvasController so the URL bar + back/fwd/loading stay truthful.
 */

/** Window-space rect for a browser view (renderer client rect → window coords). */
export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type BrowserInvokeMap = {
  /** Create (idempotent) the tab's WebContentsView, attached to the sender window. */
  'browser:create': { request: { tabId: string }; response: { ok: boolean } };
  /** Destroy the tab's view and free its WebContents (tab closed). */
  'browser:destroy': { request: { tabId: string }; response: { ok: boolean } };
  /** Position the view over the content slot and show/hide it (tab switch = hide). */
  'browser:set-bounds': {
    request: { tabId: string; bounds: BrowserBounds; visible: boolean };
    response: { ok: boolean };
  };
  /** Navigate the view to `url` (URL bar submit or browser-use). */
  'browser:navigate': { request: { tabId: string; url: string }; response: { ok: boolean } };
  'browser:back': { request: { tabId: string }; response: { ok: boolean } };
  'browser:forward': { request: { tabId: string }; response: { ok: boolean } };
  'browser:reload': { request: { tabId: string }; response: { ok: boolean } };
  'browser:stop': { request: { tabId: string }; response: { ok: boolean } };

  // ── "Model drives the browser" seam (browser-use tools, a later feature) ──
  /** Screenshot the live page as a data URL (vision input for browser-use). */
  'browser:capture': { request: { tabId: string }; response: { dataUrl: string | null } };
  /** The page's serialized DOM (`document.documentElement.outerHTML`). */
  'browser:snapshot-dom': { request: { tabId: string }; response: { html: string | null } };
  /** Synthesize a left click at view-relative coords `(x, y)`. */
  'browser:click': { request: { tabId: string; x: number; y: number }; response: { ok: boolean } };
};

export const BROWSER_INVOKE_CHANNELS = [
  'browser:create',
  'browser:destroy',
  'browser:set-bounds',
  'browser:navigate',
  'browser:back',
  'browser:forward',
  'browser:reload',
  'browser:stop',
  'browser:capture',
  'browser:snapshot-dom',
  'browser:click',
] as const satisfies readonly (keyof BrowserInvokeMap)[];

/** Live navigation state pushed main → renderer; the renderer maps this onto
 * `controller.updateTab` so the browser chrome reflects the real WebContents. */
export interface BrowserStateEvent {
  tabId: string;
  url?: string;
  title?: string;
  loading?: boolean;
  canGoBack?: boolean;
  canGoForward?: boolean;
  /** Best-effort favicon URL (stored on the tab's free-form `data`). */
  faviconUrl?: string;
}

export type BrowserEventMap = {
  'browser:state': BrowserStateEvent;
};
