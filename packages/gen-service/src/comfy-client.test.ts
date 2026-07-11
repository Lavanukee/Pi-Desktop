import { describe, expect, it, vi } from 'vitest';
import { GenAbortError } from './client.ts';
import { ComfyClient, type ComfyWebSocket, type ComfyWsFactory } from './comfy-client.ts';
import type { GenEvent, GenJob } from './protocol.ts';

/** A fake `/ws` socket: multi-listener, with test drivers. */
class FakeWs implements ComfyWebSocket {
  readonly #l: Record<'open' | 'message' | 'close' | 'error', ((arg?: unknown) => void)[]> = {
    open: [],
    message: [],
    close: [],
    error: [],
  };
  closed = false;

  on(event: 'open', cb: () => void): void;
  on(event: 'message', cb: (data: unknown) => void): void;
  on(event: 'close', cb: (code?: number) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: 'open' | 'message' | 'close' | 'error', cb: (...args: never[]) => void): void {
    this.#l[event].push(cb as (arg?: unknown) => void);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const cb of this.#l.close) cb();
  }
  emitOpen(): void {
    for (const cb of this.#l.open) cb();
  }
  emitMessage(m: unknown): void {
    const s = typeof m === 'string' ? m : JSON.stringify(m);
    for (const cb of this.#l.message) cb(s);
  }
  emitError(e: Error): void {
    for (const cb of this.#l.error) cb(e);
  }
}

function resp(status: number, json: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
    text: async () => JSON.stringify(json),
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
  } as unknown as Response;
}

/** An in-process fake ComfyUI server driving `/prompt` → ws → `/history` → `/view`. */
class FakeComfyServer {
  readonly ws = new FakeWs();
  wsUrl = '';
  promptCounter = 0;
  readonly calls: string[] = [];
  readonly postedBodies: {
    prompt: Record<string, { inputs: Record<string, unknown> }>;
    client_id: string;
  }[] = [];
  /** Skip auto-driving ws messages (leaves the run hanging on the waiter — for abort tests). */
  manual = false;
  /** When set, POST /prompt returns this instead of driving to completion. */
  promptFailure: 'http' | 'node_errors' | null = null;
  /** When set, the ws emits execution_error for the prompt. */
  execError: string | null = null;

  readonly wsFactory: ComfyWsFactory = (url) => {
    this.wsUrl = url;
    queueMicrotask(() => this.ws.emitOpen());
    return this.ws;
  };

  readonly fetchImpl = (async (
    input: unknown,
    init?: { method?: string; body?: string },
  ): Promise<Response> => {
    const u = String(input);
    const method = init?.method ?? 'GET';
    this.calls.push(`${method} ${u}`);
    if (u.endsWith('/prompt') && method === 'POST') {
      const pid = `p${++this.promptCounter}`;
      if (this.promptFailure === 'http') return resp(500, { error: 'kernel panic' });
      const body = JSON.parse(init?.body ?? '{}');
      this.postedBodies.push(body);
      if (this.promptFailure === 'node_errors') {
        return resp(200, { prompt_id: pid, node_errors: { '3': { errors: ['bad input'] } } });
      }
      if (!this.manual) this.#drivePrompt(pid);
      return resp(200, { prompt_id: pid, number: this.promptCounter, node_errors: {} });
    }
    if (u.includes('/history/')) {
      const pid = decodeURIComponent(u.split('/history/')[1] ?? '');
      return resp(200, {
        [pid]: {
          outputs: { '9': { images: [{ filename: `${pid}.png`, subfolder: '', type: 'output' }] } },
        },
      });
    }
    if (u.includes('/view')) return resp(200, {});
    if (u.endsWith('/interrupt')) return resp(200, {});
    return resp(404, {});
  }) as unknown as typeof fetch;

  #drivePrompt(pid: string): void {
    setTimeout(() => {
      if (this.execError !== null) {
        this.ws.emitMessage({
          type: 'execution_error',
          data: { prompt_id: pid, exception_message: this.execError },
        });
        return;
      }
      this.ws.emitMessage({
        type: 'progress',
        data: { prompt_id: pid, value: 4, max: 8, node: '73' },
      });
      this.ws.emitMessage({ type: 'executing', data: { prompt_id: pid, node: '73' } }); // non-terminal
      this.ws.emitMessage({ type: 'executing', data: { prompt_id: pid, node: null } }); // terminal
    }, 0);
  }
}

const COMFY_JOB: GenJob = {
  id: 'job-c1',
  modality: 'video',
  backend: 'comfyui',
  outputDir: '/out/job-c1',
  comfy: {
    prompt: 'a paper crane',
    modelId: 'ltx-2',
    workflowTemplate: 'ltx-2-distilled-gguf',
    inputs: { prompt: 'a paper crane', width: 704, height: 480, length: 97, steps: 8 },
    seeds: [111, 222],
  },
};

function clientWith(server: FakeComfyServer): {
  client: ComfyClient;
  writes: [string, Uint8Array][];
} {
  const writes: [string, Uint8Array][] = [];
  const client = new ComfyClient({
    resolveOrigin: async () => 'http://127.0.0.1:8188',
    fetchImpl: server.fetchImpl,
    wsFactory: server.wsFactory,
    clientId: 'test-client',
    writeFileImpl: async (p, d) => {
      writes.push([p, d]);
    },
  });
  return { client, writes };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('ComfyClient.run — ws → GenEvent translation', () => {
  it('streams start → progress → candidate → done and resolves with one output per seed', async () => {
    const server = new FakeComfyServer();
    const { client, writes } = clientWith(server);
    const events: GenEvent[] = [];

    const outputs = await client.run(COMFY_JOB, { onEvent: (e) => events.push(e) });

    expect(outputs).toHaveLength(2);
    expect(outputs[0]?.model).toBe('ltx-2');
    expect(outputs[0]?.modality).toBe('video');
    expect(outputs[0]?.outputPath).toBe('/out/job-c1/p1.png');
    expect(outputs[1]?.outputPath).toBe('/out/job-c1/p2.png');
    expect(outputs[0]?.seed).toBe(111);
    expect(outputs[1]?.seed).toBe(222);

    // Files were fetched via /view and written.
    expect(writes.map(([p]) => p)).toEqual(['/out/job-c1/p1.png', '/out/job-c1/p2.png']);

    // Event translation: start, then per-candidate progress+candidate, then done.
    const kinds = events.map((e) => e.event);
    expect(kinds[0]).toBe('start');
    expect(kinds.at(-1)).toBe('done');
    expect(kinds.filter((k) => k === 'progress')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'candidate')).toHaveLength(2);

    const start = events[0];
    expect(start).toMatchObject({ event: 'start', total: 8, candidates: 2 });
    const progress = events.find((e) => e.event === 'progress');
    expect(progress).toMatchObject({ event: 'progress', candidate: 0, step: 4, total: 8 });
  });

  it('POSTs API-format graph with client_id, prompt spliced, and a distinct seed per candidate', async () => {
    const server = new FakeComfyServer();
    const { client } = clientWith(server);
    await client.run(COMFY_JOB);

    expect(server.wsUrl).toContain('/ws?clientId=test-client');
    expect(server.postedBodies).toHaveLength(2);
    const b0 = server.postedBodies[0];
    expect(b0?.client_id).toBe('test-client');
    expect(b0?.prompt['6']?.inputs.text).toBe('a paper crane'); // prompt spliced at 6.inputs.text
    expect(b0?.prompt['73']?.inputs.noise_seed).toBe(111);
    expect(server.postedBodies[1]?.prompt['73']?.inputs.noise_seed).toBe(222);
  });

  it('translates a ComfyUI execution_error into GenEvent.error and rejects', async () => {
    const server = new FakeComfyServer();
    server.execError = 'OOM in VAEDecode';
    const { client } = clientWith(server);
    const events: GenEvent[] = [];

    await expect(client.run(COMFY_JOB, { onEvent: (e) => events.push(e) })).rejects.toThrow(
      /OOM in VAEDecode/,
    );
    const err = events.find((e) => e.event === 'error');
    expect(err).toMatchObject({ event: 'error', message: 'OOM in VAEDecode', recoverable: false });
    // No candidate/done leaked out before the failure.
    expect(events.some((e) => e.event === 'done')).toBe(false);
  });

  it('rejects with a validation message when /prompt returns node_errors (and emits error)', async () => {
    const server = new FakeComfyServer();
    server.promptFailure = 'node_errors';
    const { client } = clientWith(server);
    const events: GenEvent[] = [];
    await expect(client.run(COMFY_JOB, { onEvent: (e) => events.push(e) })).rejects.toThrow(
      /validation error/,
    );
    expect(events.some((e) => e.event === 'error')).toBe(true);
  });

  it('rejects with an HTTP detail when /prompt is not ok', async () => {
    const server = new FakeComfyServer();
    server.promptFailure = 'http';
    const { client } = clientWith(server);
    await expect(client.run(COMFY_JOB)).rejects.toThrow(/\/prompt failed \(500\)/);
  });

  it('aborts mid-flight: rejects GenAbortError, closes the ws, POSTs /interrupt, emits no error', async () => {
    const server = new FakeComfyServer();
    server.manual = true; // leave the run waiting on the candidate
    const controller = new AbortController();
    const { client } = clientWith(server);
    const events: GenEvent[] = [];

    const p = client.run(COMFY_JOB, { signal: controller.signal, onEvent: (e) => events.push(e) });
    await flush();
    await flush();
    controller.abort();

    await expect(p).rejects.toBeInstanceOf(GenAbortError);
    expect(server.ws.closed).toBe(true);
    expect(events.some((e) => e.event === 'error')).toBe(false);
    // /interrupt was requested as part of the abort.
    expect(server.calls.some((c) => c === 'POST http://127.0.0.1:8188/interrupt')).toBe(true);
  });

  it('rejects immediately (no ws / no fetch) if the signal is already aborted', async () => {
    const server = new FakeComfyServer();
    const wsFactory = vi.fn(server.wsFactory);
    const fetchImpl = vi.fn(server.fetchImpl);
    const client = new ComfyClient({
      resolveOrigin: async () => 'http://127.0.0.1:8188',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      wsFactory,
      writeFileImpl: async () => {},
    });
    const controller = new AbortController();
    controller.abort();
    await expect(client.run(COMFY_JOB, { signal: controller.signal })).rejects.toBeInstanceOf(
      GenAbortError,
    );
    expect(wsFactory).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('aborts even while the socket is still connecting (open never fires)', async () => {
    const ws = new FakeWs(); // never emitOpen()
    const controller = new AbortController();
    const client = new ComfyClient({
      resolveOrigin: async () => 'http://127.0.0.1:8188',
      fetchImpl: (async () => resp(200, {})) as unknown as typeof fetch,
      wsFactory: () => ws,
      writeFileImpl: async () => {},
    });
    const p = client.run(COMFY_JOB, { signal: controller.signal });
    await flush();
    controller.abort();
    await expect(p).rejects.toBeInstanceOf(GenAbortError);
    expect(ws.closed).toBe(true);
  });

  it('throws if a comfyui job is missing its comfy spec', async () => {
    const server = new FakeComfyServer();
    const { client } = clientWith(server);
    const bad = { ...COMFY_JOB, comfy: undefined } as GenJob;
    await expect(client.run(bad)).rejects.toThrow(/missing its `comfy` spec/);
  });

  it('surfaces a ws error (socket dropped) as a job failure', async () => {
    const server = new FakeComfyServer();
    server.manual = true;
    const { client } = clientWith(server);
    const p = client.run(COMFY_JOB);
    await flush();
    await flush();
    server.ws.emitError(new Error('ECONNRESET'));
    await expect(p).rejects.toThrow(/ECONNRESET/);
  });
});
