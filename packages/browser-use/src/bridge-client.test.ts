import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserAgentClient } from './bridge-client.js';
import {
  BROWSER_AGENT_SOCK_ENV,
  BROWSER_AGENT_TOKEN_ENV,
  type BrowserAgentRequest,
  type BrowserAgentResponse,
} from './protocol.js';

interface Harness {
  socketPath: string;
  server: net.Server;
  received: BrowserAgentRequest[];
}

const servers: net.Server[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A minimal line-delimited JSON server that runs `respond` per request. */
function startServer(
  respond: (req: BrowserAgentRequest) => Partial<BrowserAgentResponse>,
): Promise<Harness> {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-bua-test-'));
  dirs.push(dir);
  const socketPath = path.join(dir, 's.sock');
  const received: BrowserAgentRequest[] = [];
  const server = net.createServer((socket) => {
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buf += chunk;
      let nl = buf.indexOf('\n');
      while (nl !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim() !== '') {
          const req = JSON.parse(line) as BrowserAgentRequest;
          received.push(req);
          const base: BrowserAgentResponse = { id: req.id, ok: true };
          socket.write(`${JSON.stringify({ ...base, ...respond(req) })}\n`);
        }
        nl = buf.indexOf('\n');
      }
    });
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(socketPath, () => resolve({ socketPath, server, received }));
  });
}

describe('BrowserAgentClient', () => {
  it('round-trips a request, echoes the token, and resolves the result', async () => {
    const h = await startServer((req) => ({ result: { echoed: req.method } }));
    const client = new BrowserAgentClient({ socketPath: h.socketPath, token: 'secret' });
    const result = await client.request('navigate', { url: 'https://x.test' });
    expect(result).toEqual({ echoed: 'navigate' });
    expect(h.received[0]).toMatchObject({
      method: 'navigate',
      token: 'secret',
      params: { url: 'https://x.test' },
    });
    client.dispose();
  });

  it('rejects when the app returns an error', async () => {
    const h = await startServer(() => ({ ok: false, error: 'no tab' }));
    const client = new BrowserAgentClient({ socketPath: h.socketPath, token: 't' });
    await expect(client.request('click')).rejects.toThrow('no tab');
    client.dispose();
  });

  it('multiplexes concurrent requests by id', async () => {
    const h = await startServer((req) => ({ result: (req.params?.n as number) * 2 }));
    const client = new BrowserAgentClient({ socketPath: h.socketPath, token: 't' });
    const results = await Promise.all([
      client.request<number>('evaluate', { n: 1 }),
      client.request<number>('evaluate', { n: 2 }),
      client.request<number>('evaluate', { n: 3 }),
    ]);
    expect(results).toEqual([2, 4, 6]);
    client.dispose();
  });

  it('rejects with a connect error for a missing socket', async () => {
    const client = new BrowserAgentClient({
      socketPath: path.join(tmpdir(), 'pi-bua-does-not-exist.sock'),
      token: 't',
      connectTimeoutMs: 500,
    });
    await expect(client.request('ensureTab')).rejects.toBeInstanceOf(Error);
    client.dispose();
  });

  it('fromEnv returns null without the socket env and a client with it', () => {
    expect(BrowserAgentClient.fromEnv({})).toBeNull();
    const client = BrowserAgentClient.fromEnv({
      [BROWSER_AGENT_SOCK_ENV]: '/tmp/x.sock',
      [BROWSER_AGENT_TOKEN_ENV]: 'tok',
    });
    expect(client).toBeInstanceOf(BrowserAgentClient);
  });
});
