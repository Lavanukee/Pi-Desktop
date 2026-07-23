/**
 * Mac-agent bridge — the trusted seam that lets the @pi-desktop/mac-computer-use
 * extension (running inside the spawned pi child, a separate process) DRIVE any
 * Mac app through the `pi-mac` Accessibility + CGEvent helper.
 *
 * Transport: a local line-delimited JSON-RPC server on a Unix-domain socket
 * (@pi-desktop/mac-computer-use/protocol). The socket path + a random token are
 * published onto the env BEFORE the first pi spawn (like browser-agent.ts /
 * afm-main.ts), so the child's `MacAgentClient.fromEnv()` connects and every
 * request echoes the token. Requests run against a long-lived `pi-mac --serve`
 * helper.
 *
 * The load-bearing reason this lives in MAIN (not the pi child): posting
 * synthetic CGEvents + reading other apps' AX trees requires the Accessibility
 * (and Screen Recording) TCC grants, and those attribute to the SIGNED bundle
 * that spawns the helper. The pi child runs as ELECTRON_RUN_AS_NODE (an
 * effectively-unsigned exec path) whose grant would never stick; main is Pi
 * Desktop.app itself. So main owns the helper spawn — mirroring how
 * browser-agent.ts owns the WebContentsView.
 *
 * Nothing thrown here escapes to the child: request handlers translate failures
 * into `{ ok: false, error }` responses.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  MAC_AGENT_SOCK_ENV,
  MAC_AGENT_TOKEN_ENV,
  type MacActAck,
  type MacAgentMethod,
  type MacAgentRequest,
  type MacAgentResponse,
  type MacLaunchAck,
  type MacSnapshot,
  type MacTccStatus,
  type MacWindowBounds,
} from '@pi-desktop/mac-computer-use/protocol';
import { MacHelperClient } from '@pi-desktop/pi-mac';
import { createLogger } from '@pi-desktop/shared';
import { app, ipcMain } from 'electron';
import { resolveBundledPackageAsset } from '../app-paths';
import { isTrustedIpcEvent } from '../trusted-senders';
import type { OverlayRect } from './overlay-geometry';
import { macOverlay } from './overlay-window';

const log = createLogger('desktop:mac-agent');
const execFileAsync = promisify(execFile);

/** How long to let a freshly launched app settle before the model snapshots. */
const LAUNCH_SETTLE_MS = 600;
/** Launch waits for the opened app to HAVE A WINDOW (so the immediate
 * snapshot-after-open sees content, not a launch animation). */
const LAUNCH_WINDOW_TIMEOUT_MS = 8_000;
const LAUNCH_POLL_MS = 250;
/** TCC probe cache: the grant status can't change under us mid-session often
 * enough to justify a helper round-trip per launch. */
const TCC_CACHE_MS = 30_000;

let token = '';
let server: net.Server | null = null;
let helper: MacHelperClient | null = null;

/** index → element-centre cache per pid, refreshed on every snapshot response.
 * Lets the overlay GLIDE the phantom cursor to an element BEFORE the actual
 * click/type fires (browser-agent's moveCursor-then-act pattern); the ack's
 * echoed x,y covers stale/unknown indices afterwards. Snapshot bbox x,y are
 * element CENTRES (screen points) by the pi-mac wire contract. */
const elementCenters = new Map<number, Map<number, { x: number; y: number }>>();

let tccCache: { at: number; status: MacTccStatus } | null = null;

/**
 * Resolve the packaged `pi-mac` binary to a REAL on-disk path. Like pi-afm it is
 * a mach-o that must be spawned, so it is asarUnpack'd (electron-builder.yml);
 * the resolver points inside app.asar, which we rewrite to app.asar.unpacked so
 * the path exists for `spawn`/`execve`. In dev the resolver already yields the
 * SwiftPM build output.
 */
function resolveMacHelperPath(): string {
  const resolved = resolveBundledPackageAsset('pi-mac', 'swift/.build/release/pi-mac');
  if (!app.isPackaged) return resolved;
  return resolved.replace(
    `${path.sep}app.asar${path.sep}`,
    `${path.sep}app.asar.unpacked${path.sep}`,
  );
}

const HELPER_PATH = resolveMacHelperPath();

/** The on-device helper is Apple-silicon macOS only. */
function isSupportedPlatform(): boolean {
  return process.platform === 'darwin';
}

/** Lazily spawn the long-lived `pi-mac --serve` helper (kept alive so a
 * snapshot's index→element map survives into the acts that follow). */
function getHelper(): MacHelperClient {
  if (helper === null) helper = new MacHelperClient({ helperPath: HELPER_PATH });
  return helper;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });
}

async function tccStatus(): Promise<MacTccStatus> {
  if (tccCache !== null && Date.now() - tccCache.at < TCC_CACHE_MS) return tccCache.status;
  const status = await getHelper().request<MacTccStatus>('check');
  tccCache = { at: Date.now(), status };
  return status;
}

/** Read the target window's live frame via the helper (null = no window). */
async function readBounds(params: Record<string, unknown>): Promise<MacWindowBounds | null> {
  try {
    const b = await getHelper().request<MacWindowBounds>('bounds', params);
    return b.ok ? b : null;
  } catch {
    return null;
  }
}

function rectOf(b: MacWindowBounds): OverlayRect | null {
  if (
    typeof b.x !== 'number' ||
    typeof b.y !== 'number' ||
    typeof b.w !== 'number' ||
    typeof b.h !== 'number'
  ) {
    return null;
  }
  return { x: b.x, y: b.y, w: b.w, h: b.h };
}

/**
 * Launch an app in the BACKGROUND (`open -g -a NAME` — injection-safe, no
 * shell; the app opens without stealing focus) and WAIT until it has a real
 * window, so the tool's immediate snapshot-after-open sees content and the
 * resolved pid makes the app the session's controlled target. With the
 * Accessibility grant missing the window poll can never succeed, so it is
 * skipped (the launch still happens; perception degrades with a clear story).
 */
async function launchApp(name: string, background = true): Promise<MacLaunchAck> {
  const appName = name.trim();
  if (appName === '') return { ok: false, app: name, error: 'launch needs an app name' };
  try {
    await execFileAsync('open', background ? ['-g', '-a', appName] : ['-a', appName]);
  } catch (err) {
    if (!background) {
      // Foreground ask for an already-running app `open` couldn't match: a
      // plain activate. (Never used on the background path — no focus steal.)
      try {
        await getHelper().request('focus', { app: appName });
        return { ok: true, app: appName };
      } catch {
        /* fall through to the launch error */
      }
    }
    return { ok: false, app: appName, error: err instanceof Error ? err.message : String(err) };
  }

  let ax = false;
  try {
    ax = (await tccStatus()).accessibility;
  } catch {
    /* helper unavailable → skip the window poll */
  }
  if (!ax) {
    await sleep(LAUNCH_SETTLE_MS);
    return { ok: true, app: appName };
  }

  const deadline = Date.now() + LAUNCH_WINDOW_TIMEOUT_MS;
  let bounds: MacWindowBounds | null = null;
  for (;;) {
    bounds = await readBounds({ app: appName });
    if (bounds !== null || Date.now() >= deadline) break;
    await sleep(LAUNCH_POLL_MS);
  }
  if (bounds === null) {
    // Opened but no window materialized (agent-style app / very slow launch).
    // Still a successful open; the tool degrades to a by-name snapshot.
    return { ok: true, app: appName };
  }
  // Let first-paint settle so the snapshot-after-open screenshot shows content.
  await sleep(LAUNCH_SETTLE_MS);
  return { ok: true, app: bounds.app ?? appName, pid: bounds.pid, bounds };
}

// ── overlay choreography around helper acts ─────────────────────────────────

function centerOf(params: Record<string, unknown>): { x: number; y: number } | null {
  const pid = typeof params.pid === 'number' ? params.pid : null;
  const index = typeof params.index === 'number' ? params.index : null;
  if (pid === null || index === null) return null;
  return elementCenters.get(pid)?.get(index) ?? null;
}

function cacheSnapshot(snap: MacSnapshot): void {
  if (typeof snap.pid !== 'number') return;
  const map = new Map<number, { x: number; y: number }>();
  for (const el of snap.elements ?? []) {
    if (el?.bbox !== undefined) map.set(el.index, { x: el.bbox.x, y: el.bbox.y });
  }
  elementCenters.set(snap.pid, map);
}

async function snapshotWithOverlay(params: Record<string, unknown>): Promise<MacSnapshot> {
  const snap = await getHelper().request<MacSnapshot>('snapshot', params);
  cacheSnapshot(snap);
  if (typeof snap.pid === 'number') {
    const wb = snap.windowBounds;
    await macOverlay.control(snap.pid, wb ? { x: wb.x, y: wb.y, w: wb.w, h: wb.h } : null);
    await macOverlay.thinking();
  }
  return snap;
}

/** Click: glide the phantom cursor to the target BEFORE the act (element
 * centre from the last snapshot, or the explicit x,y), fire, then ripple at
 * the point the helper actually acted on. */
async function clickWithOverlay(params: Record<string, unknown>): Promise<MacActAck> {
  const known =
    typeof params.x === 'number' && typeof params.y === 'number'
      ? { x: params.x, y: params.y }
      : centerOf(params);
  if (known !== null) await macOverlay.moveCursor(known.x, known.y);
  const ack = await getHelper().request<MacActAck>('click', params);
  if (ack.found) {
    const at = typeof ack.x === 'number' && typeof ack.y === 'number' ? ack : known;
    if (at !== null && typeof at.x === 'number' && typeof at.y === 'number') {
      await macOverlay.clickAt(at.x, at.y);
    }
  }
  return ack;
}

async function typeWithOverlay(params: Record<string, unknown>): Promise<MacActAck> {
  const known = centerOf(params);
  if (known !== null) await macOverlay.moveCursor(known.x, known.y);
  await macOverlay.typing(String(params.text ?? ''));
  const ack = await getHelper().request<MacActAck>('type', params);
  if (ack.found && typeof ack.x === 'number' && typeof ack.y === 'number' && known === null) {
    await macOverlay.moveCursor(ack.x, ack.y);
  }
  await macOverlay.thinking();
  return ack;
}

async function dispatch(method: MacAgentMethod, params: Record<string, unknown>): Promise<unknown> {
  if (!isSupportedPlatform()) throw new Error('mac computer-use is macOS-only');
  switch (method) {
    case 'check':
      return getHelper().request('check');
    case 'snapshot':
      return snapshotWithOverlay(params);
    case 'click':
      return clickWithOverlay(params);
    case 'type':
      return typeWithOverlay(params);
    case 'key': {
      await macOverlay.keyPress(String(params.combo ?? params.key ?? ''));
      return getHelper().request('key', params);
    }
    case 'scroll': {
      await macOverlay.scrolling();
      return getHelper().request('scroll', params);
    }
    case 'screenshot':
      return getHelper().request('screenshot', params);
    case 'bounds':
      return getHelper().request('bounds', params);
    case 'frontmost':
      return getHelper().request('frontmost', params);
    case 'launch': {
      const ack = await launchApp(String(params.app ?? ''), params.background !== false);
      if (ack.ok && typeof ack.pid === 'number' && ack.bounds !== undefined) {
        await macOverlay.control(ack.pid, rectOf(ack.bounds));
        await macOverlay.opening(ack.app);
      }
      return ack;
    }
    // The overlay follows the controlled app; an explicit driving=false from
    // the extension (session end/reset) puts it away.
    case 'setDriving': {
      if (params.driving === false) macOverlay.hide();
      return { ok: true };
    }
    default:
      throw new Error(`unknown method: ${String(method)}`);
  }
}

// ── socket server (mirror browser-agent.ts) ──────────────────────────────────

function defaultSocketPath(): string {
  return path.join(tmpdir(), `pi-mac-${process.pid}-${randomBytes(4).toString('hex')}.sock`);
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
  let req: MacAgentRequest;
  try {
    req = JSON.parse(line) as MacAgentRequest;
  } catch {
    return;
  }
  if (typeof req.id !== 'number') return;
  const respond = (patch: Partial<MacAgentResponse>): void => {
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
  const socketPath = process.env[MAC_AGENT_SOCK_ENV] ?? defaultSocketPath();
  token = process.env[MAC_AGENT_TOKEN_ENV] ?? randomBytes(24).toString('hex');
  try {
    if (existsSync(socketPath)) unlinkSync(socketPath);
  } catch {
    /* stale socket; listen() will surface a real problem */
  }
  server = net.createServer((socket) => handleConnection(socket));
  server.on('error', (e) => log.error('mac-agent bridge server error', { error: String(e) }));
  server.listen(socketPath, () => log.info('mac-agent bridge listening', { socketPath }));
  // Publish for the pi child spawned later (env is read at spawn time).
  process.env[MAC_AGENT_SOCK_ENV] = socketPath;
  process.env[MAC_AGENT_TOKEN_ENV] = token;
}

/**
 * Stand up the mac-agent bridge socket (publishing its env for the pi child) and
 * point the helper at the resolved `pi-mac` binary. Called from main.ts's
 * registerAppIpc on app-ready, BEFORE the first pi spawn, so PI_MAC_SOCK/_TOKEN
 * are present when the child's MacAgentClient.fromEnv() runs. No-op off macOS
 * (the tools still register but the bridge just reports "macOS-only").
 *
 * Also arms the cursor overlay (its window tracker reads bounds through the
 * helper) and, under PI_E2E=1 only, a renderer-reachable debug channel the
 * probes use (tests/e2e/mac-overlay-probe.mjs / mac-computeruse-probe.mjs).
 */
export function registerMacAgentIpc(): void {
  startServer();
  macOverlay.setBoundsReader(async (pid) => {
    const b = await readBounds({ pid });
    return b === null ? null : rectOf(b);
  });
  if (process.env.PI_E2E === '1') registerE2eDebugChannel();
  log.info('mac-agent helper path', { helperPath: HELPER_PATH, packaged: app.isPackaged });
}

/**
 * PI_E2E-only introspection/driving channel. Two op families:
 *   - helper passthrough (check/frontmost/bounds/snapshot/screenshot): the
 *     probes' TCC reality-check + no-focus-steal assertions;
 *   - overlay-* ops: deterministic overlay driving with NO real app involved,
 *     so the overlay probe can screenshot every cursor/bubble state.
 * Trusted-sender-gated like every other channel; never registered outside E2E.
 */
function registerE2eDebugChannel(): void {
  ipcMain.handle(
    'mac:debug',
    async (event, req: { op: string; params?: Record<string, unknown> }) => {
      if (!isTrustedIpcEvent(event)) throw new Error('[mac-agent] rejected mac:debug');
      const params = req.params ?? {};
      try {
        switch (req.op) {
          case 'check':
          case 'frontmost':
          case 'bounds':
          case 'snapshot':
          case 'screenshot':
            return { ok: true, result: await getHelper().request(req.op, params) };
          case 'overlay-show': {
            await macOverlay.debugShow({
              x: Number(params.x ?? 0),
              y: Number(params.y ?? 0),
              w: Number(params.w ?? 600),
              h: Number(params.h ?? 400),
            });
            return { ok: true };
          }
          case 'overlay-cursor': {
            await macOverlay.moveCursor(Number(params.x ?? 0), Number(params.y ?? 0));
            return { ok: true };
          }
          case 'overlay-click': {
            await macOverlay.moveCursor(Number(params.x ?? 0), Number(params.y ?? 0));
            await macOverlay.clickAt(Number(params.x ?? 0), Number(params.y ?? 0));
            return { ok: true };
          }
          case 'overlay-typing': {
            await macOverlay.typing(String(params.text ?? ''));
            return { ok: true };
          }
          case 'overlay-key': {
            await macOverlay.keyPress(String(params.combo ?? 'cmd+s'));
            return { ok: true };
          }
          case 'overlay-status': {
            if (params.status === 'opening') await macOverlay.opening(String(params.text ?? ''));
            else if (params.status === 'scrolling') await macOverlay.scrolling();
            else await macOverlay.thinking();
            return { ok: true };
          }
          case 'overlay-info':
            return { ok: true, result: macOverlay.info() };
          case 'overlay-hide': {
            macOverlay.hide();
            return { ok: true };
          }
          default:
            return { ok: false, error: `unknown op: ${req.op}` };
        }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
}

/** Test/lifecycle hook: close the socket server + kill the helper. */
export function disposeMacAgent(): void {
  server?.close();
  server = null;
  helper?.dispose();
  helper = null;
  macOverlay.dispose();
  elementCenters.clear();
  tccCache = null;
}
