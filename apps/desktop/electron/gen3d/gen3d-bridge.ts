/**
 * gen3d bridge — the trusted seam that lets the harness's `generate_image` /
 * `edit_image` tools (running inside the main pi child) reach the generation
 * ENGINE, which the Electron main process owns.
 *
 * They cannot call it directly: the engine is a uv/Python sidecar supervised by
 * gen3d-main, while the tools live in a separate pi process. So the tools ask
 * the app, and the app runs the job through the SAME `sidecarPost('/generate',
 * … imageOnly)` path the 3D studio's Image panel uses — one engine, one model
 * manager, one heavy job at a time on a 24 GB machine.
 *
 * Transport mirrors subagent-bridge.ts exactly: a line-delimited JSON-RPC server
 * on a Unix socket, its path + a random token published on the env BEFORE the
 * first pi spawn so the child's harness reads them (GEN3D_SOCK_ENV / _TOKEN_ENV).
 * Absent that env — a plain CLI pi — the harness simply doesn't register the
 * tools, so nothing can hang waiting on a bridge that was never there.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLogger } from '@pi-desktop/shared';
import type { ImageJobResult } from './image-jobs';

const log = createLogger('desktop:gen3d-bridge');

/** Runs one image job. Injected (gen3d-main's `runImageJob` in the app) so this
 * module stays electron-free and testable over a real socket. */
export type RunImageJob = (req: { prompt: string; editFrom?: string }) => Promise<ImageJobResult>;

let runJob: RunImageJob | null = null;

/** Env keys the harness's bridge client reads (keep in sync with
 * packages/harness src/tools/image-bridge-client.ts). */
const SOCK_ENV = 'PI_DESKTOP_GEN3D_SOCK';
const TOKEN_ENV = 'PI_DESKTOP_GEN3D_TOKEN';

let token = '';
let server: net.Server | null = null;

interface BridgeRequest {
  id: number;
  token: string;
  method: string;
  params?: { prompt?: string; imagePath?: string; instruction?: string };
}

function fail(error: string): ImageJobResult {
  return { ok: false, error };
}

export async function handleMethod(
  method: string,
  params: BridgeRequest['params'],
  run: RunImageJob | null = runJob,
): Promise<ImageJobResult> {
  if (run === null) return fail('the image engine is not available');
  if (method === 'generate_image') {
    const prompt = typeof params?.prompt === 'string' ? params.prompt : '';
    return run({ prompt });
  }
  if (method === 'edit_image') {
    const imagePath = typeof params?.imagePath === 'string' ? params.imagePath.trim() : '';
    const instruction = typeof params?.instruction === 'string' ? params.instruction : '';
    if (imagePath === '') return fail('image_path is required');
    return run({ prompt: instruction, editFrom: imagePath });
  }
  return fail(`unknown method: ${method}`);
}

function defaultSocketPath(): string {
  return path.join(tmpdir(), `pi-gen3d-${process.pid}-${randomBytes(4).toString('hex')}.sock`);
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
  let req: BridgeRequest;
  try {
    req = JSON.parse(line) as BridgeRequest;
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
  try {
    respond(await handleMethod(req.method, req.params));
  } catch (err) {
    respond({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Stand up the bridge socket and publish its env for the pi child spawned later.
 * Called from pi-main's registerPiIpc, beside {@link registerSubagentBridge} and
 * for the same reason: the env must exist BEFORE the first pi spawn reads it.
 */
export function registerGen3dBridge(run: RunImageJob): void {
  runJob = run;
  if (server !== null) return;
  const socketPath = process.env[SOCK_ENV] ?? defaultSocketPath();
  token = process.env[TOKEN_ENV] ?? randomBytes(24).toString('hex');
  try {
    if (existsSync(socketPath)) unlinkSync(socketPath);
  } catch {
    /* stale socket; listen() surfaces a real problem */
  }
  server = net.createServer((socket) => handleConnection(socket));
  server.on('error', (e) => log.error('gen3d bridge server error', { error: String(e) }));
  server.listen(socketPath, () => log.info('gen3d bridge listening', { socketPath }));
  process.env[SOCK_ENV] = socketPath;
  process.env[TOKEN_ENV] = token;
}

/** Test/lifecycle hook: close the socket server. */
export function disposeGen3dBridge(): void {
  server?.close();
  server = null;
  runJob = null;
}

/** Test hook: the env a child would read (undefined before the bridge starts). */
export function gen3dBridgeEnv(): { sock?: string; token?: string } {
  return { sock: process.env[SOCK_ENV], token: process.env[TOKEN_ENV] };
}
