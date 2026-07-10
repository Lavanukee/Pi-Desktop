/**
 * MacAgentClient — the pi-child half of the mac-agent bridge.
 *
 * Speaks line-delimited JSON-RPC (see ./protocol.ts) to the app's Unix-domain
 * socket over `node:net`. One lazily-opened, auto-reconnecting connection; each
 * request is correlated by an incrementing id and bounded by a timeout so a
 * stuck app can never wedge a tool. Every failure resolves to a rejected promise
 * the tools translate into a structured (never-thrown) error. Structurally a
 * copy of browser-use/bridge-client.ts, renamed to the PI_MAC_* env.
 */
import net from 'node:net';
import {
  MAC_AGENT_SOCK_ENV,
  MAC_AGENT_TOKEN_ENV,
  type MacAgentMethod,
  type MacAgentRequest,
  type MacAgentResponse,
} from './protocol.js';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface MacAgentClientOptions {
  readonly socketPath: string;
  readonly token: string;
  /** Per-request timeout (ms). Default 30000. */
  readonly requestTimeoutMs?: number;
  /** Connection attempt timeout (ms). Default 5000. */
  readonly connectTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT = 30_000;
const DEFAULT_CONNECT_TIMEOUT = 5_000;

export class MacAgentClient {
  readonly #socketPath: string;
  readonly #token: string;
  readonly #requestTimeoutMs: number;
  readonly #connectTimeoutMs: number;
  readonly #pending = new Map<number, Pending>();
  #socket: net.Socket | null = null;
  #connecting: Promise<net.Socket> | null = null;
  #buffer = '';
  #nextId = 1;

  constructor(opts: MacAgentClientOptions) {
    this.#socketPath = opts.socketPath;
    this.#token = opts.token;
    this.#requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT;
    this.#connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT;
  }

  /** Build a client from the env the app injects, or `null` when unavailable
   * (extension loaded outside Pi Desktop → tools report a clear error). */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): MacAgentClient | null {
    const socketPath = env[MAC_AGENT_SOCK_ENV];
    const token = env[MAC_AGENT_TOKEN_ENV];
    if (socketPath === undefined || socketPath === '' || token === undefined) return null;
    return new MacAgentClient({ socketPath, token });
  }

  #connect(): Promise<net.Socket> {
    if (this.#socket !== null && !this.#socket.destroyed) return Promise.resolve(this.#socket);
    if (this.#connecting !== null) return this.#connecting;
    this.#connecting = new Promise<net.Socket>((resolve, reject) => {
      const socket = net.connect(this.#socketPath);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`mac bridge connect timed out (${this.#connectTimeoutMs}ms)`));
      }, this.#connectTimeoutMs);
      timer.unref?.();
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.setEncoding('utf8');
        this.#socket = socket;
        this.#connecting = null;
        socket.on('data', (chunk: string) => this.#onData(chunk));
        socket.on('close', () => this.#onClose(new Error('mac bridge connection closed')));
        socket.on('error', () => {
          /* surfaced via 'close'; a bare 'error' must not crash the child */
        });
        resolve(socket);
      });
      socket.once('error', (err) => {
        clearTimeout(timer);
        this.#connecting = null;
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
    return this.#connecting;
  }

  #onClose(reason: Error): void {
    this.#socket = null;
    this.#buffer = '';
    for (const [, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(reason);
    }
    this.#pending.clear();
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    let nl = this.#buffer.indexOf('\n');
    while (nl !== -1) {
      const line = this.#buffer.slice(0, nl);
      this.#buffer = this.#buffer.slice(nl + 1);
      if (line.trim() !== '') this.#handleLine(line);
      nl = this.#buffer.indexOf('\n');
    }
  }

  #handleLine(line: string): void {
    let msg: MacAgentResponse;
    try {
      msg = JSON.parse(line) as MacAgentResponse;
    } catch {
      return; // ignore non-JSON noise
    }
    if (typeof msg.id !== 'number') return;
    const pending = this.#pending.get(msg.id);
    if (pending === undefined) return;
    this.#pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.ok) pending.resolve(msg.result);
    else pending.reject(new Error(msg.error ?? 'mac bridge error'));
  }

  /** Issue one RPC. Rejects on transport/timeout/app error. */
  async request<T = unknown>(method: MacAgentMethod, params?: Record<string, unknown>): Promise<T> {
    const socket = await this.#connect();
    const id = this.#nextId++;
    const payload: MacAgentRequest = { id, token: this.#token, method, params };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`mac bridge "${method}" timed out (${this.#requestTimeoutMs}ms)`));
      }, this.#requestTimeoutMs);
      timer.unref?.();
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        socket.write(`${JSON.stringify(payload)}\n`, (err) => {
          if (err != null) {
            const p = this.#pending.get(id);
            if (p !== undefined) {
              this.#pending.delete(id);
              clearTimeout(p.timer);
              reject(err);
            }
          }
        });
      } catch (err) {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  dispose(): void {
    this.#onClose(new Error('client disposed'));
    this.#socket?.destroy();
    this.#socket = null;
  }
}

/** The narrow surface the tools depend on — lets tests inject a fake bridge. */
export interface MacBridge {
  request<T = unknown>(method: MacAgentMethod, params?: Record<string, unknown>): Promise<T>;
}
