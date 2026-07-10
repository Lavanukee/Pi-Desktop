import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MacAgentClient } from './bridge-client.js';
import {
  MAC_AGENT_SOCK_ENV,
  MAC_AGENT_TOKEN_ENV,
  type MacAgentRequest,
  type MacAgentResponse,
} from './protocol.js';

interface Harness {
  socketPath: string;
  server: net.Server;
  received: MacAgentRequest[];
}

const servers: net.Server[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A minimal line-delimited JSON server (the "mock helper") that runs `respond`
 * per request. */
function startServer(
  respond: (req: MacAgentRequest) => Partial<MacAgentResponse>,
): Promise<Harness> {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-mac-test-'));
  dirs.push(dir);
  const socketPath = path.join(dir, 's.sock');
  const received: MacAgentRequest[] = [];
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
          const req = JSON.parse(line) as MacAgentRequest;
          received.push(req);
          const base: MacAgentResponse = { id: req.id, ok: true };
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

describe('MacAgentClient', () => {
  it('round-trips a request, echoes the token, and resolves the result', async () => {
    const h = await startServer((req) => ({ result: { echoed: req.method } }));
    const client = new MacAgentClient({ socketPath: h.socketPath, token: 'secret' });
    const result = await client.request('snapshot', { app: 'TextEdit' });
    expect(result).toEqual({ echoed: 'snapshot' });
    expect(h.received[0]).toMatchObject({
      method: 'snapshot',
      token: 'secret',
      params: { app: 'TextEdit' },
    });
    client.dispose();
  });

  it('rejects when the app returns an error', async () => {
    const h = await startServer(() => ({ ok: false, error: 'accessibility not granted' }));
    const client = new MacAgentClient({ socketPath: h.socketPath, token: 't' });
    await expect(client.request('click', { index: 1 })).rejects.toThrow(
      'accessibility not granted',
    );
    client.dispose();
  });

  it('multiplexes concurrent requests by id', async () => {
    const h = await startServer((req) => ({ result: (req.params?.n as number) * 2 }));
    const client = new MacAgentClient({ socketPath: h.socketPath, token: 't' });
    const results = await Promise.all([
      client.request<number>('key', { n: 1 }),
      client.request<number>('key', { n: 2 }),
      client.request<number>('key', { n: 3 }),
    ]);
    expect(results).toEqual([2, 4, 6]);
    client.dispose();
  });

  it('rejects with a connect error for a missing socket', async () => {
    const client = new MacAgentClient({
      socketPath: path.join(tmpdir(), 'pi-mac-does-not-exist.sock'),
      token: 't',
      connectTimeoutMs: 500,
    });
    await expect(client.request('check')).rejects.toBeInstanceOf(Error);
    client.dispose();
  });

  it('fromEnv returns null without the socket env and a client with it', () => {
    expect(MacAgentClient.fromEnv({})).toBeNull();
    const client = MacAgentClient.fromEnv({
      [MAC_AGENT_SOCK_ENV]: '/tmp/x.sock',
      [MAC_AGENT_TOKEN_ENV]: 'tok',
    });
    expect(client).toBeInstanceOf(MacAgentClient);
  });
});
