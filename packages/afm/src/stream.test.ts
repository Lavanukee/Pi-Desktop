import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { AfmAbortError, AfmError } from './errors.js';
import { type AfmChildProcess, type AfmSpawnFn, defaultSpawn } from './spawn.js';
import { streamAfm } from './stream.js';

const FIXTURE = fileURLToPath(new URL('./__fixtures__/fake-afm.mjs', import.meta.url));

/** Controllable structural fake child. */
class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdinChunks: string[] = [];
  readonly killed: string[] = [];
  readonly stdin = {
    write: (data: string, cb?: (err?: Error | null) => void): void => {
      this.stdinChunks.push(data);
      cb?.(null);
    },
    end: (): void => {},
    on: (): void => {},
  };
  readonly pid = 4321;
  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    this.killed.push(signal);
  }
  pushLine(obj: unknown): void {
    this.stdout.emit('data', `${JSON.stringify(obj)}\n`);
  }
  pushRaw(text: string): void {
    this.stdout.emit('data', text);
  }
  close(code: number | null = 0): void {
    this.emit('close', code, null);
  }
}

/** Wire streamAfm to a FakeChild and hand the child back to the test. */
function withFake(): { child: FakeChild; spawnFn: AfmSpawnFn } {
  const child = new FakeChild();
  const spawnFn: AfmSpawnFn = () => child as unknown as AfmChildProcess;
  return { child, spawnFn };
}

/** Spawn the real Node fixture, standing in for the compiled binary. */
const fixtureSpawn: AfmSpawnFn = (_bin, args) => defaultSpawn(process.execPath, [FIXTURE, ...args]);

describe('streamAfm (structural fake)', () => {
  it('accumulates deltas, fires onDelta, and resolves on done', async () => {
    const { child, spawnFn } = withFake();
    const onDelta = vi.fn();
    const promise = streamAfm({ prompt: 'hi' }, { spawnFn, onDelta });

    child.pushLine({ type: 'delta', text: 'Hello' });
    child.pushLine({ type: 'delta', text: ', world' });
    child.pushLine({ type: 'done' });

    const result = await promise;
    expect(result.text).toBe('Hello, world');
    expect(onDelta.mock.calls).toEqual([['Hello'], [', world']]);
  });

  it('writes the JSON request to stdin', async () => {
    const { child, spawnFn } = withFake();
    const promise = streamAfm(
      { prompt: 'hi', instructions: 'be nice', temperature: 0.5 },
      { spawnFn },
    );
    child.pushLine({ type: 'done' });
    await promise;
    expect(JSON.parse(child.stdinChunks.join(''))).toEqual({
      prompt: 'hi',
      instructions: 'be nice',
      temperature: 0.5,
    });
  });

  it('reassembles deltas split across data-chunk boundaries', async () => {
    const { child, spawnFn } = withFake();
    const promise = streamAfm({ prompt: 'hi' }, { spawnFn });
    // A single NDJSON line arrives in three fragments across two lines.
    child.pushRaw('{"type":"delta","text":"foo"}\n{"type":"del');
    child.pushRaw('ta","text":"bar"}\n{"type":"do');
    child.pushRaw('ne"}\n');
    const result = await promise;
    expect(result.text).toBe('foobar');
  });

  it('surfaces the usage block on done', async () => {
    const { child, spawnFn } = withFake();
    const promise = streamAfm({ prompt: 'hi' }, { spawnFn });
    child.pushLine({ type: 'done', usage: { inputTokens: 10, outputTokens: 3 } });
    const result = await promise;
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 3 });
  });

  it('rejects with a recoverable AfmError on an error line', async () => {
    const { child, spawnFn } = withFake();
    const promise = streamAfm({ prompt: 'hi' }, { spawnFn });
    child.pushLine({ type: 'error', message: 'Context window exceeded.', recoverable: true });
    await expect(promise).rejects.toMatchObject({
      name: 'AfmError',
      message: 'Context window exceeded.',
      recoverable: true,
    });
    expect(promise.catch(() => {})).toBeDefined();
  });

  it('rejects when the child closes without a terminal line', async () => {
    const { child, spawnFn } = withFake();
    const promise = streamAfm({ prompt: 'hi' }, { spawnFn });
    child.pushLine({ type: 'delta', text: 'partial' });
    child.stderr.emit('data', 'kaboom');
    child.close(3);
    const err = await promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AfmError);
    expect((err as AfmError).message).toContain('code 3');
    expect((err as AfmError).message).toContain('kaboom');
  });

  it('kills the child and rejects with AfmAbortError on abort', async () => {
    const { child, spawnFn } = withFake();
    const controller = new AbortController();
    const promise = streamAfm({ prompt: 'hi' }, { spawnFn, signal: controller.signal });
    child.pushLine({ type: 'delta', text: 'partial' });
    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(AfmAbortError);
    expect(child.killed).toContain('SIGKILL');
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const { spawnFn } = withFake();
    const controller = new AbortController();
    controller.abort();
    await expect(
      streamAfm({ prompt: 'hi' }, { spawnFn, signal: controller.signal }),
    ).rejects.toBeInstanceOf(AfmAbortError);
  });
});

describe('streamAfm (real spawned fixture)', () => {
  it('streams a real prompt back word-by-word', async () => {
    const onDelta = vi.fn();
    const result = await streamAfm(
      { prompt: 'hello world foo' },
      { spawnFn: fixtureSpawn, onDelta },
    );
    expect(result.text).toBe('hello world foo');
    expect(onDelta.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('rejects with a recoverable AfmError when the fixture emits error', async () => {
    await expect(streamAfm({ prompt: 'ERROR' }, { spawnFn: fixtureSpawn })).rejects.toMatchObject({
      name: 'AfmError',
      recoverable: true,
    });
  });

  it('rejects when the fixture crashes without a terminal line', async () => {
    const err = await streamAfm({ prompt: 'CRASH' }, { spawnFn: fixtureSpawn }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AfmError);
    expect((err as AfmError).message).toContain('boom');
  });

  it('aborts a hanging real child', async () => {
    const controller = new AbortController();
    const promise = streamAfm(
      { prompt: 'HANG' },
      { spawnFn: fixtureSpawn, signal: controller.signal },
    );
    // Attach the rejection expectation BEFORE aborting so there's no window in
    // which the rejection is unhandled.
    const expectation = expect(promise).rejects.toBeInstanceOf(AfmAbortError);
    // Give the child time to start and emit its first delta before aborting.
    await new Promise((r) => setTimeout(r, 200));
    controller.abort();
    await expectation;
  });
});
