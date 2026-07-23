/**
 * Browser-agent bridge — the trusted seam that lets the @pi-desktop/browser-use
 * extension (running inside the spawned pi child, a separate process) DRIVE the
 * canvas browser WebContentsView.
 *
 * Transport: a local line-delimited JSON-RPC server on a Unix-domain socket
 * (@pi-desktop/browser-use/protocol). The socket path + a random token are
 * published onto the env BEFORE the first pi spawn (like afm-main.ts's
 * PI_AFM_HELPER_PATH), so the child's `BrowserAgentClient.fromEnv()` connects
 * and every request echoes the token. Requests run against `browserManager`.
 *
 * Tab ownership: only the renderer can create/focus a canvas browser tab, so
 * the bridge asks it to open a dedicated agent tab (`browser:agent-open-tab`)
 * and drives whichever tab id it registers back. Every action animates the
 * virtual cursor + live-typing indicator (browser-scripts.ts) so the model's
 * browsing is VISIBLE.
 *
 * Nothing thrown here escapes to the child: request handlers translate failures
 * into `{ ok: false, error }` responses.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  BROWSER_AGENT_SOCK_ENV,
  BROWSER_AGENT_TOKEN_ENV,
  type BrowserAgentMethod,
  type BrowserAgentRequest,
  type BrowserAgentResponse,
  type CanvasState,
  type CanvasSurfaceState,
} from '@pi-desktop/browser-use/protocol';
import { createIpcEventSender, createLogger } from '@pi-desktop/shared';
import { type IpcMainInvokeEvent, ipcMain, type WebContents } from 'electron';
import type { AppEventMap } from '../ipc-contract';
import { isTrustedIpcEvent } from '../trusted-senders';
import { browserManager } from './browser-manager';
import {
  cursorCommand,
  domClickByIndex,
  focusByIndex,
  REDUCED_MOTION_SCRIPT,
  resolveByIndex,
  setValueByIndex,
} from './browser-scripts';

const log = createLogger('desktop:browser-agent');
const events = createIpcEventSender<AppEventMap>();

/** Wait budget for a navigation / history / load to settle. */
const NAV_TIMEOUT_MS = 20_000;
/** Wait budget for the renderer to open + mount the agent browser tab. */
const OPEN_TIMEOUT_MS = 8_000;
/** Cursor travel time before a click registers (matches the CSS transition). */
const CURSOR_TRAVEL_MS = 300;
/** Per progressive-typing chunk delay. */
const TYPE_STEP_MS = 45;
const TYPE_MAX_STEPS = 6;

let token = '';
let server: net.Server | null = null;
let getAgentWindow: () => WebContents | null = () => null;

/** Fixed id for the main-owned HEADLESS agent view (a chat browsing in the
 * background — no visible canvas tab). */
const HEADLESS_AGENT_TAB_ID = 'pi:agent-headless';

/** The browser tab the model currently drives (renderer-owned id). */
let agentTabId: string | null = null;
/**
 * The latest compact canvas snapshot the renderer reported (canvas:report-state).
 * Served to the pi child via `getCanvasState` (browser url/title re-enriched from
 * the live view at read time, so it reflects the model's own navigation). Reset
 * on dispose; a fresh window re-reports.
 */
let cachedCanvasState: CanvasState | null = null;
/** Resolver for an in-flight ensureAgentTab awaiting the renderer's register. */
let pendingOpen: { resolve: (id: string) => void; reject: (e: Error) => void } | null = null;
/** Cached page reduced-motion preference (refreshed on navigate). */
let reducedMotion = false;
/** Last virtual-cursor position, so the overlay can be re-injected at the same
 * spot after a page navigation wipes it (persistent cursor). Seeded to a visible
 * resting spot near the top-left so the pointer is on-screen before the first
 * move rather than parked off-canvas. */
let lastCursorX = 48;
let lastCursorY = 48;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });
}

interface Resolved {
  found: boolean;
  x?: number;
  y?: number;
}

// ── renderer coordination ───────────────────────────────────────────────────

/** Renderer reports (or re-reports) the agent browser tab id. */
function onRegister(tabId: string): void {
  agentTabId = tabId;
  if (pendingOpen !== null) {
    const p = pendingOpen;
    pendingOpen = null;
    p.resolve(tabId);
  }
}

async function waitForView(tabId: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!browserManager.has(tabId)) {
    if (Date.now() - start > timeoutMs) throw new Error('browser view did not mount in time');
    await sleep(50);
  }
}

/** Ensure a live agent browser tab exists; open one via the renderer if not. */
async function ensureAgentTab(): Promise<string> {
  if (agentTabId !== null && browserManager.has(agentTabId)) return agentTabId;
  const wc = getAgentWindow();
  if (wc === null || wc.isDestroyed()) {
    throw new Error('no Bobble window is available to host the browser');
  }
  const opened = new Promise<string>((resolve, reject) => {
    pendingOpen = { resolve, reject };
    const t = setTimeout(() => {
      if (pendingOpen !== null) {
        pendingOpen = null;
        reject(new Error('timed out opening the browser tab'));
      }
    }, OPEN_TIMEOUT_MS);
    t.unref?.();
  });
  events.send(wc, 'browser:agent-open-tab', {});
  const tabId = await opened;
  await waitForView(tabId, OPEN_TIMEOUT_MS);
  agentTabId = tabId;
  // A freshly-created WebContentsView has no committed document yet, so an
  // executeJavaScript (a snapshot/evaluate before the model navigates) would
  // hang. Commit about:blank so the page is always scriptable.
  const state = browserManager.stateOf(tabId);
  if (state !== null && state.url === '') {
    await browserManager.navigateAndWait(tabId, 'about:blank', OPEN_TIMEOUT_MS);
  }
  // Show the pointer at rest immediately, so it's on-screen the moment the
  // browser tab appears rather than only after the first move.
  await reassertCursor();
  return tabId;
}

function setDriving(driving: boolean): void {
  const wc = getAgentWindow();
  if (wc !== null && !wc.isDestroyed()) events.send(wc, 'browser:agent-driving', { driving });
  // The cursor no longer hides when a driving batch ends — it stays put at its
  // last position (a resting pointer). Only the transient typing pill is cleared.
  if (!driving && agentTabId !== null && browserManager.has(agentTabId)) {
    void browserManager
      .evaluate(agentTabId, cursorCommand({ kind: 'typing', active: false }))
      .catch(() => undefined);
  }
}

// ── cursor helpers ───────────────────────────────────────────────────────────

async function cursor(op: Parameters<typeof cursorCommand>[0]): Promise<void> {
  if (agentTabId === null) return;
  await browserManager.evaluate(agentTabId, cursorCommand(op)).catch(() => undefined);
}

/** Animate the pointer to (x, y) and let it visibly travel before acting. */
async function moveCursor(x: number, y: number): Promise<void> {
  lastCursorX = x;
  lastCursorY = y;
  await cursor({ kind: 'move', x, y });
  await sleep(reducedMotion ? 0 : CURSOR_TRAVEL_MS);
}

/**
 * Persist the virtual cursor across a navigation. A page load wipes the injected
 * overlay, so once the new document has settled we re-inject it at its last
 * position. This is NO LONGER gated on driving — the pointer stays visible and
 * resting between action batches and across pages, so it never vanishes while a
 * browsing chat is on screen (jedd: always visible, rests until needed again).
 */
async function reassertCursor(): Promise<void> {
  if (agentTabId === null) return;
  await cursor({ kind: 'move', x: lastCursorX, y: lastCursorY });
}

async function detectReduced(tabId: string): Promise<boolean> {
  try {
    return Boolean(await browserManager.evaluate(tabId, REDUCED_MOTION_SCRIPT));
  } catch {
    return false;
  }
}

// ── method dispatch ──────────────────────────────────────────────────────────

async function clickElement(params: Record<string, unknown>): Promise<Resolved> {
  const id = await ensureAgentTab();
  const index = Number(params.index);
  const mode = params.mode === 'coord' ? 'coord' : 'dom';
  const res = (await browserManager.evaluate(id, resolveByIndex(index))) as Resolved | null;
  if (res === null || !res.found) return { found: false };
  const x = res.x ?? 0;
  const y = res.y ?? 0;
  await moveCursor(x, y);
  await cursor({ kind: 'click', x, y });
  if (mode === 'coord') {
    browserManager.click(id, x, y);
  } else {
    const done = (await browserManager.evaluate(id, domClickByIndex(index))) as Resolved | null;
    if (done === null || !done.found) browserManager.click(id, x, y); // last-resort coord click
  }
  return { found: true };
}

async function typeInto(params: Record<string, unknown>): Promise<Resolved> {
  const id = await ensureAgentTab();
  const index = Number(params.index);
  const text = String(params.text ?? '');
  const submit = params.submit === true;
  const focus = (await browserManager.evaluate(id, focusByIndex(index))) as Resolved | null;
  if (focus === null || !focus.found) return { found: false };
  await moveCursor(focus.x ?? 0, focus.y ?? 0);
  await browserManager
    .evaluate(id, cursorCommand({ kind: 'typing', active: true, text }))
    .catch(() => undefined);
  const steps = reducedMotion ? 1 : Math.min(TYPE_MAX_STEPS, Math.max(1, text.length));
  for (let i = 1; i <= steps; i++) {
    const upto = Math.ceil((text.length * i) / steps);
    await browserManager
      .evaluate(id, setValueByIndex(index, text.slice(0, upto), i === steps))
      .catch(() => undefined);
    if (!reducedMotion && i < steps) await sleep(TYPE_STEP_MS);
  }
  await browserManager
    .evaluate(id, cursorCommand({ kind: 'typing', active: false }))
    .catch(() => undefined);
  if (submit) browserManager.sendKey(id, 'Enter');
  return { found: true };
}

// ── canvas state (canvas-awareness) ──────────────────────────────────────────

/** Enrich a browser surface's url/title from the authoritative live view. The
 * renderer's reported url can lag a model-driven navigation; browserManager is
 * the source of truth for whatever tab id it holds. */
function enrichSurface(s: CanvasSurfaceState): CanvasSurfaceState {
  if (s.kind !== 'browser' || s.tabId === undefined) return s;
  const live = browserManager.stateOf(s.tabId);
  if (live === null) return s;
  return {
    ...s,
    url: live.url !== '' ? live.url : s.url,
    title: live.title !== '' ? live.title : s.title,
  };
}

/** The cached snapshot with every browser surface re-enriched from the live view. */
function enrichedCanvasState(): CanvasState | null {
  if (cachedCanvasState === null) return null;
  return {
    active: cachedCanvasState.active !== null ? enrichSurface(cachedCanvasState.active) : null,
    others: cachedCanvasState.others.map(enrichSurface),
  };
}

async function dispatch(
  method: BrowserAgentMethod,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (method) {
    case 'ensureTab': {
      const id = await ensureAgentTab();
      return browserManager.stateOf(id) ?? { tabId: id, url: '', title: '' };
    }
    case 'navigate': {
      const id = await ensureAgentTab();
      await cursor({ kind: 'hide' });
      const state = await browserManager.navigateAndWait(id, String(params.url), NAV_TIMEOUT_MS);
      reducedMotion = await detectReduced(id);
      await reassertCursor();
      return state;
    }
    case 'evaluate': {
      const id = await ensureAgentTab();
      return browserManager.evaluate(id, String(params.script));
    }
    case 'screenshot': {
      const id = await ensureAgentTab();
      return { dataUrl: await browserManager.capture(id) };
    }
    case 'click': {
      const id = await ensureAgentTab();
      const x = Number(params.x);
      const y = Number(params.y);
      await moveCursor(x, y);
      await cursor({ kind: 'click', x, y });
      browserManager.click(id, x, y);
      return { ok: true };
    }
    case 'clickElement':
      return clickElement(params);
    case 'type':
      return typeInto(params);
    case 'key': {
      const id = await ensureAgentTab();
      browserManager.sendKey(id, String(params.key));
      return { ok: true };
    }
    case 'back':
    case 'forward':
    case 'reload': {
      const id = await ensureAgentTab();
      await cursor({ kind: 'hide' });
      const state = await browserManager.historyAndWait(id, method, NAV_TIMEOUT_MS);
      await reassertCursor();
      return state;
    }
    case 'waitForLoad': {
      const id = await ensureAgentTab();
      return browserManager.waitForLoad(id, NAV_TIMEOUT_MS);
    }
    case 'setDriving': {
      setDriving(params.driving === true);
      return { ok: true };
    }
    case 'getCanvasState':
      return enrichedCanvasState();
    default:
      throw new Error(`unknown method: ${String(method)}`);
  }
}

// ── socket server ────────────────────────────────────────────────────────────

function defaultSocketPath(): string {
  return path.join(tmpdir(), `pi-bua-${process.pid}-${randomBytes(4).toString('hex')}.sock`);
}

function handleConnection(socket: net.Socket): void {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('error', () => {
    /* a peer reset must never crash main */
  });
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.trim() !== '') void handleLine(socket, line);
      nl = buffer.indexOf('\n');
    }
  });
}

async function handleLine(socket: net.Socket, line: string): Promise<void> {
  let req: BrowserAgentRequest;
  try {
    req = JSON.parse(line) as BrowserAgentRequest;
  } catch {
    return;
  }
  if (typeof req.id !== 'number') return;
  const respond = (patch: Partial<BrowserAgentResponse>): void => {
    try {
      socket.write(`${JSON.stringify({ id: req.id, ok: true, ...patch })}\n`);
    } catch {
      /* peer gone */
    }
  };
  if (req.token !== token) {
    respond({ ok: false, error: 'unauthorized' });
    return;
  }
  try {
    const result = await dispatch(req.method, req.params ?? {});
    respond({ ok: true, result });
  } catch (err) {
    respond({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

function startServer(): void {
  const socketPath = process.env[BROWSER_AGENT_SOCK_ENV] ?? defaultSocketPath();
  token = process.env[BROWSER_AGENT_TOKEN_ENV] ?? randomBytes(24).toString('hex');
  try {
    if (existsSync(socketPath)) unlinkSync(socketPath);
  } catch {
    /* stale socket; listen() will surface a real problem */
  }
  server = net.createServer((socket) => handleConnection(socket));
  server.on('error', (e) => log.error('bridge server error', { error: String(e) }));
  server.listen(socketPath, () => log.info('browser-agent bridge listening', { socketPath }));
  // Publish for the pi child spawned later (env is read at spawn time).
  process.env[BROWSER_AGENT_SOCK_ENV] = socketPath;
  process.env[BROWSER_AGENT_TOKEN_ENV] = token;
}

/**
 * Stand up the bridge socket (publishing its env for the pi child) and register
 * the renderer-coordination channels. Called from main.ts's registerAppIpc on
 * app-ready, before the first pi spawn. `getWindow` yields the app window the
 * agent asks to host the browser tab.
 */
export function registerBrowserAgentIpc(getWindow: () => WebContents | null): void {
  getAgentWindow = getWindow;
  startServer();

  const guard = (event: IpcMainInvokeEvent, channel: string): void => {
    if (!isTrustedIpcEvent(event))
      throw new Error(`[browser-agent] rejected "${channel}": untrusted`);
  };
  ipcMain.handle('browser:agent-register', (event, req: { tabId: string }) => {
    guard(event, 'browser:agent-register');
    onRegister(req.tabId);
    return { ok: true };
  });
  ipcMain.handle('browser:agent-release', (event, req: { tabId: string }) => {
    guard(event, 'browser:agent-release');
    if (agentTabId === req.tabId) agentTabId = null;
    return { ok: true };
  });
  // The browsing chat is in the BACKGROUND: create a hidden main-owned view (no
  // canvas tab) and resolve the in-flight ensureAgentTab with it, so the model can
  // still browse headlessly. See src/chat/canvas/browser-agent.ts (renderer gate).
  ipcMain.handle('browser:agent-headless', (event) => {
    guard(event, 'browser:agent-headless');
    const wc = getAgentWindow();
    if (wc === null || wc.isDestroyed()) return { ok: false };
    const ok = browserManager.ensureAgentView(HEADLESS_AGENT_TAB_ID, wc);
    if (ok) onRegister(HEADLESS_AGENT_TAB_ID);
    return { ok };
  });
  // Canvas-awareness: the renderer pushes a compact snapshot of what's on the
  // canvas whenever surfaces / the active tab change (debounced). We just cache
  // it; getCanvasState re-enriches the browser url/title from the live view.
  ipcMain.handle('canvas:report-state', (event, req: { state: CanvasState }) => {
    guard(event, 'canvas:report-state');
    cachedCanvasState = req.state ?? null;
    return { ok: true };
  });
}

/** Test/lifecycle hook: close the socket server. */
export function disposeBrowserAgent(): void {
  server?.close();
  server = null;
  agentTabId = null;
  cachedCanvasState = null;
}
