/**
 * Subagent bridge — the trusted seam that lets the harness's `spawn_subagent` tool
 * (running inside the main pi child) ask the APP to run the subagent, instead of
 * spawning a hidden grandchild in-process. The app spawns the subagent as its own
 * `pi --mode rpc` instance (childAgents), streams it to the renderer so it shows in
 * the nested dropdown as a live nested chat, awaits its final answer, and hands
 * that summary back to the tool — so the model still gets the result in-context.
 *
 * Transport mirrors browser-agent.ts: a line-delimited JSON-RPC server on a Unix
 * socket, its path + a random token published on the env BEFORE the first pi spawn
 * so the child's harness reads them (SUBAGENT_BRIDGE_SOCK_ENV / _TOKEN_ENV). The
 * subagent nests under whichever chat the renderer last reported active.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLogger } from '@pi-desktop/shared';
import { type IpcMainInvokeEvent, ipcMain, type WebContents } from 'electron';
import { isTrustedIpcEvent } from '../trusted-senders';
import type { ChildAgents } from './child-agents';

const log = createLogger('desktop:subagent-bridge');

/** Env keys the harness's bridge client reads (keep in sync with
 * packages/harness subagent/bridge-contract.ts). */
const SOCK_ENV = 'PI_DESKTOP_SUBAGENT_SOCK';
const TOKEN_ENV = 'PI_DESKTOP_SUBAGENT_TOKEN';

const DEFAULT_TIMEOUT_MS = 300_000;

let token = '';
let server: net.Server | null = null;
let getWindow: () => WebContents | null = () => null;
let childAgents: ChildAgents<WebContents> | null = null;
/** The chat the renderer last reported active — the subagent nests under it. */
let activeSession = '';

interface SpawnRequest {
  id: number;
  token: string;
  method: string;
  params?: { goal?: string; name?: string; timeoutMs?: number };
}

async function handleSpawn(
  params: SpawnRequest['params'],
): Promise<{ ok: boolean; summary?: string; error?: string }> {
  const wc = getWindow();
  if (wc === null || wc.isDestroyed() || childAgents === null) {
    return { ok: false, error: 'no Pi Desktop window is available to run the subagent' };
  }
  const goal = typeof params?.goal === 'string' ? params.goal.trim() : '';
  if (goal.length === 0) return { ok: false, error: 'empty goal' };
  const name = params?.name?.trim() ? params.name.trim() : 'Subagent';
  const timeoutMs =
    typeof params?.timeoutMs === 'number' &&
    Number.isFinite(params.timeoutMs) &&
    params.timeoutMs > 0
      ? params.timeoutMs
      : DEFAULT_TIMEOUT_MS;
  const childId = `sub-${randomBytes(5).toString('hex')}`;
  const res = await childAgents.spawnAndWait(
    wc,
    { childId, parentId: activeSession, title: name, goal },
    timeoutMs,
  );
  return { ok: res.ok, summary: res.summary, error: res.error };
}

function defaultSocketPath(): string {
  return path.join(tmpdir(), `pi-sub-${process.pid}-${randomBytes(4).toString('hex')}.sock`);
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
  let req: SpawnRequest;
  try {
    req = JSON.parse(line) as SpawnRequest;
  } catch {
    return;
  }
  if (typeof req.id !== 'number') return;
  const respond = (patch: Record<string, unknown>): void => {
    try {
      socket.write(`${JSON.stringify({ id: req.id, ...patch })}\n`);
    } catch {
      /* peer gone */
    }
  };
  if (req.token !== token) {
    respond({ ok: false, error: 'unauthorized' });
    return;
  }
  if (req.method !== 'spawn') {
    respond({ ok: false, error: `unknown method: ${String(req.method)}` });
    return;
  }
  try {
    respond(await handleSpawn(req.params));
  } catch (err) {
    respond({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

function startServer(): void {
  const socketPath = process.env[SOCK_ENV] ?? defaultSocketPath();
  token = process.env[TOKEN_ENV] ?? randomBytes(24).toString('hex');
  try {
    if (existsSync(socketPath)) unlinkSync(socketPath);
  } catch {
    /* stale socket; listen() surfaces a real problem */
  }
  server = net.createServer((socket) => handleConnection(socket));
  server.on('error', (e) => log.error('subagent bridge server error', { error: String(e) }));
  server.listen(socketPath, () => log.info('subagent bridge listening', { socketPath }));
  // Publish for the pi child spawned later (env read at spawn time).
  process.env[SOCK_ENV] = socketPath;
  process.env[TOKEN_ENV] = token;
}

/**
 * Stand up the bridge socket (publishing its env for the pi child) and register
 * the active-session report. Called from main.ts before the first pi spawn.
 */
export function registerSubagentBridge(
  getAppWindow: () => WebContents | null,
  agents: ChildAgents<WebContents>,
): void {
  getWindow = getAppWindow;
  childAgents = agents;
  startServer();

  ipcMain.handle(
    'pi:report-active-session',
    (event: IpcMainInvokeEvent, req: { sessionFile?: string }) => {
      if (!isTrustedIpcEvent(event)) throw new Error('[subagent-bridge] untrusted sender');
      activeSession = typeof req?.sessionFile === 'string' ? req.sessionFile : '';
      return { ok: true };
    },
  );
}

/** Test/lifecycle hook: close the socket server. */
export function disposeSubagentBridge(): void {
  server?.close();
  server = null;
}
