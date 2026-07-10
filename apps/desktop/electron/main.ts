import path from 'node:path';
import { createIpcEventSender, createLogger, registerIpcHandlers } from '@pi-desktop/shared';
import { app, BrowserWindow, ipcMain, type WebPreferences } from 'electron';
import { registerAfmIpc } from './afm/afm-main';
import { resolveBundledPackageAsset } from './app-paths';
import { registerBrowserAgentIpc } from './canvas/browser-agent';
import { registerBrowserIpc } from './canvas/browser-manager';
import {
  harnessAssetsPresent,
  registerCanvasIpc,
  registerCanvasProtocol,
  registerCanvasSchemesAsPrivileged,
} from './canvas/canvas-main';
import { fsHandlers } from './fs-handlers';
import { registerImportIpc } from './import/import-main';
import { registerLlmIpc } from './inference/llm-main';
import type { AppEventMap, CoreInvokeMap, FsInvokeMap } from './ipc-contract';
import { registerPiIpc } from './pi/pi-main';
import { registerProjectIpc } from './project/project-main';
import { applySettingsEnvFromDisk, registerSettingsIpc } from './settings/settings-main';
import { registerPtyIpc } from './terminal/pty-manager';
import {
  isTrustedIpcEvent,
  registerTrustedSender,
  type ValidatableIpcEvent,
} from './trusted-senders';
import { resolveRendererTarget, resolveSecondInstanceWindow } from './window-policy';

// dist-electron is bundled to CJS (sandboxed preloads must be CommonJS), so
// __dirname is available at runtime.
const DIST_ELECTRON = __dirname;
const DIST_RENDERER = path.join(__dirname, '../dist');

const log = createLogger('desktop:main');
const events = createIpcEventSender<AppEventMap>();

// The `pd-preview://` canvas harness scheme must be registered privileged
// BEFORE app 'ready' (Electron requirement); the handler is attached in
// whenReady. The harness dir is resolved repo-relative in dev and
// bundle-relative (inside the asar) when packaged, mirroring pi-main.ts's
// extension resolution (see app-paths.ts). The main process reads these files
// with readFileSync, which the Electron fs shim serves straight from the asar.
const HARNESS_DIR = resolveBundledPackageAsset('canvas', 'harness');
registerCanvasSchemesAsPrivileged();

let mainWindow: BrowserWindow | null = null;
let canvasPopoutWindow: BrowserWindow | null = null;

const SHARED_WEB_PREFERENCES: WebPreferences = {
  preload: path.join(DIST_ELECTRON, 'preload.js'),
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
};

/** Load index.html (packaged) or the dev server, threading the E2E opt-in plus
 * any window-specific query (e.g. the canvas pop-out flag). */
function loadRenderer(win: BrowserWindow, extraQuery?: Record<string, string>): void {
  const target = resolveRendererTarget({
    isPackaged: app.isPackaged,
    devServerUrl: process.env.VITE_DEV_SERVER_URL,
    e2e: process.env.PI_E2E === '1',
  });
  if (target.kind === 'dev-server') {
    const url = new URL(target.url);
    for (const [key, value] of Object.entries(extraQuery ?? {})) url.searchParams.set(key, value);
    void win.loadURL(url.toString());
  } else {
    const query = { ...(target.query ?? {}), ...(extraQuery ?? {}) };
    const options = Object.keys(query).length === 0 ? undefined : { query };
    void win.loadFile(path.join(DIST_RENDERER, 'index.html'), options);
  }
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    title: 'Pi Desktop',
    width: 1080,
    height: 720,
    minWidth: 640,
    minHeight: 480,
    titleBarStyle: 'hiddenInset',
    // Round-7 (img56): pin the traffic lights to a deterministic spot so they
    // sit comfortably INSIDE the floating sidebar card (top edge ~y=8) with clear
    // inset, and their vertical centre (~y=33) lines up with the sidebar's
    // collapse toggle (centred in the top-bar-height header strip + its 4px top
    // pad — see .pd-sidebar-tl). Without this, the default hiddenInset y left them
    // hugging the card's top edge + misaligned.
    trafficLightPosition: { x: 19, y: 26 },
    // Claude-dark bg-base; avoids a white flash before the renderer paints.
    backgroundColor: '#262624',
    webPreferences: SHARED_WEB_PREFERENCES,
  });

  // Only IPC events from this window's main frame pass the invoke gates
  // (trusted-senders.ts); anything else that ever gets webContents is out.
  registerTrustedSender(win.webContents);

  // The renderer never opens windows or navigates; deny both outright.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());

  win.webContents.on('did-finish-load', () => {
    // Sent before React mounts; delivery relies on the preload pre-mount buffer.
    events.send(win.webContents, 'app:boot', { sentAt: Date.now() });
  });

  loadRenderer(win);

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  return win;
}

/**
 * The standalone canvas pop-out window: the SAME trusted app renderer, loaded
 * with `?canvasPopout=1` so it mounts only the canvas (no pi session). It
 * legitimately carries the app preload (it is app content, not the sandboxed
 * canvas iframe); the artifact iframe inside it stays isolated as always.
 * Returns whether a fresh window was created so the caller knows to push vs.
 * let the new window fetch the artifact itself.
 */
function openCanvasPopoutWindow(): { webContents: BrowserWindow['webContents']; created: boolean } {
  if (canvasPopoutWindow !== null && !canvasPopoutWindow.isDestroyed()) {
    if (canvasPopoutWindow.isMinimized()) canvasPopoutWindow.restore();
    canvasPopoutWindow.focus();
    return { webContents: canvasPopoutWindow.webContents, created: false };
  }
  const win = new BrowserWindow({
    title: 'Canvas',
    width: 720,
    height: 680,
    minWidth: 360,
    minHeight: 320,
    backgroundColor: '#262624',
    webPreferences: SHARED_WEB_PREFERENCES,
  });
  registerTrustedSender(win.webContents);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  loadRenderer(win, { canvasPopout: '1' });
  canvasPopoutWindow = win;
  win.on('closed', () => {
    if (canvasPopoutWindow === win) canvasPopoutWindow = null;
  });
  return { webContents: win.webContents, created: true };
}

function registerAppIpc(): void {
  // ipcMain.handle always passes an IpcMainInvokeEvent (registration-side
  // guarantee), which satisfies the structural ValidatableIpcEvent slice.
  const allowSender = (event: unknown): boolean => isTrustedIpcEvent(event as ValidatableIpcEvent);

  registerIpcHandlers<CoreInvokeMap>(
    ipcMain,
    {
      'app:get-info': () => ({
        appVersion: app.getVersion(),
        electronVersion: process.versions.electron ?? 'unknown',
        chromeVersion: process.versions.chrome ?? 'unknown',
        nodeVersion: process.versions.node ?? 'unknown',
        platform: process.platform,
      }),
    },
    { allowSender },
  );

  // Read-only fs channels (composer @-mention picker + session sidebar).
  registerIpcHandlers<FsInvokeMap>(ipcMain, fsHandlers, { allowSender });

  // Importer + onboarding channels (Claude/Codex config → pi; first-run gate).
  registerImportIpc(ipcMain, allowSender);

  // Inference supervisor (utilityProcess) proxy channels.
  registerLlmIpc(ipcMain, allowSender);

  // Apple Foundation Models (on-device) capability gate + set-active. Also
  // publishes PI_AFM_HELPER_PATH so the pi child's provider-afm finds the helper.
  registerAfmIpc(ipcMain, allowSender);

  // Browser-agent bridge: stands up the local socket the browser-use extension
  // drives the canvas browser through, publishing PI_BROWSER_AGENT_SOCK/_TOKEN
  // for the pi child BEFORE its first spawn. Targets the main window for the
  // agent's browser tab.
  registerBrowserAgentIpc(() => (mainWindow !== null ? mainWindow.webContents : null));

  // Desktop settings (theme/permissions/effort/search keys/mcp mode/capabilities).
  registerSettingsIpc(ipcMain, allowSender);

  // Projects (working folders): list/set/new/clear, persisted to projects.json.
  registerProjectIpc(ipcMain, allowSender);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    mainWindow = resolveSecondInstanceWindow({
      isReady: app.isReady(),
      window: mainWindow,
      createWindow: createMainWindow,
    });
    // window.focus() alone does not reliably foreground across app
    // activations on macOS.
    if (mainWindow !== null) app.focus({ steal: true });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
    }
  });

  // Mirror any persisted web-search keys onto the env BEFORE the first pi spawn
  // so the initial session's web-tools extension sees them (it reads env once).
  applySettingsEnvFromDisk();

  void app.whenReady().then(() => {
    registerAppIpc();
    registerPiIpc();
    // Native canvas surfaces (Phase 2b): per-tab WebContentsView + PTY managers.
    registerBrowserIpc();
    registerPtyIpc();
    // Canvas: serve the pd-preview harness + wire the artifact pop-out window.
    if (!harnessAssetsPresent(HARNESS_DIR)) {
      log.warn('canvas harness assets missing; HTML artifacts will not render', {
        dir: HARNESS_DIR,
      });
    }
    registerCanvasProtocol(HARNESS_DIR);
    registerCanvasIpc(openCanvasPopoutWindow);
    mainWindow = createMainWindow();
    log.info('main window created', {
      dev: !app.isPackaged && Boolean(process.env.VITE_DEV_SERVER_URL),
    });
  });
}
