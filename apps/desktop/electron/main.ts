import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { claudePaths, parseClaudeWindowState } from '@pi-desktop/importers';
import { createIpcEventSender, createLogger, registerIpcHandlers } from '@pi-desktop/shared';
import {
  app,
  BrowserWindow,
  type BrowserWindowConstructorOptions,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  type NativeImage,
  nativeImage,
  type WebPreferences,
} from 'electron';
import { registerAfmIpc } from './afm/afm-main';
import { resolveBundledPackageAsset } from './app-paths';
import { registerBrowserAgentIpc } from './canvas/browser-agent';
import { registerBrowserIpc } from './canvas/browser-manager';
import {
  harnessAssetsPresent,
  registerCanvasIpc,
  registerCanvasProtocol,
  registerCanvasSchemesAsPrivileged,
  registerFileProtocol,
} from './canvas/canvas-main';
import { registerConnectorsIpc } from './connectors/connectors-main';
import { registerCorpIpc } from './corp/corp-main';
import { fsHandlers } from './fs-handlers';
import { disposeGen, registerGenCatalogIpc, registerGenIpc } from './gen/gen-manager';
import { registerImportIpc } from './import/import-main';
import { registerLlmIpc, shutdownInference } from './inference/llm-main';
import type { AppEventMap, CoreInvokeMap, FsInvokeMap } from './ipc-contract';
import { disposeMacAgent, registerMacAgentIpc } from './mac/mac-agent';
import { registerPiIpc } from './pi/pi-main';
import { registerProjectIpc } from './project/project-main';
import {
  applySettingsEnvFromDisk,
  generationExperimentEnabled,
  registerSettingsIpc,
} from './settings/settings-main';
import { registerSkillsIpc } from './skills/skills-main';
import { disposeAllPtys, registerPtyIpc } from './terminal/pty-manager';
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

// The "Pi caret" app mark (build/icon.png). Packaged builds get their bundle
// icon from build/icon.icns (electron-builder mac.icon), but that does not set
// the RUNTIME dock/window image in dev, so load the PNG here for the dev window
// + dock. build/ is a sibling of dist-electron (apps/desktop/build) in dev; it
// is not shipped inside the asar, so the packaged path simply resolves empty
// and the .icns bundle icon stands.
const ICON_PATH = path.join(DIST_ELECTRON, '../build/icon.png');

function appIconImage(): NativeImage | null {
  try {
    const img = nativeImage.createFromPath(ICON_PATH);
    return img.isEmpty() ? null : img;
  } catch {
    return null;
  }
}

/**
 * On first run only (no onboarding.json yet), size the initial window from the
 * user's Claude Desktop window bounds so it "opens where they left Claude". Pure
 * read of window-state.json via the importers parser (never touches auth). E2E
 * is skipped so probe window geometry stays deterministic.
 */
function firstRunClaudeBounds(): Pick<
  BrowserWindowConstructorOptions,
  'width' | 'height' | 'x' | 'y'
> | null {
  if (process.env.PI_E2E === '1') return null;
  const home = os.homedir();
  try {
    if (fs.existsSync(path.join(home, '.pi', 'desktop', 'onboarding.json'))) return null;
  } catch {
    return null;
  }
  let text: string | null = null;
  try {
    text = fs.readFileSync(claudePaths(home).windowState, 'utf8');
  } catch {
    return null;
  }
  const { bounds } = parseClaudeWindowState(text);
  if (bounds === null || bounds.isMaximized || bounds.isFullScreen) return null;
  // Clamp to the window's own minimums; only carry x/y when both are present.
  const out: Pick<BrowserWindowConstructorOptions, 'width' | 'height' | 'x' | 'y'> = {
    width: Math.max(640, Math.round(bounds.width)),
    height: Math.max(480, Math.round(bounds.height)),
  };
  if (bounds.x !== undefined && bounds.y !== undefined) {
    out.x = Math.round(bounds.x);
    out.y = Math.round(bounds.y);
  }
  return out;
}

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
  const icon = appIconImage();
  const win = new BrowserWindow({
    title: 'Bobble',
    // Roomier default so the chat + canvas (situation room, live files/terminal)
    // aren't squished side-by-side on first launch.
    width: 1440,
    height: 940,
    minWidth: 640,
    minHeight: 480,
    // First run: adopt the user's Claude Desktop window size/position if present.
    ...firstRunClaudeBounds(),
    // macOS shows the dock image (set in whenReady); icon is used on win/linux.
    ...(icon !== null ? { icon } : {}),
    titleBarStyle: 'hiddenInset',
    // Round-10 (#1): VERTICALLY CENTRE the macOS traffic lights inside the 46px
    // top bar (--pd-height-topbar). ROOT CAUSE of the recurring misalignment:
    // earlier rounds kept pushing `y` DOWN (…→26) chasing a "sit lower" target,
    // which parked the ~14px-tall light cluster's centre near y=33 — a full ~10px
    // BELOW the bar's true vertical centre (46 / 2 = 23). Centring the cluster is
    // `y = (topbarHeight - clusterHeight) / 2 = (46 - 14) / 2 = 16`, putting the
    // circles' centre at y≈23 — dead-centre of the bar and the sidebar's matching
    // 46px top strip. `x` keeps the left inset that clears into the sidebar gutter.
    trafficLightPosition: { x: 19, y: Math.round((46 - 14) / 2) },
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

  // DEV diagnostic: mirror renderer `[pi-diag]` console lines into the terminal so
  // the server-start / model-load DECISIONS (which live in the renderer, not the
  // main process) are visible next to the main logs — otherwise a "no server
  // started, no log" failure is invisible. Handles both Electron console-message
  // signatures. Dev only; gated on the prefix so it never mirrors general noise.
  if (!app.isPackaged) {
    win.webContents.on('console-message', (...args: unknown[]) => {
      const msg =
        typeof args[2] === 'string'
          ? (args[2] as string)
          : ((args[0] as { message?: string })?.message ?? '');
      if (msg.includes('[pi-diag]')) log.info(`renderer ${msg}`);
    });
  }

  // Dev overrides for the experimental features: `PI_DESKTOP_CORP=1` surfaces a
  // `?corp=1` param (settings-store `productionHarnessEnabled`) so a dev launch
  // drives the corp flow, and `PI_DESKTOP_GEN=1` surfaces `?gen=1`
  // (`generationEnabled`) so a dev launch mounts the live gen surface + hook —
  // both without toggling the persisted settings. No env ⇒ no param ⇒ default app.
  const devQuery: Record<string, string> = {};
  if (process.env.PI_DESKTOP_CORP === '1') devQuery.corp = '1';
  if (process.env.PI_DESKTOP_GEN === '1') devQuery.gen = '1';
  // Separate opt-in for the live activity HUD (CorpDebugHud) — decoupled from the
  // corp feature flag so a normal `PI_DESKTOP_CORP=1` run shows no debug overlay.
  if (process.env.PI_DESKTOP_CORP_HUD === '1') devQuery.corphud = '1';
  loadRenderer(win, Object.keys(devQuery).length > 0 ? devQuery : undefined);

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

/**
 * Application menu. The ONE customization over the platform defaults is the Close
 * accelerator (blind-test round-2 #5): ⌘W is remapped to a renderer "close the
 * active canvas tab / current chat" action instead of closing the WINDOW, and
 * ⌘⇧W (plus the red traffic-light) closes the window. Standard role-based
 * submenus (edit/view/window) are kept so copy/paste/select-all/minimize/zoom
 * keep their usual shortcuts.
 *
 * ROOT CAUSE of the reported "⌘W quits the app": with NO application menu set,
 * Electron installs its default menu whose Window → Close item carries ⌘W and
 * closes the focused window; on the single-window app that reads as quitting.
 */
function installAppMenu(): void {
  const isMac = process.platform === 'darwin';
  const sendCloseTab = (win: BrowserWindow | undefined): void => {
    const target = win ?? mainWindow ?? undefined;
    if (target !== undefined && target !== null && !target.isDestroyed()) {
      events.send(target.webContents, 'app:accelerator', { action: 'close-tab' });
    }
  };
  const closeWindowItem: MenuItemConstructorOptions = {
    label: 'Close Window',
    accelerator: 'CmdOrCtrl+Shift+W',
    role: 'close',
  };
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' } as MenuItemConstructorOptions] : []),
    ...(isMac
      ? []
      : [
          {
            label: 'File',
            submenu: [closeWindowItem, { type: 'separator' }, { role: 'quit' }],
          } as MenuItemConstructorOptions,
        ]),
    { role: 'editMenu' },
    { role: 'viewMenu' },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        {
          // ⌘W → close the active canvas tab / current chat in the renderer,
          // never the window (see AppEventMap 'app:accelerator').
          label: 'Close Tab',
          accelerator: 'CmdOrCtrl+W',
          click: (_item, win) => sendCloseTab(win instanceof BrowserWindow ? win : undefined),
        },
        closeWindowItem,
        ...(isMac
          ? [
              { type: 'separator' } as MenuItemConstructorOptions,
              { role: 'front' } as MenuItemConstructorOptions,
            ]
          : []),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * Reap every NON-pi child process on app quit, in the pi quit-hold's held
 * window (so it completes before `app.exit()`):
 *   - the inference utilityProcess + its llama-server grandchild (shutdownInference),
 *   - the long-lived pi-mac computer-use helper (disposeMacAgent), and
 *   - any terminal PTY/shell sessions (disposeAllPtys).
 * The pi children (and, via their process group, their subagent grandchildren)
 * are reaped by the quit-hold's own `disposeAll`. `allSettled` so one slow/failed
 * teardown never blocks the others; the quit-hold's grace cap bounds the whole
 * wait. Guaranteed: no llama-server, pi, subagent-pi, or helper survives quit.
 */
async function reapChildProcesses(): Promise<void> {
  await Promise.allSettled([
    shutdownInference(),
    (async () => disposeMacAgent())(),
    (async () => disposeAllPtys())(),
    // Close the gen bridge socket server if the experimental stack stood it up.
    (async () => disposeGen())(),
  ]);
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

  // Generation modality catalog → renderer DTOs (gen:modality-catalog). Read-only
  // surfacing of the vetted image/audio/video/3d models the model browser lists;
  // always registered (harmless read-only enumeration).
  registerGenCatalogIpc(ipcMain, allowSender);

  // EXPERIMENTAL generation stack (default OFF). The full generation socket
  // bridge (`generate_image` / `generate_video` → JobQueue → mflux/MLX/ComfyUI,
  // progress streamed to the gen-image canvas surface) stands up ONLY when the
  // `experimentalGeneration` flag / `PI_DESKTOP_GEN=1` gate is on — so a signed
  // /Applications build with the flag off is byte-for-byte its current self (no
  // gen socket, no gen env published, and pi-main omits the `gen-tools`
  // extension too). Sibling to the corp gate. Standing this up BEFORE the first
  // pi spawn publishes PI_GEN_SOCK/PI_GEN_TOKEN for the gen-tools extension.
  // NEXT (video pillar): pass `comfyInstall` (a real ComfyInstallManager whose
  // `emit` → `events.send('gen:comfy-install')`) to answer the modular-download
  // UI + drive the download-then-continue gate end-to-end.
  if (generationExperimentEnabled()) {
    registerGenIpc({
      getWindow: () => (mainWindow !== null ? mainWindow.webContents : null),
      // gen event channels are a subset of AppEventMap; forward through the
      // app-wide sender (the cast only bridges the two generic key domains).
      sendEvent: (wc, channel, payload) =>
        events.send(wc, channel as keyof AppEventMap & string, payload as never),
      isTrusted: (event) => isTrustedIpcEvent(event),
    });
    log.info('experimental generation stack wired (gen bridge live)');
  }

  // Apple Foundation Models (on-device) capability gate + set-active. Also
  // publishes PI_AFM_HELPER_PATH so the pi child's provider-afm finds the helper.
  registerAfmIpc(ipcMain, allowSender);

  // Browser-agent bridge: stands up the local socket the browser-use extension
  // drives the canvas browser through, publishing PI_BROWSER_AGENT_SOCK/_TOKEN
  // for the pi child BEFORE its first spawn. Targets the main window for the
  // agent's browser tab.
  registerBrowserAgentIpc(() => (mainWindow !== null ? mainWindow.webContents : null));

  // Mac computer-use bridge: stands up the local socket the mac-computer-use
  // extension drives ANY Mac app through, publishing PI_MAC_SOCK/_TOKEN for the
  // pi child BEFORE its first spawn. The pi-mac Accessibility/CGEvent helper is
  // spawned from MAIN so the Accessibility + Screen-Recording TCC grants bind to
  // the signed Bobble.app bundle (never the pi child's exec path).
  registerMacAgentIpc();

  // Desktop settings (theme/permissions/effort/search keys/mcp mode/capabilities).
  registerSettingsIpc(ipcMain, allowSender);

  // Projects (working folders): list/set/new/clear, persisted to projects.json.
  registerProjectIpc(ipcMain, allowSender);

  // Connectors gallery: catalog + registry read/mutate + /Applications scan.
  // Owns ~/.pi/desktop/mcp-connectors.json (the file the mcp-lite pi extension
  // reads); the model sees changes on the next pi session/spawn.
  registerConnectorsIpc(ipcMain, allowSender);

  // Skills: bundled catalog + install/remove into ~/.pi/agent/skills (the dir
  // the pi engine auto-discovers skills from); copies from app resources.
  registerSkillsIpc(ipcMain, allowSender);

  // EXPERIMENTAL coordination harness (CorpEngine): runs the harness `runCorp`
  // behind the local model server and streams situation-room events to the
  // window. Channels are always registered but only reached when the
  // experimental flag / `PI_DESKTOP_CORP=1` gate is on (sender-gated internally).
  registerCorpIpc();
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
    // Dev dock icon: show the Pi caret mark on macOS (packaged uses the .icns
    // bundle icon; this covers the unsigned dev/electron-run window).
    if (process.platform === 'darwin' && app.dock !== undefined) {
      const icon = appIconImage();
      if (icon !== null) app.dock.setIcon(icon);
    }
    registerAppIpc();
    registerPiIpc({
      extraTeardown: reapChildProcesses,
      // The window subagents run under: spawn_subagent routes to the app bridge,
      // which spawns each subagent as its own pi + streams it to the dropdown.
      getWindow: () => (mainWindow !== null ? mainWindow.webContents : null),
    });
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
    // Media scheme: stream project-file bytes (images/video/audio/pdf/3D/docs) to
    // the canvas surfaces, fenced to the app's working roots (see canvas-main.ts).
    registerFileProtocol();
    registerCanvasIpc(openCanvasPopoutWindow);
    // ⌘W closes the active tab, not the window (blind-test round-2 #5).
    installAppMenu();
    mainWindow = createMainWindow();
    log.info('main window created', {
      dev: !app.isPackaged && Boolean(process.env.VITE_DEV_SERVER_URL),
    });
  });
}
