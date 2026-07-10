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
  type MacAgentMethod,
  type MacAgentRequest,
  type MacAgentResponse,
} from '@pi-desktop/mac-computer-use/protocol';
import { MacHelperClient } from '@pi-desktop/pi-mac';
import { createLogger } from '@pi-desktop/shared';
import { app } from 'electron';
import { resolveBundledPackageAsset } from '../app-paths';

const log = createLogger('desktop:mac-agent');
const execFileAsync = promisify(execFile);

/** How long to let a freshly launched app settle before the model snapshots. */
const LAUNCH_SETTLE_MS = 600;

let token = '';
let server: net.Server | null = null;
let helper: MacHelperClient | null = null;

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

/** Launch or focus an app by name — injection-safe (`open -a NAME`, no shell).
 * `background` adds `-g` so the app opens WITHOUT stealing focus (the user keeps
 * their current app; AX perception works on a non-frontmost window). */
async function launchApp(
  name: string,
  background = true,
): Promise<{ ok: boolean; app: string; error?: string }> {
  const appName = name.trim();
  if (appName === '') return { ok: false, app: name, error: 'launch needs an app name' };
  try {
    await execFileAsync('open', background ? ['-g', '-a', appName] : ['-a', appName]);
    await new Promise((r) => setTimeout(r, LAUNCH_SETTLE_MS));
    return { ok: true, app: appName };
  } catch (err) {
    // Not installed / not found → try focusing an already-running instance.
    try {
      await getHelper().request('focus', { app: appName });
      return { ok: true, app: appName };
    } catch {
      return { ok: false, app: appName, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

async function dispatch(method: MacAgentMethod, params: Record<string, unknown>): Promise<unknown> {
  if (!isSupportedPlatform()) throw new Error('mac computer-use is macOS-only');
  switch (method) {
    case 'check':
      return getHelper().request('check');
    case 'snapshot':
      return getHelper().request('snapshot', params);
    case 'click':
      return getHelper().request('click', params);
    case 'type':
      return getHelper().request('type', params);
    case 'key':
      return getHelper().request('key', params);
    case 'scroll':
      return getHelper().request('scroll', params);
    case 'screenshot':
      return getHelper().request('screenshot', params);
    case 'launch':
      return launchApp(String(params.app ?? ''), params.background !== false);
    // Live canvas surface (a virtual cursor + streamed screenshots) is deferred
    // to a follow-up after Wave A; the driving-state toggle is a no-op for now.
    case 'setDriving':
      return { ok: true };
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
 */
export function registerMacAgentIpc(): void {
  startServer();
  log.info('mac-agent helper path', { helperPath: HELPER_PATH, packaged: app.isPackaged });
}

/** Test/lifecycle hook: close the socket server + kill the helper. */
export function disposeMacAgent(): void {
  server?.close();
  server = null;
  helper?.dispose();
  helper = null;
}
