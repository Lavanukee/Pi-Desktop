import { describe, expect, it } from 'vitest';
import { MacHelperClient } from './serve-client.js';
import type { MacChildProcess, MacSpawnFn } from './spawn.js';

/**
 * A fake `pi-mac --serve` child: it parses NDJSON requests written to stdin and
 * lets the test respond per request id (line-delimited), so the framing is
 * exercised without a real helper binary.
 */
function fakeServer(
  respond: (req: { id: number; method: string; params?: Record<string, unknown> }) => {
    ok?: boolean;
    result?: unknown;
    error?: string;
  },
): { spawnFn: MacSpawnFn; requests: Array<{ id: number; method: string }> } {
  const requests: Array<{ id: number; method: string }> = [];
  const dataCbs: Array<(c: string) => void> = [];
  const child: MacChildProcess = {
    pid: 1,
    stdin: {
      write: (data, cb) => {
        const line = data.trim();
        if (line.length > 0) {
          const req = JSON.parse(line);
          requests.push({ id: req.id, method: req.method });
          const r = respond(req);
          const out = JSON.stringify({
            id: req.id,
            ok: r.ok ?? true,
            result: r.result,
            error: r.error,
          });
          queueMicrotask(() => {
            for (const f of dataCbs) f(`${out}\n`);
          });
        }
        cb?.(null);
      },
      end: () => undefined,
      on: () => undefined,
    },
    stdout: { on: (_e, cb) => dataCbs.push(cb as (c: string) => void) },
    stderr: { on: () => undefined },
    on: () => undefined,
    kill: () => undefined,
  };
  return { spawnFn: () => child, requests };
}

describe('MacHelperClient', () => {
  it('round-trips a request and resolves the result', async () => {
    const server = fakeServer((req) => ({ result: { echoed: req.method, params: req.params } }));
    const client = new MacHelperClient({ spawnFn: server.spawnFn, helperPath: '/bin/pi-mac' });
    const res = await client.request('snapshot', { app: 'TextEdit' });
    expect(res).toEqual({ echoed: 'snapshot', params: { app: 'TextEdit' } });
    expect(server.requests[0]).toMatchObject({ id: 1, method: 'snapshot' });
    client.dispose();
  });

  it('round-trips the background/mode ack a click/type returns (mock helper)', async () => {
    const server = fakeServer((req) =>
      req.method === 'click'
        ? { result: { found: true, mode: 'AXPress', background: true } }
        : { result: { found: true, mode: 'setValue+confirm', background: true, submitted: true } },
    );
    const client = new MacHelperClient({ spawnFn: server.spawnFn, helperPath: '/bin/pi-mac' });
    const click = await client.request<{ found: boolean; background: boolean; mode: string }>(
      'click',
      { index: 1, pid: 321 },
    );
    expect(click).toEqual({ found: true, mode: 'AXPress', background: true });
    const type = await client.request<{ background: boolean; submitted: boolean }>('type', {
      index: 2,
      text: 'sf',
      submit: true,
    });
    expect(type).toMatchObject({ background: true, submitted: true });
    client.dispose();
  });

  it('rejects when the helper returns an error', async () => {
    const server = fakeServer(() => ({ ok: false, error: 'target unresolved' }));
    const client = new MacHelperClient({ spawnFn: server.spawnFn, helperPath: '/bin/pi-mac' });
    await expect(client.request('snapshot')).rejects.toThrow('target unresolved');
    client.dispose();
  });

  it('multiplexes concurrent requests by id and spawns the helper once', async () => {
    let spawns = 0;
    const base = fakeServer((req) => ({ result: (req.params?.n as number) * 10 }));
    const spawnFn: MacSpawnFn = (cmd, args) => {
      spawns++;
      return base.spawnFn(cmd, args);
    };
    const client = new MacHelperClient({ spawnFn, helperPath: '/bin/pi-mac' });
    const results = await Promise.all([
      client.request<number>('click', { n: 1 }),
      client.request<number>('type', { n: 2 }),
      client.request<number>('key', { n: 3 }),
    ]);
    expect(results).toEqual([10, 20, 30]);
    expect(spawns).toBe(1);
    client.dispose();
  });

  it('times out a wedged helper without hanging', async () => {
    const child: MacChildProcess = {
      pid: 1,
      stdin: { write: (_d, cb) => cb?.(null), end: () => undefined, on: () => undefined },
      stdout: { on: () => undefined }, // never responds
      stderr: { on: () => undefined },
      on: () => undefined,
      kill: () => undefined,
    };
    const client = new MacHelperClient({
      spawnFn: () => child,
      helperPath: '/bin/pi-mac',
      requestTimeoutMs: 20,
    });
    await expect(client.request('snapshot')).rejects.toThrow('timed out');
    client.dispose();
  });
});
