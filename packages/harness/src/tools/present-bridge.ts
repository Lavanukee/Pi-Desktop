/**
 * The socket the `present` tool talks to.
 *
 * Showing a card, opening a Godot project in the canvas and screenshotting a
 * rendered page are all things only the app can do — the pi child cannot reach
 * Electron. Same transport as the other bridges here (image, subagent, gen3d): a
 * unix socket whose path + token arrive on the env, one JSON line per request.
 *
 * Absent env (a plain CLI pi outside the app) → `null`, and the tool says
 * present is unavailable rather than pretending to have shown the user anything.
 */

import net from 'node:net';
import type { PresentBridge, PreviewKind } from './present.js';

const SOCK_ENV = 'PI_DESKTOP_PRESENT_SOCK';
const TOKEN_ENV = 'PI_DESKTOP_PRESENT_TOKEN';

/** How long to wait for the app; a render+capture is the slow case. */
const TIMEOUT_MS = 30_000;

interface Reply {
  ok?: boolean;
  error?: string;
  imageBase64?: string;
  mimeType?: string;
  text?: string;
}

function call(
  socketPath: string,
  token: string,
  method: string,
  params: Record<string, unknown>,
): Promise<Reply> {
  return new Promise<Reply>((resolve) => {
    const socket = net.createConnection(socketPath);
    let buffer = '';
    let settled = false;
    const done = (r: Reply): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => done({ error: 'the app did not answer in time' }), TIMEOUT_MS);
    socket.on('error', (err) => done({ error: err.message }));
    socket.on('connect', () => {
      socket.setEncoding('utf8');
      socket.write(`${JSON.stringify({ id: 1, token, method, params })}\n`);
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      try {
        done(JSON.parse(buffer.slice(0, nl)) as Reply);
      } catch (err) {
        done({ error: err instanceof Error ? err.message : String(err) });
      }
    });
    socket.on('close', () => done({ error: 'the app closed the connection' }));
  });
}

/** Build the bridge from the env the desktop app publishes, or null. */
export function presentBridgeFromEnv(
  env: Record<string, string | undefined> = process.env,
): PresentBridge | null {
  const socketPath = env[SOCK_ENV];
  const token = env[TOKEN_ENV];
  if (socketPath === undefined || token === undefined) return null;
  if (socketPath.length === 0 || token.length === 0) return null;
  return {
    show: async (req) => {
      const r = await call(socketPath, token, 'show', { ...req });
      return r.ok === true
        ? { ok: true }
        : { ok: false, ...(r.error !== undefined ? { error: r.error } : {}) };
    },
    preview: async (req: { path: string; kind: PreviewKind }) => {
      const r = await call(socketPath, token, 'preview', { ...req });
      return {
        ...(r.imageBase64 !== undefined ? { imageBase64: r.imageBase64 } : {}),
        ...(r.mimeType !== undefined ? { mimeType: r.mimeType } : {}),
        ...(r.text !== undefined ? { text: r.text } : {}),
        ...(r.error !== undefined ? { error: r.error } : {}),
      };
    },
  };
}

export { SOCK_ENV as PRESENT_SOCK_ENV, TOKEN_ENV as PRESENT_TOKEN_ENV };
