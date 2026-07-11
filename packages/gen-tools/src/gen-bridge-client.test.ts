import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GenBridgeClient } from './gen-bridge-client.ts';
import {
  GEN_SOCK_ENV,
  GEN_TOKEN_ENV,
  type GenBridgeRequest,
  type GenBridgeResponse,
} from './gen-contract.ts';

interface Harness {
  socketPath: string;
  server: net.Server;
  received: GenBridgeRequest[];
}

const servers: net.Server[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function startServer(
  respond: (req: GenBridgeRequest) => Partial<GenBridgeResponse>,
): Promise<Harness> {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-gen-test-'));
  dirs.push(dir);
  const socketPath = path.join(dir, 's.sock');
  const received: GenBridgeRequest[] = [];
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
          const req = JSON.parse(line) as GenBridgeRequest;
          received.push(req);
          const base: GenBridgeResponse = { id: req.id, ok: true };
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

describe('GenBridgeClient', () => {
  it('round-trips generate, echoes the token, and resolves outputs', async () => {
    const h = await startServer((req) => ({
      result: {
        jobId: 'j1',
        outputs: [{ outputPath: '/o.png', modality: 'image', model: req.params?.model }],
      },
    }));
    const client = new GenBridgeClient({ socketPath: h.socketPath, token: 'secret' });
    const result = await client.generate({ prompt: 'a cat', model: 'z-image-turbo' });
    expect(result.jobId).toBe('j1');
    expect(result.outputs[0]?.outputPath).toBe('/o.png');
    expect(h.received[0]).toMatchObject({
      method: 'generate',
      token: 'secret',
      params: { prompt: 'a cat', model: 'z-image-turbo' },
    });
    client.dispose();
  });

  it('round-trips generateVideo, carries the video params, and returns a poster frame', async () => {
    const h = await startServer((req) => ({
      result: {
        jobId: 'v1',
        outputs: [{ outputPath: '/o.mp4', modality: 'video', model: req.params?.model }],
        posterFramePath: '/o.poster.png',
      },
    }));
    const client = new GenBridgeClient({ socketPath: h.socketPath, token: 'secret' });
    const result = await client.generateVideo({
      prompt: 'a breaking wave',
      model: 'wan2.1-t2v-1.3b',
      seconds: 4,
      fps: 24,
      size: '768x512',
    });
    expect(result.jobId).toBe('v1');
    expect(result.outputs[0]?.outputPath).toBe('/o.mp4');
    expect(result.posterFramePath).toBe('/o.poster.png');
    expect(h.received[0]).toMatchObject({
      method: 'generateVideo',
      token: 'secret',
      params: { prompt: 'a breaking wave', model: 'wan2.1-t2v-1.3b', seconds: 4, fps: 24 },
    });
    client.dispose();
  });

  it('rejects when the app returns an error', async () => {
    const h = await startServer(() => ({ ok: false, error: 'no uv' }));
    const client = new GenBridgeClient({ socketPath: h.socketPath, token: 't' });
    await expect(client.generate({ prompt: 'x' })).rejects.toThrow('no uv');
    client.dispose();
  });

  it('multiplexes concurrent requests by id', async () => {
    const h = await startServer((req) => ({ result: (req.params?.n as number) * 3 }));
    const client = new GenBridgeClient({ socketPath: h.socketPath, token: 't' });
    const results = await Promise.all([
      client.request<number>('listModels', { n: 1 }),
      client.request<number>('listModels', { n: 2 }),
    ]);
    expect(results).toEqual([3, 6]);
    client.dispose();
  });

  it('rejects with a connect error for a missing socket', async () => {
    const client = new GenBridgeClient({
      socketPath: path.join(tmpdir(), 'pi-gen-does-not-exist.sock'),
      token: 't',
      connectTimeoutMs: 500,
    });
    await expect(client.cancel('j1')).rejects.toBeInstanceOf(Error);
    client.dispose();
  });

  it('fromEnv returns null without the socket env and a client with it', () => {
    expect(GenBridgeClient.fromEnv({})).toBeNull();
    const client = GenBridgeClient.fromEnv({
      [GEN_SOCK_ENV]: '/tmp/x.sock',
      [GEN_TOKEN_ENV]: 'tok',
    });
    expect(client).toBeInstanceOf(GenBridgeClient);
  });
});
