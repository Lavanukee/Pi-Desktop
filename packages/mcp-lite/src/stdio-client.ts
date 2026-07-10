/**
 * McpStdioClient — a minimal Model Context Protocol client over the stdio
 * transport (newline-delimited JSON-RPC 2.0, one message per line, no embedded
 * newlines).
 *
 * TS port of RemotePi's `subagents/mcp-client.js`. Kept behaviours:
 * - `initialize` handshake with a timeout, then `notifications/initialized`,
 * - id-correlated request/response with per-request timeouts,
 * - reject-and-teardown on any failure so a misconfigured server can never
 *   wedge the caller indefinitely,
 * - SIGTERM → SIGKILL kill ladder on {@link McpStdioClient.stop}.
 *
 * Changes from the source: full typing against {@link ./mcp-types}, structural
 * spawn injection (mirrors packages/engine pi-bridge.ts) so it unit-tests in
 * plain Node without a real server, `resources/list` + `prompts/list`, a
 * `whenClosed()` teardown promise, and `reconnect()`.
 */
import { spawn } from 'node:child_process';
import type {
  JsonRpcMessage,
  McpClientInfo,
  McpInitializeResult,
  McpPromptDef,
  McpResourceDef,
  McpServerInfo,
  McpToolCallResult,
  McpToolDef,
} from './mcp-types';
import { MCP_PROTOCOL_VERSION } from './mcp-types';

/** Structural slice of a Node ChildProcess so tests can inject a fake. */
export interface McpChildProcess {
  pid?: number;
  stdin: {
    write(data: string, cb?: (err?: Error | null) => void): void;
    end(): void;
    on(event: 'error', cb: (err: Error) => void): void;
  };
  stdout: { setEncoding(enc: string): void; on(event: 'data', cb: (chunk: string) => void): void };
  stderr: { setEncoding(enc: string): void; on(event: 'data', cb: (chunk: string) => void): void };
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: 'close', cb: (code: number | null, signal: string | null) => void): void;
  kill(signal?: 'SIGTERM' | 'SIGKILL'): void;
}

/** Spawn function shape (default wraps node:child_process spawn). */
export type McpSpawnFn = (
  command: string,
  args: string[],
  options: { env: Record<string, string | undefined>; cwd?: string },
) => McpChildProcess;

const defaultSpawn: McpSpawnFn = (command, args, options) =>
  // Cast through unknown: the real ChildProcess has nullable streams and a
  // wider event surface than the structural slice we depend on.
  spawn(command, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: options.env,
    cwd: options.cwd,
  }) as unknown as McpChildProcess;

export interface McpStdioClientOptions {
  /** Executable that launches the MCP server. */
  command: string;
  /** Arguments passed to the server. */
  args?: string[];
  /** Extra env vars, merged over process.env. */
  env?: Record<string, string>;
  /** Working directory for the server. */
  cwd?: string;
  /** Receives server stderr lines. */
  onLog?: (line: string) => void;
  /** Called when the server process closes (crash, kill, or normal exit). */
  onClose?: (code: number | null, signal: string | null) => void;
  /** Grace period between SIGTERM and SIGKILL in {@link stop}. Default 1500. */
  killGraceMs?: number;
  /** Structural spawn injection for tests. Defaults to node:child_process spawn. */
  spawnFn?: McpSpawnFn;
  /** Identity advertised in the handshake. */
  clientInfo?: McpClientInfo;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_CALL_TIMEOUT_MS = 120_000;

export class McpStdioClient {
  readonly command: string;
  readonly args: string[];
  private readonly env: Record<string, string>;
  private readonly cwd: string | undefined;
  private readonly onLog: (line: string) => void;
  private readonly onClose: (code: number | null, signal: string | null) => void;
  private readonly killGraceMs: number;
  private readonly spawnFn: McpSpawnFn;
  private readonly clientInfo: McpClientInfo;

  private child: McpChildProcess | null = null;
  private buf = '';
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<number, Pending>();
  private killTimer: ReturnType<typeof setTimeout> | null = null;
  private closedResolve: (() => void) | null = null;
  private closedPromise: Promise<void> = Promise.resolve();

  /** Server identity from the handshake, or null before/without one. */
  serverInfo: McpServerInfo | null = null;
  /** Protocol version echoed by the server, or null. */
  protocolVersion: string | null = null;
  /** Last-known tool list (refreshed by {@link start}/{@link listTools}). */
  tools: McpToolDef[] = [];

  constructor(opts: McpStdioClientOptions) {
    this.command = opts.command;
    this.args = opts.args ?? [];
    this.env = opts.env ?? {};
    this.cwd = opts.cwd;
    this.onLog = typeof opts.onLog === 'function' ? opts.onLog : () => {};
    this.onClose = typeof opts.onClose === 'function' ? opts.onClose : () => {};
    this.killGraceMs = opts.killGraceMs ?? 1500;
    this.spawnFn = opts.spawnFn ?? defaultSpawn;
    this.clientInfo = opts.clientInfo ?? { name: 'pi-desktop-mcp-lite', version: '1.0.0' };
  }

  /** True while the server process is up and requests can be sent. */
  get connected(): boolean {
    return this.child !== null && !this.closed;
  }

  /**
   * Spawn the server, perform the `initialize` handshake, and fetch the tool
   * list. Resolves with the tools. Rejects (and tears down) on any failure.
   */
  async start(opts: { timeoutMs?: number } = {}): Promise<McpToolDef[]> {
    if (!this.command) throw new Error("McpStdioClient: no 'command' configured");
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.spawnChild();
    try {
      const init = (await this.request(
        'initialize',
        {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {}, resources: {}, prompts: {} },
          clientInfo: this.clientInfo,
        },
        timeoutMs,
      )) as McpInitializeResult | null;
      this.serverInfo = init?.serverInfo ?? null;
      this.protocolVersion = init?.protocolVersion ?? null;
      this.notify('notifications/initialized', {});
      this.tools = await this.listTools(timeoutMs);
      return this.tools;
    } catch (e) {
      this.stop();
      throw e;
    }
  }

  /** Stop, then start again with the same configuration. Returns fresh tools. */
  async reconnect(opts: { timeoutMs?: number } = {}): Promise<McpToolDef[]> {
    this.stop();
    await this.closedPromise;
    this.closed = false;
    this.buf = '';
    this.nextId = 1;
    this.child = null;
    if (this.killTimer !== null) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }
    return this.start(opts);
  }

  /** Refresh and return the server's tool list. */
  async listTools(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<McpToolDef[]> {
    const res = (await this.request('tools/list', {}, timeoutMs)) as {
      tools?: McpToolDef[];
    } | null;
    this.tools = Array.isArray(res?.tools) ? res.tools : [];
    return this.tools;
  }

  /** List resources the server exposes (empty if unsupported). */
  async listResources(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<McpResourceDef[]> {
    try {
      const res = (await this.request('resources/list', {}, timeoutMs)) as {
        resources?: McpResourceDef[];
      } | null;
      return Array.isArray(res?.resources) ? res.resources : [];
    } catch {
      return [];
    }
  }

  /** List prompts the server exposes (empty if unsupported). */
  async listPrompts(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<McpPromptDef[]> {
    try {
      const res = (await this.request('prompts/list', {}, timeoutMs)) as {
        prompts?: McpPromptDef[];
      } | null;
      return Array.isArray(res?.prompts) ? res.prompts : [];
    } catch {
      return [];
    }
  }

  /** Invoke a tool and return the raw MCP result. */
  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    timeoutMs = DEFAULT_CALL_TIMEOUT_MS,
  ): Promise<McpToolCallResult> {
    const res = (await this.request(
      'tools/call',
      { name, arguments: args ?? {} },
      timeoutMs,
    )) as McpToolCallResult | null;
    return res ?? {};
  }

  /**
   * Kill the server and reject any in-flight requests. Idempotent. Runs the
   * SIGTERM → SIGKILL kill ladder so a wedged server is guaranteed to die.
   */
  stop(): void {
    this.closed = true;
    const child = this.child;
    if (child) {
      try {
        child.stdin.end();
      } catch {
        // stdin may already be destroyed.
      }
      try {
        child.kill('SIGTERM');
      } catch {
        // Process may already be gone.
      }
      if (this.killTimer === null) {
        this.killTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // Process may already be gone.
          }
        }, this.killGraceMs);
        this.killTimer.unref?.();
      }
    }
    this.failAll(new Error('MCP client stopped'));
  }

  /** Resolves once the server process has closed. */
  whenClosed(): Promise<void> {
    return this.closedPromise;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private spawnChild(): void {
    this.closedPromise = new Promise((resolve) => {
      this.closedResolve = resolve;
    });
    const child = this.spawnFn(this.command, this.args, {
      env: { ...process.env, ...this.env },
      cwd: this.cwd,
    });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => this.onStdout(d));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      const s = String(d).replace(/\s+$/, '');
      if (s) this.onLog(s);
    });
    // Async write failures (EPIPE from a dying server) surface here; without a
    // listener Node turns them into an uncaughtException.
    child.stdin.on('error', (e) => this.failAll(e));
    child.on('error', (e) => this.failAll(e));
    child.on('close', (code, signal) => {
      this.closed = true;
      if (this.killTimer !== null) {
        clearTimeout(this.killTimer);
        this.killTimer = null;
      }
      this.failAll(new Error(`MCP server process exited (code ${code ?? signal})`));
      this.closedResolve?.();
      this.closedResolve = null;
      this.onClose(code, signal);
    });
  }

  private onStdout(chunk: string): void {
    this.buf += chunk;
    let nl = this.buf.indexOf('\n');
    while (nl >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      nl = this.buf.indexOf('\n');
      if (!line) continue;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line) as JsonRpcMessage;
      } catch {
        this.onLog(`non-JSON stdout line: ${line}`);
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: JsonRpcMessage): void {
    // We only consume responses to our own requests. Server-initiated requests
    // and notifications are ignored (we advertise no client capabilities).
    if (
      msg.id !== undefined &&
      typeof msg.id === 'number' &&
      (msg.result !== undefined || msg.error !== undefined)
    ) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) {
        const m = msg.error.message || JSON.stringify(msg.error);
        pending.reject(new Error(`MCP error: ${m}`));
      } else {
        pending.resolve(msg.result);
      }
    }
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const child = this.child;
    if (this.closed || !child) {
      return Promise.reject(new Error('MCP client is not connected'));
    }
    const id = this.nextId++;
    const frame = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`MCP request '${method}' timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      const fail = (e: Error): void => {
        if (this.pending.delete(id)) {
          clearTimeout(timer);
          reject(e);
        }
      };
      try {
        child.stdin.write(frame, (err) => {
          if (err != null) fail(err);
        });
      } catch (e) {
        fail(e as Error);
      }
    });
  }

  private notify(method: string, params: unknown): void {
    const child = this.child;
    if (this.closed || !child) return;
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    } catch {
      // Server gone; pending requests will surface the error.
    }
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}
