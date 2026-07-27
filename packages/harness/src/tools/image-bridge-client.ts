/**
 * Image bridge client — the pi-child half of the gen3d image bridge.
 *
 * The generation engine (a uv/Python sidecar) is owned by Pi Desktop's main
 * process, so `generate_image` / `edit_image` cannot call it in-process. They
 * ask the APP over a Unix socket instead, and the app runs the job through the
 * same engine path the 3D studio uses, handing back the finished PNG's path.
 *
 * Transport mirrors subagent/bridge-client.ts: connect, send one
 * `{id, token, method, params}` line, await the reply. Env keys are kept in sync
 * with apps/desktop electron/gen3d/gen3d-bridge.ts.
 *
 * {@link imageBridgeFromEnv} returns null when the env is absent (a plain CLI
 * pi with no desktop app) — the caller then registers no tools at all, so
 * there is nothing to crash and nothing to hang.
 */
import net from 'node:net';

const SOCK_ENV = 'PI_DESKTOP_GEN3D_SOCK';
const TOKEN_ENV = 'PI_DESKTOP_GEN3D_TOKEN';
const CONNECT_TIMEOUT_MS = 5_000;
/** The app enforces the real per-job cap; this is a generous backstop so a dead
 * main process can never leave a tool call hanging forever. */
const REPLY_TIMEOUT_MS = 20 * 60_000;

export type ImageBridgeResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly error: string };

export interface ImageBridge {
  generateImage(prompt: string, signal?: AbortSignal): Promise<ImageBridgeResult>;
  editImage(
    imagePath: string,
    instruction: string,
    signal?: AbortSignal,
  ): Promise<ImageBridgeResult>;
}

function failed(error: string): ImageBridgeResult {
  return { ok: false, error };
}

function request(
  socketPath: string,
  token: string,
  method: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<ImageBridgeResult> {
  return new Promise<ImageBridgeResult>((resolve) => {
    const socket = net.connect(socketPath);
    let buffer = '';
    let settled = false;
    const done = (r: ImageBridgeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(replyTimer);
      signal?.removeEventListener('abort', onAbort);
      socket.destroy();
      resolve(r);
    };
    const connectTimer = setTimeout(
      () => done(failed('the image engine bridge did not accept a connection')),
      CONNECT_TIMEOUT_MS,
    );
    connectTimer.unref?.();
    const replyTimer = setTimeout(
      () => done(failed('the image engine did not answer in time')),
      REPLY_TIMEOUT_MS,
    );
    replyTimer.unref?.();
    const onAbort = (): void => done(failed('cancelled'));
    signal?.addEventListener('abort', onAbort, { once: true });

    socket.on('connect', () => {
      clearTimeout(connectTimer);
      socket.setEncoding('utf8');
      socket.write(`${JSON.stringify({ id: 1, token, method, params })}\n`);
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      try {
        const res = JSON.parse(buffer.slice(0, nl)) as {
          ok?: boolean;
          path?: string;
          error?: string;
        };
        if (res.ok === true && typeof res.path === 'string' && res.path.length > 0) {
          done({ ok: true, path: res.path });
          return;
        }
        done(failed(res.error ?? 'the image engine returned no image'));
      } catch {
        done(failed('bad image bridge response'));
      }
    });
    socket.on('error', (e) => done(failed(`image engine bridge error: ${String(e)}`)));
  });
}

/**
 * The image bridge, or `null` when Pi Desktop did not publish one (plain CLI
 * pi) — in which case the image tools are not registered at all.
 */
export function imageBridgeFromEnv(env: NodeJS.ProcessEnv = process.env): ImageBridge | null {
  const socketPath = env[SOCK_ENV];
  const token = env[TOKEN_ENV];
  if (socketPath === undefined || socketPath === '' || token === undefined || token === '') {
    return null;
  }
  return {
    generateImage: (prompt, signal) =>
      request(socketPath, token, 'generate_image', { prompt }, signal),
    editImage: (imagePath, instruction, signal) =>
      request(socketPath, token, 'edit_image', { imagePath, instruction }, signal),
  };
}
