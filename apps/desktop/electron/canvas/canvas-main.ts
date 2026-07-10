/**
 * Canvas main-process wiring:
 *   1. the `pd-preview://` sandboxed-harness protocol (privileged / standard /
 *      secure) that serves @pi-desktop/canvas's static harness files, and
 *   2. the artifact pop-out channel that hands the current artifact to a
 *      standalone canvas window.
 *
 * The canvas iframe is isolated by the frame sandbox (allow-scripts, NO
 * allow-same-origin) plus this distinct scheme origin — the app preload is
 * NEVER attached to it (see trusted-senders.ts). This module deliberately does
 * NOT import @pi-desktop/canvas: that barrel re-exports the React/CodeMirror
 * surfaces, which must not enter the Node main bundle. The two wire constants
 * below mirror the frozen source of truth in
 * packages/canvas/src/harness/protocol.ts (PD_PREVIEW_SCHEME /
 * PD_PREVIEW_HARNESS_HOST).
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createIpcEventSender, createLogger } from '@pi-desktop/shared';
import { type IpcMainInvokeEvent, ipcMain, protocol, shell, type WebContents } from 'electron';
import type {
  AppEventMap,
  CanvasArtifactPayload,
  CanvasOpenApp,
  CanvasOpenWithAppId,
} from '../ipc-contract';
import { isTrustedIpcEvent } from '../trusted-senders';

const execFileAsync = promisify(execFile);

const log = createLogger('desktop:canvas');

/** Mirrors packages/canvas/src/harness/protocol.ts (frozen). */
const PD_PREVIEW_SCHEME = 'pd-preview';
const PD_PREVIEW_HARNESS_HOST = 'canvas';

const events = createIpcEventSender<AppEventMap>();

/** Latest artifact handed off for the pop-out window to fetch/render. */
let popoutArtifact: CanvasArtifactPayload | null = null;

/**
 * Register the harness scheme as privileged+standard+secure. MUST run before
 * `app.whenReady()` (Electron requirement). `standard: true` gives the harness
 * page a stable opaque origin (`pd-preview://canvas`) distinct from the app,
 * which — with the frame's allow-scripts / no-allow-same-origin sandbox — is
 * the containment boundary.
 */
export function registerCanvasSchemesAsPrivileged(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PD_PREVIEW_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true },
    },
  ]);
}

/**
 * Serve the canvas harness `{index.html,harness.js}` over `pd-preview://`.
 * `harnessDir` is resolved by the caller (main.ts, via app-paths.ts):
 * repo-relative `packages/canvas/harness` in dev, and bundle-relative inside
 * the asar when packaged. readFileSync here goes through the Electron fs shim,
 * so an asar-internal harnessDir is served transparently. Anything other than
 * the two known files 404s.
 */
export function registerCanvasProtocol(harnessDir: string): void {
  protocol.handle(PD_PREVIEW_SCHEME, (request) => {
    const { host, pathname } = new URL(request.url);
    if (host !== PD_PREVIEW_HARNESS_HOST) {
      return new Response('not found', { status: 404 });
    }
    const file = pathname === '/harness.js' ? 'harness.js' : 'index.html';
    const abs = path.join(harnessDir, file);
    // Fence to the harness dir: never serve outside it even if the URL is odd.
    if (!path.resolve(abs).startsWith(path.resolve(harnessDir))) {
      return new Response('forbidden', { status: 403 });
    }
    try {
      // Read + return the bytes with an explicit content-type (don't rely on
      // net.fetch file: inference) so harness.js is served as executable JS.
      const body = readFileSync(abs);
      const contentType =
        file === 'harness.js' ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8';
      return new Response(body, { headers: { 'content-type': contentType } });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
}

/** Fail fast at startup if the harness assets aren't where we expect. */
export function harnessAssetsPresent(harnessDir: string): boolean {
  try {
    readFileSync(path.join(harnessDir, 'index.html'));
    readFileSync(path.join(harnessDir, 'harness.js'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Wire the pop-out channels. `openPopoutWindow` (injected by main.ts, which
 * owns the window scaffolding) creates-or-focuses the standalone canvas window
 * and reports whether it created a fresh one — a fresh window fetches the
 * artifact itself on mount via `canvas:get-popout`; an already-open one is
 * pushed the new artifact over the event wire.
 */
export function registerCanvasIpc(
  openPopoutWindow: () => { webContents: WebContents; created: boolean },
): void {
  const guard = (event: IpcMainInvokeEvent, channel: string): void => {
    if (!isTrustedIpcEvent(event)) {
      throw new Error(`[canvas] rejected "${channel}": untrusted sender`);
    }
  };

  ipcMain.handle('canvas:popout', (event, req: { artifact: CanvasArtifactPayload }) => {
    guard(event, 'canvas:popout');
    popoutArtifact = req.artifact;
    const { webContents, created } = openPopoutWindow();
    if (!created && !webContents.isDestroyed()) {
      events.send(webContents, 'canvas:popout-artifact', popoutArtifact);
    }
    return { ok: true };
  });

  ipcMain.handle('canvas:get-popout', (event) => {
    guard(event, 'canvas:get-popout');
    return { artifact: popoutArtifact };
  });

  // Browser operation bar → open the current URL in the user's real browser.
  ipcMain.handle('canvas:open-external', async (event, req: { url: string }) => {
    guard(event, 'canvas:open-external');
    // Only ever hand http(s) URLs to the OS (never file:/custom schemes).
    if (!/^https?:\/\//i.test(req.url.trim())) return { ok: false };
    try {
      await shell.openExternal(req.url.trim());
      return { ok: true };
    } catch (error) {
      log.warn('open-external failed', { error: String(error) });
      return { ok: false };
    }
  });

  // File operation bar "Open with" split button → the apps that can open this
  // file (LaunchServices default + a pragmatic set), each with a system icon.
  ipcMain.handle('canvas:list-open-apps', async (event, req: { path: string }) => {
    guard(event, 'canvas:list-open-apps');
    return listOpenApps(req.path);
  });

  // File operation bar "Open ▾" → shell out to the chosen app.
  ipcMain.handle(
    'canvas:open-with',
    async (event, req: { path: string; appId: CanvasOpenWithAppId }) => {
      guard(event, 'canvas:open-with');
      return openWithApp(req.path, req.appId);
    },
  );

  // File operation bar "Open in folder" → reveal the file in Finder.
  ipcMain.handle('canvas:reveal', (event, req: { path: string }) => {
    guard(event, 'canvas:reveal');
    shell.showItemInFolder(path.resolve(req.path));
    return { ok: true };
  });
}

/** `open -a <app> <target>` as a promise (macOS). Rejects on a non-zero exit
 * (e.g. the app isn't installed), which drives the vscode-insiders → stable
 * fallback below. */
function openApp(appName: string, target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('open', ['-a', appName, target], (error) => (error ? reject(error) : resolve()));
  });
}

/**
 * Shell out to open a file in the requested app. `vscode-insiders` falls back to
 * stable VS Code when Insiders isn't installed; `terminal` opens the file's
 * directory; `default` uses the OS default handler via shell.openPath.
 * macOS-only shell-outs (`open -a`); other platforms use the default handler.
 */
async function openWithApp(
  filePath: string,
  appId: CanvasOpenWithAppId,
): Promise<{ ok: boolean; error?: string }> {
  const target = path.resolve(filePath);
  try {
    if (appId === 'default' || process.platform !== 'darwin') {
      const error = await shell.openPath(target);
      return error ? { ok: false, error } : { ok: true };
    }
    // Round-8 #14: real system apps arrive as a `.app` path (`open -a`) or a
    // bundle id (`open -b`). The legacy named ids below stay as fallbacks.
    if (appId.endsWith('.app')) {
      await openApp(appId, target);
      return { ok: true };
    }
    if (isBundleId(appId)) {
      await execFileAsync('open', ['-b', appId, target]);
      return { ok: true };
    }
    if (appId === 'terminal') {
      const dir = isDirectory(target) ? target : path.dirname(target);
      await openApp('Terminal', dir);
      return { ok: true };
    }
    if (appId === 'xcode') {
      await openApp('Xcode', target);
      return { ok: true };
    }
    // vscode-insiders → Insiders, else stable VS Code.
    try {
      await openApp('Visual Studio Code - Insiders', target);
    } catch {
      await openApp('Visual Studio Code', target);
    }
    return { ok: true };
  } catch (error) {
    log.warn('open-with failed', { appId, error: String(error) });
    // Last resort: hand it to the OS default handler.
    const fallback = await shell.openPath(target).catch(() => 'open failed');
    return fallback ? { ok: false, error: String(error) } : { ok: true };
  }
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ── "Open with" app list + system icons (round-8 #14) ──────────────────────
//
// macOS only. The default handler is detected via `duti -x <ext>` when
// available (else omitted — the "Open" button still opens the OS default via
// shell.openPath). The candidate list is the default app plus a pragmatic set
// of installed editors/terminals; each app's icon is extracted from its bundle
// (Info.plist → .icns → PNG via `sips`) and returned as a data URL. Results are
// cached by extension; icons are cached by app path — the extraction shells out.

/** Reverse-DNS bundle id (has a dot, no slash, not a `.app` path). */
function isBundleId(value: string): boolean {
  return value.includes('.') && !value.includes('/') && !value.endsWith('.app');
}

/** Pragmatic candidate apps probed by their standard install locations. */
const KNOWN_APP_PATHS = [
  '/Applications/Visual Studio Code - Insiders.app',
  '/Applications/Visual Studio Code.app',
  '/Applications/Xcode.app',
  '/System/Applications/Utilities/Terminal.app',
  '/Applications/Utilities/Terminal.app',
];

const appMetaCache = new Map<string, CanvasOpenApp>();
const openAppsByExt = new Map<string, { apps: CanvasOpenApp[]; defaultAppId: string | null }>();

function extOf(filePath: string): string {
  const base = path.basename(filePath);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** Parse a small set of Info.plist keys via `plutil -convert json`. */
async function readBundleInfo(
  appPath: string,
): Promise<{ id: string; name: string; iconFile?: string }> {
  const plist = path.join(appPath, 'Contents', 'Info.plist');
  const fallbackName = path.basename(appPath).replace(/\.app$/i, '');
  try {
    const { stdout } = await execFileAsync('plutil', ['-convert', 'json', '-o', '-', plist]);
    const info = JSON.parse(stdout) as Record<string, unknown>;
    const id = typeof info.CFBundleIdentifier === 'string' ? info.CFBundleIdentifier : appPath;
    const name =
      (typeof info.CFBundleDisplayName === 'string' && info.CFBundleDisplayName) ||
      (typeof info.CFBundleName === 'string' && info.CFBundleName) ||
      fallbackName;
    const iconFile = typeof info.CFBundleIconFile === 'string' ? info.CFBundleIconFile : undefined;
    return { id, name, iconFile };
  } catch {
    return { id: appPath, name: fallbackName };
  }
}

/** Extract an app's icon to a small PNG data URL (`sips`), or undefined. */
async function extractIconDataUrl(appPath: string, iconFile: string): Promise<string | undefined> {
  const name = /\.icns$/i.test(iconFile) ? iconFile : `${iconFile}.icns`;
  const icns = path.join(appPath, 'Contents', 'Resources', name);
  if (!existsSync(icns)) return undefined;
  const out = path.join(
    tmpdir(),
    `pi-appicon-${Buffer.from(appPath).toString('hex').slice(0, 24)}.png`,
  );
  try {
    // -Z 32: cap the longest side at 32px so the data URL stays tiny.
    await execFileAsync('sips', ['-s', 'format', 'png', '-Z', '32', icns, '--out', out]);
    return `data:image/png;base64,${readFileSync(out).toString('base64')}`;
  } catch {
    return undefined;
  }
}

/** Bundle id + display name + icon data URL for an app, cached by path. */
async function appMeta(appPath: string): Promise<CanvasOpenApp> {
  const cached = appMetaCache.get(appPath);
  if (cached !== undefined) return cached;
  const info = await readBundleInfo(appPath);
  const iconDataUrl =
    info.iconFile !== undefined ? await extractIconDataUrl(appPath, info.iconFile) : undefined;
  // Prefer the bundle id (stable, `open -b`) as the app id; fall back to path.
  const meta: CanvasOpenApp = { id: info.id || appPath, name: info.name, iconDataUrl };
  appMetaCache.set(appPath, meta);
  return meta;
}

/** LaunchServices default app for an extension via `duti -x` (optional tool). */
async function defaultAppPath(ext: string): Promise<string | null> {
  if (ext === '') return null;
  try {
    const { stdout } = await execFileAsync('duti', ['-x', ext]);
    const line = stdout
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.endsWith('.app'));
    return line ?? null;
  } catch {
    return null; // duti not installed / no association — default stays undetected.
  }
}

async function listOpenApps(
  filePath: string,
): Promise<{ apps: CanvasOpenApp[]; defaultAppId: string | null }> {
  if (process.platform !== 'darwin') return { apps: [], defaultAppId: null };
  const ext = extOf(filePath);
  const cached = openAppsByExt.get(ext);
  if (cached !== undefined) return cached;

  const defPath = await defaultAppPath(ext);
  const paths: string[] = [];
  if (defPath !== null && existsSync(defPath)) paths.push(defPath);
  for (const p of KNOWN_APP_PATHS) if (existsSync(p) && !paths.includes(p)) paths.push(p);

  const apps: CanvasOpenApp[] = [];
  let defaultAppId: string | null = null;
  for (const p of paths) {
    const meta = await appMeta(p);
    apps.push(meta);
    if (p === defPath) defaultAppId = meta.id;
  }
  const result = { apps, defaultAppId };
  openAppsByExt.set(ext, result);
  return result;
}
