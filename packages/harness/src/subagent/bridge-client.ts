/**
 * Subagent bridge client — the pi-child half of the spawn_subagent app bridge.
 * When Pi Desktop published the bridge socket on the env, `spawn_subagent` routes
 * HERE instead of running the child in-process: we ask the app to run the subagent
 * (as its OWN pi, streamed to the sidebar dropdown as a live nested chat) and wait
 * for the app to hand back its final answer as the summary — so the model still
 * gets the result in-context, exactly like the in-process runner did.
 *
 * Transport mirrors @pi-desktop/browser-use's bridge client: connect to the Unix
 * socket, send one `{id, token, method:'spawn', params}` line, await the reply.
 * Env keys are kept in sync with apps/desktop electron/pi/subagent-bridge.ts.
 */
import net from 'node:net';
import type { ChildAgentResult, RunChildAgentOptions } from './child-agent.js';

const SOCK_ENV = 'PI_DESKTOP_SUBAGENT_SOCK';
const TOKEN_ENV = 'PI_DESKTOP_SUBAGENT_TOKEN';
const CONNECT_TIMEOUT_MS = 5_000;

/** The subagent name is carried alongside the standard runChild options so the
 * app can title the nested chat; the in-process runner ignores it. */
export type BridgeRunChildOptions = RunChildAgentOptions & { readonly name?: string };

function failed(error: string, timedOut = false): ChildAgentResult {
  return { ok: false, summary: '', steps: 0, timedOut, error };
}

function runViaBridge(
  socketPath: string,
  token: string,
  opts: BridgeRunChildOptions,
): Promise<ChildAgentResult> {
  return new Promise<ChildAgentResult>((resolve) => {
    const socket = net.connect(socketPath);
    let buffer = '';
    let settled = false;
    const done = (r: ChildAgentResult): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(r);
    };
    const connectTimer = setTimeout(
      () => done(failed('subagent bridge connect timed out')),
      CONNECT_TIMEOUT_MS,
    );
    connectTimer.unref?.();
    // The app enforces the real per-subagent timeout; this is a generous backstop.
    const overall = setTimeout(
      () => done(failed('subagent timed out', true)),
      opts.timeoutMs + 30_000,
    );
    overall.unref?.();
    const onAbort = (): void => done(failed('aborted by parent'));
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    socket.on('connect', () => {
      clearTimeout(connectTimer);
      socket.setEncoding('utf8');
      socket.write(
        `${JSON.stringify({
          id: 1,
          token,
          method: 'spawn',
          params: { goal: opts.goal, name: opts.name, timeoutMs: opts.timeoutMs },
        })}\n`,
      );
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      try {
        const res = JSON.parse(buffer.slice(0, nl)) as {
          ok?: boolean;
          summary?: string;
          error?: string;
        };
        clearTimeout(overall);
        done({
          ok: res.ok === true,
          summary: typeof res.summary === 'string' ? res.summary : '',
          steps: 0,
          timedOut: false,
          ...(res.error !== undefined ? { error: res.error } : {}),
        });
      } catch {
        done(failed('bad subagent bridge response'));
      }
    });
    socket.on('error', (e) => done(failed(`subagent bridge error: ${String(e)}`)));
  });
}

/**
 * A `runChild` that routes spawn_subagent to the app bridge, or `null` when the
 * bridge env isn't present (running outside Pi Desktop → the caller falls back to
 * the in-process `runChildAgent`).
 */
export function subagentBridgeRunChildFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ((opts: BridgeRunChildOptions) => Promise<ChildAgentResult>) | null {
  const socketPath = env[SOCK_ENV];
  const token = env[TOKEN_ENV];
  if (socketPath === undefined || socketPath === '' || token === undefined || token === '') {
    return null;
  }
  return (opts) => runViaBridge(socketPath, token, opts);
}
