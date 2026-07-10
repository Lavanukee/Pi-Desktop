/**
 * Native browser-tab manager: one `WebContentsView` per browser canvas tab,
 * added to the sender window's `contentView`, positioned from the renderer's
 * reported content-slot rect, shown on mount / hidden on tab-switch, and
 * destroyed when the tab closes.
 *
 * ── W7 isolation invariant (docs/architecture.md, binding) ──────────────────
 * These views host arbitrary, untrusted web content, so the app preload is
 * NEVER attached (a fresh minimal WebPreferences with contextIsolation +
 * sandbox and no preload). They also run in a dedicated `persist:pi-browser`
 * session so their cookies/storage never mingle with the app. A view can reach
 * ipc/app channels only through a preload it does not have — the trusted-sender
 * registry (which only knows app windows) is the second line.
 *
 * ── "Model drives the browser" seam ─────────────────────────────────────────
 * `navigate` / `capture` / `snapshotDom` / `click` are exported on
 * {@link browserManager} so the future browser-use tool set can drive a tab
 * directly (the renderer flips `driving` on via controller.updateTab). Manual
 * browsing is fully wired today; the tool set is the later feature.
 */
import { createIpcEventSender, createLogger } from '@pi-desktop/shared';
import {
  BrowserWindow,
  type IpcMainInvokeEvent,
  ipcMain,
  type WebContents,
  WebContentsView,
} from 'electron';
import type { AppEventMap } from '../ipc-contract';
import { isTrustedIpcEvent } from '../trusted-senders';
import type { BrowserBounds, BrowserStateEvent } from './browser-contract';

const log = createLogger('desktop:browser');
const events = createIpcEventSender<AppEventMap>();

/** Dedicated session so browser-tab cookies/storage stay off the app origin. */
const BROWSER_PARTITION = 'persist:pi-browser';

interface Entry {
  view: WebContentsView;
  owner: WebContents;
  visible: boolean;
}

/** tabId → view. Ids are the CanvasController tab ids (renderer-owned). */
const entries = new Map<string, Entry>();
/** Owner windows we've wired a teardown listener on (avoid double-binding). */
const wiredOwners = new Set<number>();

function emitState(owner: WebContents, patch: BrowserStateEvent): void {
  if (!owner.isDestroyed()) events.send(owner, 'browser:state', patch);
}

/** Add https:// when the user typed a bare host; pass through explicit schemes. */
function normalizeUrl(raw: string): string {
  const value = raw.trim();
  if (value === '') return value;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value;
  return `https://${value}`;
}

function navState(wc: WebContents): Pick<BrowserStateEvent, 'url' | 'canGoBack' | 'canGoForward'> {
  return {
    url: wc.getURL(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
  };
}

function attachListeners(tabId: string, view: WebContentsView, owner: WebContents): void {
  const wc = view.webContents;
  const pushNav = (): void => emitState(owner, { tabId, ...navState(wc) });
  wc.on('did-navigate', pushNav);
  wc.on('did-navigate-in-page', pushNav);
  wc.on('did-start-loading', () => emitState(owner, { tabId, loading: true }));
  wc.on('did-stop-loading', () => emitState(owner, { tabId, loading: false, ...navState(wc) }));
  wc.on('page-title-updated', (_e, title) => emitState(owner, { tabId, title }));
  wc.on('page-favicon-updated', (_e, favicons) => {
    if (favicons[0]) emitState(owner, { tabId, faviconUrl: favicons[0] });
  });
  // Keep target=_blank / window.open in the same view — one tab, one view.
  wc.setWindowOpenHandler(({ url }) => {
    void wc.loadURL(url);
    return { action: 'deny' };
  });
}

/** Tear down every view a closing window owned. */
function wireOwnerTeardown(owner: WebContents): void {
  if (wiredOwners.has(owner.id)) return;
  wiredOwners.add(owner.id);
  owner.once('destroyed', () => {
    wiredOwners.delete(owner.id);
    for (const [tabId, entry] of [...entries]) {
      if (entry.owner === owner) destroyView(tabId);
    }
  });
}

/** Create the tab's view (idempotent), attached to the owner window's contentView. */
function ensureView(tabId: string, owner: WebContents): Entry | undefined {
  const existing = entries.get(tabId);
  if (existing) return existing;
  const win = BrowserWindow.fromWebContents(owner);
  if (win === null) {
    log.warn('browser:create with no owning window', { tabId });
    return undefined;
  }
  const view = new WebContentsView({
    webPreferences: {
      // NO app preload — untrusted web content (W7). Fresh, minimal, sandboxed.
      partition: BROWSER_PARTITION,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  view.setVisible(false);
  win.contentView.addChildView(view);
  const entry: Entry = { view, owner, visible: false };
  entries.set(tabId, entry);
  attachListeners(tabId, view, owner);
  wireOwnerTeardown(owner);
  log.info('browser view created', { tabId, wcId: view.webContents.id });
  return entry;
}

function setBounds(tabId: string, bounds: BrowserBounds, visible: boolean): void {
  const entry = entries.get(tabId);
  if (entry === undefined) return;
  entry.view.setBounds({
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(0, Math.round(bounds.width)),
    height: Math.max(0, Math.round(bounds.height)),
  });
  if (entry.visible !== visible) {
    entry.view.setVisible(visible);
    entry.visible = visible;
  }
}

function destroyView(tabId: string): void {
  const entry = entries.get(tabId);
  if (entry === undefined) return;
  entries.delete(tabId);
  try {
    BrowserWindow.fromWebContents(entry.owner)?.contentView.removeChildView(entry.view);
  } catch {
    // Owner window already gone — nothing to detach from.
  }
  if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
  log.info('browser view destroyed', { tabId });
}

function navigate(tabId: string, url: string): void {
  const entry = entries.get(tabId);
  if (entry === undefined) return;
  const target = normalizeUrl(url);
  if (target !== '') void entry.view.webContents.loadURL(target);
}

async function capture(tabId: string): Promise<string | null> {
  const entry = entries.get(tabId);
  if (entry === undefined) return null;
  const image = await entry.view.webContents.capturePage();
  return image.isEmpty() ? null : image.toDataURL();
}

async function snapshotDom(tabId: string): Promise<string | null> {
  const entry = entries.get(tabId);
  if (entry === undefined) return null;
  return (await entry.view.webContents.executeJavaScript(
    'document.documentElement.outerHTML',
  )) as string;
}

function click(tabId: string, x: number, y: number): void {
  const entry = entries.get(tabId);
  if (entry === undefined) return;
  const wc = entry.view.webContents;
  wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
}

/**
 * Internal API the future browser-use tools call to drive a tab
 * programmatically (the seam referenced above). All are no-ops for an
 * unknown/closed tab, so a tool can call them without racing tab lifecycle.
 */
export const browserManager = {
  navigate,
  capture,
  snapshotDom,
  click,
  back: (tabId: string) => entries.get(tabId)?.view.webContents.navigationHistory.goBack(),
  forward: (tabId: string) => entries.get(tabId)?.view.webContents.navigationHistory.goForward(),
  reload: (tabId: string) => entries.get(tabId)?.view.webContents.reload(),
  stop: (tabId: string) => entries.get(tabId)?.view.webContents.stop(),
};

/** Register the trusted-sender-gated `browser:*` channels. */
export function registerBrowserIpc(): void {
  const handle = (
    channel: string,
    handler: (owner: WebContents, req: { tabId: string } & Record<string, unknown>) => unknown,
  ): void => {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, req) => {
      if (!isTrustedIpcEvent(event)) {
        log.warn('rejected invoke from untrusted sender', { channel });
        throw new Error(`[browser] rejected "${channel}": untrusted sender`);
      }
      return handler(event.sender, req as { tabId: string } & Record<string, unknown>);
    });
  };

  handle('browser:create', (owner, req) => ({ ok: ensureView(req.tabId, owner) !== undefined }));
  handle('browser:destroy', (_owner, req) => {
    destroyView(req.tabId);
    return { ok: true };
  });
  handle('browser:set-bounds', (owner, req) => {
    ensureView(req.tabId, owner);
    setBounds(req.tabId, req.bounds as BrowserBounds, req.visible as boolean);
    return { ok: true };
  });
  handle('browser:navigate', (owner, req) => {
    ensureView(req.tabId, owner);
    navigate(req.tabId, req.url as string);
    return { ok: true };
  });
  handle('browser:back', (_owner, req) => {
    browserManager.back(req.tabId);
    return { ok: true };
  });
  handle('browser:forward', (_owner, req) => {
    browserManager.forward(req.tabId);
    return { ok: true };
  });
  handle('browser:reload', (_owner, req) => {
    browserManager.reload(req.tabId);
    return { ok: true };
  });
  handle('browser:stop', (_owner, req) => {
    browserManager.stop(req.tabId);
    return { ok: true };
  });
  handle('browser:capture', async (_owner, req) => ({ dataUrl: await capture(req.tabId) }));
  handle('browser:snapshot-dom', async (_owner, req) => ({ html: await snapshotDom(req.tabId) }));
  handle('browser:click', (_owner, req) => {
    click(req.tabId, req.x as number, req.y as number);
    return { ok: true };
  });
}
