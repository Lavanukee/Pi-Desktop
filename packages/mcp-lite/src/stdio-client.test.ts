import { describe, expect, it } from 'vitest';
import type { McpChildProcess, McpSpawnFn } from './stdio-client';
import { McpStdioClient } from './stdio-client';

interface FakeBehavior {
  /** Never reply to `initialize` (drives the handshake timeout). */
  hangInitialize?: boolean;
  /** Tools returned by `tools/list`. */
  tools?: Array<{ name: string; description?: string }>;
  /** Custom `tools/call` responder; defaults to echoing the args. */
  onCall?: (name: string, args: Record<string, unknown>) => unknown;
}

/**
 * An in-memory MCP server implementing the structural child slice, so the
 * client's dispatch/timeout/teardown paths run with no real process.
 */
class FakeServer implements McpChildProcess {
  pid = 4242;
  killed: 'SIGTERM' | 'SIGKILL' | null = null;
  private dataCb: ((c: string) => void) | null = null;
  private closeCb: ((code: number | null, signal: string | null) => void) | null = null;
  private buf = '';

  constructor(private readonly behavior: FakeBehavior) {}

  stdin = {
    write: (data: string, cb?: (err?: Error | null) => void): void => {
      this.onWrite(data);
      cb?.(null);
    },
    end: (): void => {},
    on: (_event: 'error', _cb: (err: Error) => void): void => {},
  };
  stdout = {
    setEncoding: (): void => {},
    on: (event: 'data', cb: (chunk: string) => void): void => {
      if (event === 'data') this.dataCb = cb;
    },
  };
  stderr = { setEncoding: (): void => {}, on: (): void => {} };

  on(event: 'error' | 'close', cb: (...args: never[]) => void): void {
    if (event === 'close') this.closeCb = cb as (c: number | null, s: string | null) => void;
  }

  kill(signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): void {
    if (this.killed) return;
    this.killed = signal;
    // Simulate the process dying: emit close on the next tick.
    setImmediate(() => this.closeCb?.(null, signal));
  }

  private emit(obj: unknown): void {
    this.dataCb?.(`${JSON.stringify(obj)}\n`);
  }

  private onWrite(data: string): void {
    this.buf += data;
    let nl = this.buf.indexOf('\n');
    while (nl >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      nl = this.buf.indexOf('\n');
      if (!line) continue;
      const msg = JSON.parse(line) as { id?: number; method?: string; params?: unknown };
      this.respond(msg);
    }
  }

  private respond(msg: { id?: number; method?: string; params?: unknown }): void {
    if (msg.id === undefined) return; // notification
    const id = msg.id;
    if (msg.method === 'initialize') {
      if (this.behavior.hangInitialize) return;
      this.emit({
        jsonrpc: '2.0',
        id,
        result: { protocolVersion: '2024-11-05', serverInfo: { name: 'fake', version: '1' } },
      });
    } else if (msg.method === 'tools/list') {
      this.emit({ jsonrpc: '2.0', id, result: { tools: this.behavior.tools ?? [] } });
    } else if (msg.method === 'tools/call') {
      const params = msg.params as { name: string; arguments: Record<string, unknown> };
      const responder =
        this.behavior.onCall ??
        ((_n, a) => ({ content: [{ type: 'text', text: JSON.stringify(a) }] }));
      this.emit({ jsonrpc: '2.0', id, result: responder(params.name, params.arguments) });
    } else {
      this.emit({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
    }
  }
}

function fakeSpawn(behavior: FakeBehavior): { spawnFn: McpSpawnFn; children: FakeServer[] } {
  const children: FakeServer[] = [];
  const spawnFn: McpSpawnFn = () => {
    const child = new FakeServer(behavior);
    children.push(child);
    return child;
  };
  return { spawnFn, children };
}

describe('McpStdioClient handshake + discovery', () => {
  it('initializes and lists tools', async () => {
    const { spawnFn } = fakeSpawn({ tools: [{ name: 'echo', description: 'echoes' }] });
    const client = new McpStdioClient({ command: 'x', spawnFn });
    const tools = await client.start({ timeoutMs: 1000 });
    expect(tools.map((t) => t.name)).toEqual(['echo']);
    expect(client.serverInfo?.name).toBe('fake');
    expect(client.connected).toBe(true);
    client.stop();
  });

  it('routes tool calls and returns the raw result', async () => {
    const { spawnFn } = fakeSpawn({
      tools: [{ name: 'add' }],
      onCall: (_n, a) => ({ content: [{ type: 'text', text: String(Number(a.a) + Number(a.b)) }] }),
    });
    const client = new McpStdioClient({ command: 'x', spawnFn });
    await client.start({ timeoutMs: 1000 });
    const res = await client.callTool('add', { a: 2, b: 3 }, 1000);
    expect(res.content?.[0]).toMatchObject({ type: 'text', text: '5' });
    client.stop();
  });
});

describe('McpStdioClient timeout + teardown', () => {
  it('rejects and tears down when initialize never replies', async () => {
    const { spawnFn, children } = fakeSpawn({ hangInitialize: true });
    const client = new McpStdioClient({ command: 'x', spawnFn, killGraceMs: 10 });
    await expect(client.start({ timeoutMs: 50 })).rejects.toThrow(/timed out/);
    expect(children[0]?.killed).toBe('SIGTERM');
    await client.whenClosed();
    expect(client.connected).toBe(false);
  });

  it('rejects in-flight calls on stop()', async () => {
    // A call to a tool the fake never answers (slow: no onCall match returns a
    // method-not-found error, so instead use a hanging responder).
    const { spawnFn } = fakeSpawn({
      tools: [{ name: 'wait' }],
      onCall: () => undefined, // emits result:undefined → dispatch ignores, request hangs
    });
    const client = new McpStdioClient({ command: 'x', spawnFn, killGraceMs: 10 });
    await client.start({ timeoutMs: 1000 });
    const pending = client.callTool('wait', {}, 5000);
    client.stop();
    await expect(pending).rejects.toThrow(/stopped|exited/);
  });

  it('is idempotent on repeated stop()', async () => {
    const { spawnFn } = fakeSpawn({ tools: [] });
    const client = new McpStdioClient({ command: 'x', spawnFn, killGraceMs: 10 });
    await client.start({ timeoutMs: 1000 });
    client.stop();
    client.stop();
    await client.whenClosed();
    expect(client.connected).toBe(false);
  });
});

describe('McpStdioClient reconnect', () => {
  it('spawns a fresh process and re-lists tools', async () => {
    const { spawnFn, children } = fakeSpawn({ tools: [{ name: 'echo' }] });
    const client = new McpStdioClient({ command: 'x', spawnFn, killGraceMs: 10 });
    await client.start({ timeoutMs: 1000 });
    const tools = await client.reconnect({ timeoutMs: 1000 });
    expect(tools.map((t) => t.name)).toEqual(['echo']);
    expect(children).toHaveLength(2); // old + new
    expect(children[0]?.killed).toBeTruthy();
    client.stop();
  });
});

describe('McpStdioClient guards', () => {
  it('rejects calls before start()', async () => {
    const { spawnFn } = fakeSpawn({ tools: [] });
    const client = new McpStdioClient({ command: 'x', spawnFn });
    await expect(client.callTool('x', {}, 100)).rejects.toThrow(/not connected/);
  });
});
