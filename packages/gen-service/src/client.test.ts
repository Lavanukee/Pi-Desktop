import { describe, expect, it, vi } from 'vitest';
import {
  GenAbortError,
  type GenChildProcess,
  GenServiceClient,
  type GenSpawnFn,
} from './client.ts';
import type { GenEvent, GenJob } from './protocol.ts';

/** A controllable fake worker child that records what it was spawned with. */
class FakeChild implements GenChildProcess {
  pid = 4242;
  stdinData = '';
  stdinEnded = false;
  #stdoutCbs: ((chunk: string) => void)[] = [];
  #exitCbs: ((code: number | null, signal: string | null) => void)[] = [];
  #errorCbs: ((err: Error) => void)[] = [];
  killed: NodeJS.Signals | undefined;

  stdin = {
    write: (data: string, cb?: (err?: Error | null) => void) => {
      this.stdinData += data;
      cb?.(null);
    },
    end: () => {
      this.stdinEnded = true;
    },
    on: (_e: 'error', _cb: (err: Error) => void) => {},
  };
  stdout = {
    on: (_e: 'data', cb: (chunk: string) => void) => {
      this.#stdoutCbs.push(cb);
    },
  };
  stderr = {
    on: (_e: 'data', _cb: (chunk: string) => void) => {
      this.#stderrCb = _cb;
    },
  };
  #stderrCb: ((chunk: string) => void) | undefined;

  on(event: 'error' | 'exit', cb: never): void {
    if (event === 'exit')
      this.#exitCbs.push(cb as unknown as (c: number | null, s: string | null) => void);
    else this.#errorCbs.push(cb as unknown as (e: Error) => void);
  }
  kill(signal?: NodeJS.Signals): void {
    this.killed = signal;
  }

  // ---- test drivers ----
  emitStdout(text: string): void {
    for (const cb of this.#stdoutCbs) cb(text);
  }
  emitStderr(text: string): void {
    this.#stderrCb?.(text);
  }
  emitExit(code: number | null, signal: string | null = null): void {
    for (const cb of this.#exitCbs) cb(code, signal);
  }
  emitError(err: Error): void {
    for (const cb of this.#errorCbs) cb(err);
  }
}

const IMAGE_JOB: GenJob = {
  id: 'job-1',
  modality: 'image',
  backend: 'mflux',
  outputDir: '/out',
  image: {
    prompt: 'a crane',
    modelId: 'z-image-turbo',
    mfluxCommand: 'mflux-generate-z-image-turbo',
    seeds: [42],
    steps: 4,
    width: 256,
    height: 256,
    quantize: 4,
  },
};

function clientWith(child: FakeChild): { client: GenServiceClient; spawnFn: GenSpawnFn } {
  const spawnFn: GenSpawnFn = vi.fn(() => child);
  const client = new GenServiceClient({ uvPath: '/usr/bin/uv', spawnFn });
  return { client, spawnFn };
}

/** `run()` is async (it resolves uv before spawning), so let the spawn + handler
 * wiring settle before driving the fake child — one macrotask drains the
 * microtasks the awaits queue. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('GenServiceClient.run', () => {
  it('streams events and resolves with outputs on done', async () => {
    const child = new FakeChild();
    const { client, spawnFn } = clientWith(child);
    const events: GenEvent[] = [];

    const p = client.run(IMAGE_JOB, { onEvent: (e) => events.push(e) });
    await flush();

    // The job envelope was written to stdin and stdin closed.
    expect(child.stdinData).toContain('"id":"job-1"');
    expect(child.stdinEnded).toBe(true);
    // Spawned uv with the worker argv.
    expect(spawnFn).toHaveBeenCalledWith(
      '/usr/bin/uv',
      expect.arrayContaining(['run', 'python']),
      expect.objectContaining({
        env: expect.objectContaining({ UV_PYTHON_DOWNLOADS: 'automatic' }),
      }),
    );

    // Drive a realistic stream, split across chunk boundaries.
    child.emitStdout('{"event":"start","jobId":"job-1","total":4,"candidates":1}\n');
    child.emitStdout('{"event":"progress","jobId":"job-1","candidate":0,"step":1,"tot');
    child.emitStdout('al":4,"previewPath":"/out/steps/s.png"}\n');
    child.emitStdout(
      '{"event":"candidate","jobId":"job-1","index":0,"output":{"outputPath":"/out/o.png","modality":"image","model":"z-image-turbo","seed":42}}\n',
    );
    child.emitStdout(
      '{"event":"done","jobId":"job-1","outputs":[{"outputPath":"/out/o.png","modality":"image","model":"z-image-turbo","seed":42,"width":256,"height":256}]}\n',
    );
    child.emitExit(0);

    const outputs = await p;
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.outputPath).toBe('/out/o.png');
    expect(outputs[0]?.model).toBe('z-image-turbo');
    expect(events.map((e) => e.event)).toEqual(['start', 'progress', 'candidate', 'done']);
  });

  it('parses a trailing done line delivered without a newline before exit', async () => {
    const child = new FakeChild();
    const { client } = clientWith(child);
    const p = client.run(IMAGE_JOB);
    await flush();
    child.emitStdout('{"event":"done","jobId":"job-1","outputs":[]}'); // no newline
    child.emitExit(0);
    await expect(p).resolves.toEqual([]);
  });

  it('rejects with the worker error message on an error event', async () => {
    const child = new FakeChild();
    const { client } = clientWith(child);
    const p = client.run(IMAGE_JOB);
    await flush();
    child.emitStdout(
      '{"event":"error","jobId":"job-1","message":"CUDA not found","recoverable":false}\n',
    );
    child.emitExit(1);
    await expect(p).rejects.toThrow('CUDA not found');
  });

  it('rejects with stderr detail when the worker exits without a terminal event', async () => {
    const child = new FakeChild();
    const { client } = clientWith(child);
    const p = client.run(IMAGE_JOB);
    await flush();
    child.emitStderr('Traceback: boom');
    child.emitExit(1);
    await expect(p).rejects.toThrow(/without a done\/error event.*boom/s);
  });

  it('aborts: SIGKILLs the worker and rejects with GenAbortError', async () => {
    const child = new FakeChild();
    const controller = new AbortController();
    const { client } = clientWith(child);
    const p = client.run(IMAGE_JOB, { signal: controller.signal });
    await flush();
    controller.abort();
    await expect(p).rejects.toBeInstanceOf(GenAbortError);
    expect(child.killed).toBe('SIGKILL');
  });

  it('rejects immediately if the signal is already aborted', async () => {
    const child = new FakeChild();
    const { client, spawnFn } = clientWith(child);
    const controller = new AbortController();
    controller.abort();
    await expect(client.run(IMAGE_JOB, { signal: controller.signal })).rejects.toBeInstanceOf(
      GenAbortError,
    );
    expect(spawnFn).not.toHaveBeenCalled();
  });
});
