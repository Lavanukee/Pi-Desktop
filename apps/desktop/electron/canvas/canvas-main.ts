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
import {
  createReadStream,
  existsSync,
  readFileSync,
  realpathSync,
  type Stats,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { createIpcEventSender, createLogger } from '@pi-desktop/shared';
import { type IpcMainInvokeEvent, ipcMain, protocol, shell, type WebContents } from 'electron';
import { allowedWriteRoots } from '../fs-handlers';
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

/**
 * The `pd-file://` media scheme: serves raw project-file BYTES to the renderer so
 * the canvas can preview binary modalities — images, video, audio, PDFs, 3D
 * models (glb/obj/stl/ply) and Office docs (docx/pptx). It exists because the
 * main window runs with `webSecurity` on and a non-`file://` origin in dev, where
 * `<img src=file://…>` happens to load but `fetch('file://…')` (needed to hand a
 * model/doc's ArrayBuffer to three.js / mammoth) is blocked cross-origin. A
 * privileged `supportFetchAPI` + `corsEnabled` scheme fixes BOTH the element
 * `src` case and the `fetch()` case uniformly, and — being ours — lets us fence
 * to the app's working roots and honour HTTP Range so `<video>` can seek.
 * URL shape: `pd-file://f` + the URL-encoded absolute path (its own pathname).
 */
const PD_FILE_SCHEME = 'pd-file';
const PD_FILE_HOST = 'f';

/** Extension → Content-Type for the media scheme. Elements (img/video/audio/pdf
 * iframe) rely on this; the fetch()-based surfaces (3D/doc) read the bytes
 * directly and ignore it. Unknowns fall back to octet-stream. */
const FILE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  apng: 'image/apng',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  ogv: 'video/ogg',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  pdf: 'application/pdf',
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  obj: 'text/plain',
  stl: 'application/sla',
  ply: 'application/octet-stream',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

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
    {
      // `stream` lets the handler return a streamed body (large video/models);
      // `corsEnabled` + our ACAO header make cross-origin fetch() readable so the
      // 3D/doc surfaces can pull an ArrayBuffer from a `http://localhost` / `file://`
      // renderer origin.
      scheme: PD_FILE_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

/** Parse a `Range: bytes=start-end` header against a known total size. Returns
 * null for no/negative/unsatisfiable ranges (caller then serves the whole file
 * or a 416). Only the first range of a (rare) multi-range request is honoured. */
function parseRange(header: string | null, total: number): { start: number; end: number } | null {
  if (header === null) return null;
  const m = /bytes=(\d*)-(\d*)/.exec(header.trim());
  if (m === null) return null;
  const hasStart = m[1] !== '';
  const hasEnd = m[2] !== '';
  if (!hasStart && !hasEnd) return null;
  let start: number;
  let end: number;
  if (!hasStart) {
    // suffix range: last N bytes
    const suffix = Number(m[2]);
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(m[1]);
    end = hasEnd ? Math.min(Number(m[2]), total - 1) : total - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
    return null;
  }
  return { start, end };
}

/** True when `target` sits inside one of the app's working roots (registered
 * projects, pi session cwds, the sandbox base, pi's agent dir). Both the target
 * and each root are compared BOTH lexically and via realpath, so a symlinked path
 * on either side matches (e.g. macOS `/var` → `/private/var`: a project stored as
 * `/var/folders/…` still contains a file that realpaths to `/private/var/…`). */
function isUnderAllowedRoot(target: string, real: string): boolean {
  const contained = (root: string): boolean =>
    target === root ||
    target.startsWith(root + path.sep) ||
    real === root ||
    real.startsWith(root + path.sep);
  for (const root of allowedWriteRoots()) {
    if (contained(root)) return true;
    let rootReal: string;
    try {
      rootReal = realpathSync(root);
    } catch {
      continue; // root doesn't exist yet — its lexical form was already checked
    }
    if (rootReal !== root && contained(rootReal)) return true;
  }
  return false;
}

/**
 * Serve `pd-file://f/<abs-path>` from disk with a correct content-type, HTTP
 * Range support (so `<video>` can seek), and CORS. The path is realpath'd and
 * fenced to the app's working roots — a page (even the sandboxed canvas iframe)
 * can never stream a file outside the folders the app already operates in.
 * Registered after `app.whenReady()` (protocol.handle requirement).
 */
export function registerFileProtocol(): void {
  protocol.handle(PD_FILE_SCHEME, async (request) => {
    const cors = { 'access-control-allow-origin': '*' } as const;
    let target: string;
    try {
      const { host, pathname } = new URL(request.url);
      if (host !== PD_FILE_HOST) return new Response('not found', { status: 404, headers: cors });
      target = path.resolve(decodeURIComponent(pathname));
    } catch {
      return new Response('bad request', { status: 400, headers: cors });
    }

    // realpath (collapse symlinks) then fence — never serve outside the roots.
    let real: string;
    try {
      real = realpathSync(target);
    } catch {
      return new Response('not found', { status: 404, headers: cors });
    }
    if (!isUnderAllowedRoot(target, real)) {
      log.warn('pd-file rejected: outside allowed roots', { target });
      return new Response('forbidden', { status: 403, headers: cors });
    }
    const st = statSafe(real);
    if (st === null || !st.isFile()) {
      return new Response('not found', { status: 404, headers: cors });
    }

    const ext = extOf(real);

    // Chromium's <img> can't decode HEIC/HEIF (iPhone's default), so transcode to
    // PNG with macOS `sips` (offline; the OS's own codec — nativeImage's decoder
    // returns empty for real camera HEICs) and stream THAT instead.
    let serveFile = real;
    let contentType = FILE_MIME[ext] ?? 'application/octet-stream';
    if (ext === 'heic' || ext === 'heif') {
      const png = await heicToPng(real, st.mtimeMs);
      if (png === null) return new Response('unsupported image', { status: 415, headers: cors });
      serveFile = png;
      contentType = 'image/png';
    }
    const serveStat = serveFile === real ? st : statSafe(serveFile);
    if (serveStat === null) return new Response('not found', { status: 404, headers: cors });
    const total = serveStat.size;
    const base: Record<string, string> = {
      ...cors,
      'content-type': contentType,
      'accept-ranges': 'bytes',
      'cache-control': 'no-cache',
    };

    const range = parseRange(request.headers.get('range'), total);
    if (request.headers.get('range') !== null && range === null && total > 0) {
      // A Range header we couldn't satisfy → 416 with the current size.
      return new Response(null, {
        status: 416,
        headers: { ...base, 'content-range': `bytes */${total}` },
      });
    }
    try {
      if (range !== null) {
        const stream = createReadStream(serveFile, { start: range.start, end: range.end });
        return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
          status: 206,
          headers: {
            ...base,
            'content-range': `bytes ${range.start}-${range.end}/${total}`,
            'content-length': String(range.end - range.start + 1),
          },
        });
      }
      const stream = createReadStream(serveFile);
      return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
        status: 200,
        headers: { ...base, 'content-length': String(total) },
      });
    } catch (error) {
      log.warn('pd-file read failed', { target: real, error: String(error) });
      return new Response('read error', { status: 500, headers: cors });
    }
  });
}

// HEIC/HEIF → temp-PNG cache, keyed by source path + mtime so a file that changes
// on disk re-transcodes. macOS only (sips); elsewhere → null → 415.
const heicPngCache = new Map<string, string>();

/** Transcode a HEIC/HEIF file to a temp PNG via macOS `sips` (offline, the OS's
 * own HEIF codec — reliable on real camera HEICs where nativeImage returns an
 * empty image), cached by path+mtime. Returns the PNG path, or null on failure. */
async function heicToPng(real: string, mtimeMs: number): Promise<string | null> {
  if (process.platform !== 'darwin') return null;
  const key = `${real}:${mtimeMs}`;
  const cached = heicPngCache.get(key);
  if (cached !== undefined && existsSync(cached)) return cached;
  const out = path.join(tmpdir(), `pi-heic-${Buffer.from(key).toString('hex').slice(0, 32)}.png`);
  try {
    await execFileAsync('sips', ['-s', 'format', 'png', real, '--out', out]);
    if (!existsSync(out)) return null;
    heicPngCache.set(key, out);
    return out;
  } catch (error) {
    log.warn('heic transcode failed', { real, error: String(error) });
    return null;
  }
}

/** Guarded statSync → null on any error (missing / permission). */
function statSafe(p: string): Stats | null {
  try {
    return statSync(p);
  } catch {
    return null;
  }
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

// Candidate apps by FILE CATEGORY, probed at their standard install locations —
// only the ones present on THIS machine are offered (existsSync filter in
// listOpenApps), and the LaunchServices default (duti) is prepended as primary.
// So an image offers Preview/Photos, a pptx offers Keynote/PowerPoint, a video
// offers IINA/VLC/QuickTime, etc. — never Xcode-for-everything.
type AppCategory =
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'document'
  | 'presentation'
  | 'spreadsheet'
  | 'model'
  | 'code';

const TEXT_EDITORS = [
  '/Applications/Visual Studio Code.app',
  '/Applications/Visual Studio Code - Insiders.app',
  '/Applications/Cursor.app',
  '/Applications/Zed.app',
  '/Applications/Sublime Text.app',
  '/Applications/Xcode.app',
  '/System/Applications/TextEdit.app',
];

const CATEGORY_APPS: Record<AppCategory, string[]> = {
  image: [
    '/System/Applications/Preview.app',
    '/System/Applications/Photos.app',
    '/Applications/Pixelmator Pro.app',
    '/Applications/Affinity Photo 2.app',
    '/Applications/GIMP.app',
  ],
  video: [
    '/Applications/IINA.app',
    '/Applications/VLC.app',
    '/System/Applications/QuickTime Player.app',
  ],
  audio: [
    '/System/Applications/Music.app',
    '/Applications/VLC.app',
    '/System/Applications/QuickTime Player.app',
  ],
  pdf: [
    '/System/Applications/Preview.app',
    '/Applications/Adobe Acrobat Reader.app',
    '/Applications/Adobe Acrobat.app',
  ],
  document: [
    '/Applications/Microsoft Word.app',
    '/Applications/Pages.app',
    '/System/Applications/Pages.app',
    '/System/Applications/TextEdit.app',
  ],
  presentation: [
    '/Applications/Keynote.app',
    '/System/Applications/Keynote.app',
    '/Applications/Microsoft PowerPoint.app',
  ],
  spreadsheet: [
    '/Applications/Numbers.app',
    '/System/Applications/Numbers.app',
    '/Applications/Microsoft Excel.app',
  ],
  // Preview opens usdz; Blender/Xcode handle the rest. Kept short on purpose.
  model: [
    '/Applications/Blender.app',
    '/Applications/Xcode.app',
    '/System/Applications/Preview.app',
  ],
  code: [...TEXT_EDITORS, '/System/Applications/Utilities/Terminal.app'],
};

const IMAGE_EXTS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'ico',
  'avif',
  'apng',
  'heic',
  'heif',
  'tiff',
  'tif',
  'svg',
]);
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'm4v', 'ogv', 'mkv', 'avi']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'opus', 'aiff']);
const MODEL_EXTS = new Set(['glb', 'gltf', 'obj', 'stl', 'ply', 'usdz', 'fbx', '3mf', 'dae']);

/** Map a file extension to the app category whose candidate list we offer. */
function categoryForExt(ext: string): AppCategory {
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (ext === 'pdf') return 'pdf';
  if (['docx', 'doc', 'rtf', 'odt'].includes(ext)) return 'document';
  if (['pptx', 'ppt', 'key', 'odp'].includes(ext)) return 'presentation';
  if (['xlsx', 'xls', 'csv', 'tsv', 'numbers', 'ods'].includes(ext)) return 'spreadsheet';
  if (MODEL_EXTS.has(ext)) return 'model';
  return 'code';
}

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

  // LaunchServices default first (primary "Open"), then the category's installed
  // candidates. existsSync keeps it to apps actually on this machine.
  const defPath = await defaultAppPath(ext);
  const paths: string[] = [];
  if (defPath !== null && existsSync(defPath)) paths.push(defPath);
  for (const p of CATEGORY_APPS[categoryForExt(ext)]) {
    if (existsSync(p) && !paths.includes(p)) paths.push(p);
  }

  const apps: CanvasOpenApp[] = [];
  let defaultAppId: string | null = null;
  for (const p of paths) {
    const meta = await appMeta(p);
    // Some apps ship at two paths (/Applications + /System/Applications) — dedupe
    // by bundle id so the same app isn't listed twice.
    if (apps.some((a) => a.id === meta.id)) continue;
    apps.push(meta);
    if (p === defPath) defaultAppId = meta.id;
  }
  const result = { apps, defaultAppId };
  openAppsByExt.set(ext, result);
  return result;
}
