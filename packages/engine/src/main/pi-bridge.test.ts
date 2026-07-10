import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PiBridgeEvent } from '../types/rpc';
import { PiBridge, type PiChildProcess, type PiSpawnFn, PiTimeoutError } from './pi-bridge';

/** Minimal scriptable stand-in for the pi child process. */
class FakeChild implements PiChildProcess {
  pid: number | undefined = 4242;
  written: string[] = [];
  writeCallbacks: Array<((err?: Error | null) => void) | undefined> = [];
  stdinEnded = false;
  kills: string[] = [];
  private stdoutCb: ((chunk: string) => void) | null = null;
  private stderrCb: ((chunk: string) => void) | null = null;
  private stdinErrorCb: ((err: Error) => void) | null = null;
  private errorCb: ((err: Error) => void) | null = null;
  private exitCb: ((code: number | null, signal: string | null) => void) | null = null;
  private closeCb: ((code: number | null, signal: string | null) => void) | null = null;

  stdin = {
    write: (data: string, cb?: (err?: Error | null) => void): void => {
      if (this.stdinEnded) throw new Error('write after end');
      this.written.push(data);
      this.writeCallbacks.push(cb);
    },
    end: (): void => {
      this.stdinEnded = true;
    },
    on: (_event: 'error', cb: (err: Error) => void): void => {
      this.stdinErrorCb = cb;
    },
  };
  stdout = {
    setEncoding: (): void => {},
    on: (_event: 'data', cb: (chunk: string) => void): void => {
      this.stdoutCb = cb;
    },
  };
  stderr = {
    setEncoding: (): void => {},
    on: (_event: 'data', cb: (chunk: string) => void): void => {
      this.stderrCb = cb;
    },
  };

  on(event: 'error', cb: (err: Error) => void): void;
  on(event: 'exit', cb: (code: number | null, signal: string | null) => void): void;
  on(event: 'close', cb: (code: number | null, signal: string | null) => void): void;
  on(event: string, cb: unknown): void {
    if (event === 'error') this.errorCb = cb as (err: Error) => void;
    if (event === 'exit') this.exitCb = cb as (code: number | null, signal: string | null) => void;
    if (event === 'close') {
      this.closeCb = cb as (code: number | null, signal: string | null) => void;
    }
  }

  kill(signal?: 'SIGTERM' | 'SIGKILL'): void {
    this.kills.push(signal ?? 'SIGTERM');
  }

  emitStdout(chunk: string): void {
    this.stdoutCb?.(chunk);
  }
  emitStderr(chunk: string): void {
    this.stderrCb?.(chunk);
  }
  emitStdinError(err: Error): void {
    if (this.stdinErrorCb === null) throw err; // mirrors Node: unhandled stream error throws
    this.stdinErrorCb(err);
  }
  emitError(err: Error): void {
    this.errorCb?.(err);
  }
  emitExit(code: number | null, signal: string | null): void {
    this.exitCb?.(code, signal);
  }
  emitClose(code: number | null, signal: string | null): void {
    this.closeCb?.(code, signal);
  }
  /** Deliver an async write failure to the callback of written[index]. */
  failWrite(index: number, err: Error): void {
    this.writeCallbacks[index]?.(err);
  }

  /** Last written command, parsed. */
  lastCommand(): Record<string, unknown> {
    const line = this.written[this.written.length - 1];
    if (line === undefined) throw new Error('nothing written');
    return JSON.parse(line) as Record<string, unknown>;
  }
}

interface Setup {
  child: FakeChild;
  bridge: PiBridge;
  events: PiBridgeEvent[];
  spawnCalls: Array<{ command: string; args: string[]; env: Record<string, string | undefined> }>;
}

function setup(opts: Partial<ConstructorParameters<typeof PiBridge>[0]> = {}): Setup {
  const child = new FakeChild();
  const spawnCalls: Setup['spawnCalls'] = [];
  const spawnFn: PiSpawnFn = (command, args, options) => {
    spawnCalls.push({ command, args, env: options.env });
    return child;
  };
  const events: PiBridgeEvent[] = [];
  const bridge = new PiBridge(
    {
      cwd: process.cwd(),
      binPath: '/fake/pi',
      readyProbe: false,
      env: {},
      spawnFn,
      ...opts,
    },
    (e) => events.push(e),
  );
  return { child, bridge, events, spawnCalls };
}

describe('PiBridge send / id correlation', () => {
  it('renames `command` to `type` on the wire (the load-bearing quirk)', async () => {
    const { child, bridge } = setup();
    const promise = bridge.send({ command: 'prompt', message: 'hi' });
    const written = child.lastCommand();
    expect(written.type).toBe('prompt');
    expect(written).not.toHaveProperty('command');
    expect(typeof written.id).toBe('string');
    child.emitStdout(
      `${JSON.stringify({ type: 'response', command: 'prompt', success: true, id: written.id })}\n`,
    );
    await expect(promise).resolves.toMatchObject({ command: 'prompt', success: true });
  });

  it('keeps the bash payload `command` field intact when `type` is present', async () => {
    const { child, bridge } = setup();
    const promise = bridge.send({ type: 'bash', command: 'ls -la', id: 'fixed-id' });
    // The command→type rename must not strip a legitimate payload field: this
    // is the shell command itself, not the ergonomic command-name spelling.
    expect(child.lastCommand()).toEqual({ type: 'bash', command: 'ls -la', id: 'fixed-id' });
    child.emitStdout(
      `${JSON.stringify({ type: 'response', command: 'bash', success: true, id: 'fixed-id', data: { output: '', exitCode: 0, cancelled: false, truncated: false } })}\n`,
    );
    await expect(promise).resolves.toMatchObject({ command: 'bash', success: true });
  });

  it('bash() wrapper sends the spec-correct payload', () => {
    const { child, bridge } = setup();
    void bridge.bash('echo hi').catch(() => {});
    expect(child.lastCommand()).toMatchObject({ type: 'bash', command: 'echo hi' });
  });

  it('keeps an explicit `type` as-is and preserves a caller-provided id', async () => {
    const { child, bridge } = setup();
    const promise = bridge.send({ type: 'get_state', id: 'my-id' });
    expect(child.lastCommand()).toMatchObject({ type: 'get_state', id: 'my-id' });
    child.emitStdout(
      `${JSON.stringify({ type: 'response', command: 'get_state', success: true, id: 'my-id', data: {} })}\n`,
    );
    await expect(promise).resolves.toMatchObject({ command: 'get_state' });
  });

  it('correlates out-of-order responses to the right pending promises', async () => {
    const { child, bridge } = setup();
    const first = bridge.send({ type: 'get_state', id: 'a' });
    const second = bridge.send({ type: 'get_messages', id: 'b' });
    child.emitStdout(
      `${JSON.stringify({ type: 'response', command: 'get_messages', success: true, id: 'b', data: { messages: [] } })}\n`,
    );
    child.emitStdout(
      `${JSON.stringify({ type: 'response', command: 'get_state', success: true, id: 'a', data: {} })}\n`,
    );
    await expect(second).resolves.toMatchObject({ command: 'get_messages' });
    await expect(first).resolves.toMatchObject({ command: 'get_state' });
  });

  it('rejects on {success:false} with the error message', async () => {
    const { child, bridge } = setup();
    const promise = bridge.send({ type: 'set_model', id: 'x', provider: 'p', modelId: 'm' });
    child.emitStdout(
      `${JSON.stringify({ type: 'response', command: 'set_model', success: false, id: 'x', error: 'Model not found: p/m' })}\n`,
    );
    await expect(promise).rejects.toThrow('Model not found: p/m');
  });

  it('forwards orphan responses (unknown id) as events without throwing', () => {
    const { child, events } = setup();
    child.emitStdout(
      `${JSON.stringify({ type: 'response', command: 'prompt', success: true, id: 'ghost' })}\n`,
    );
    expect(events).toContainEqual(expect.objectContaining({ type: 'response', id: 'ghost' }));
  });

  it('also emits matched responses as events (listeners can observe)', async () => {
    const { child, bridge, events } = setup();
    const promise = bridge.send({ type: 'abort', id: 'z' });
    child.emitStdout(
      `${JSON.stringify({ type: 'response', command: 'abort', success: true, id: 'z' })}\n`,
    );
    await promise;
    expect(events).toContainEqual(expect.objectContaining({ type: 'response', id: 'z' }));
  });

  it('rejects all pending commands when the child exits', async () => {
    const { child, bridge } = setup();
    const pending = bridge.send({ type: 'prompt', message: 'hi' });
    child.emitExit(1, null);
    await expect(pending).rejects.toThrow('pi exited (1)');
    await expect(bridge.send({ type: 'abort' })).rejects.toThrow('pi process has exited');
    expect(bridge.alive).toBe(false);
  });

  it('reassembles responses split across chunks, including U+2028 payloads', async () => {
    const { child, bridge } = setup();
    const promise = bridge.send({ type: 'get_last_assistant_text', id: 'u' });
    const line = `${JSON.stringify({
      type: 'response',
      command: 'get_last_assistant_text',
      success: true,
      id: 'u',
      data: { text: 'a\u2028b' },
    })}\n`;
    child.emitStdout(line.slice(0, 25));
    child.emitStdout(line.slice(25));
    const res = (await promise) as { data: { text: string } };
    expect(res.data.text).toBe('a\u2028b');
  });
});

describe('PiBridge id-less error responses (pi 0.68.1 drops the id on unknown commands)', () => {
  it('rejects the single pending send whose type matches the echoed command', async () => {
    const { child, bridge } = setup();
    const promise = bridge.send({ type: 'some_future_command' });
    child.emitStdout(
      `${JSON.stringify({ type: 'response', command: 'some_future_command', success: false, error: 'Unknown command: some_future_command' })}\n`,
    );
    await expect(promise).rejects.toThrow('Unknown command: some_future_command');
  });

  it('leaves 2+ same-type pendings untouched (ambiguous) and id correlation still works', async () => {
    const { child, bridge } = setup();
    const first = bridge.send({ type: 'get_state', id: 'a' });
    const second = bridge.send({ type: 'get_state', id: 'b' });
    child.emitStdout(
      `${JSON.stringify({ type: 'response', command: 'get_state', success: false, error: 'nope' })}\n`,
    );
    // Ambiguous: neither may be guessed-rejected; both settle by id later.
    child.emitStdout(
      `${JSON.stringify({ type: 'response', command: 'get_state', success: true, id: 'a', data: {} })}\n`,
    );
    child.emitStdout(
      `${JSON.stringify({ type: 'response', command: 'get_state', success: true, id: 'b', data: {} })}\n`,
    );
    await expect(first).resolves.toMatchObject({ id: 'a' });
    await expect(second).resolves.toMatchObject({ id: 'b' });
  });

  it('id-less parse errors (command:"parse") match no pending and flow through as events', async () => {
    const { child, bridge, events } = setup();
    const inflight = bridge.send({ type: 'get_state', id: 'x' });
    child.emitStdout(
      `${JSON.stringify({ type: 'response', command: 'parse', success: false, error: 'Failed to parse command' })}\n`,
    );
    expect(events).toContainEqual(expect.objectContaining({ command: 'parse' }));
    child.emitStdout(
      `${JSON.stringify({ type: 'response', command: 'get_state', success: true, id: 'x', data: {} })}\n`,
    );
    await expect(inflight).resolves.toMatchObject({ command: 'get_state' });
  });
});

describe('PiBridge opt-in send timeout', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('rejects with PiTimeoutError when no response arrives in time', async () => {
    const { child, bridge, events } = setup();
    const promise = bridge.send({ type: 'get_state', id: 't1' }, { timeoutMs: 100 });
    // Attach the handler before the timer fires (no unhandled rejection).
    const rejection = expect(promise).rejects.toBeInstanceOf(PiTimeoutError);
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    // The pending entry is gone: a late response is a plain orphan event.
    child.emitStdout(
      `${JSON.stringify({ type: 'response', command: 'get_state', success: true, id: 't1', data: {} })}\n`,
    );
    expect(events).toContainEqual(expect.objectContaining({ type: 'response', id: 't1' }));
  });

  it('does not fire after the response arrived', async () => {
    const { child, bridge } = setup();
    const promise = bridge.send({ type: 'get_state', id: 't2' }, { timeoutMs: 100 });
    child.emitStdout(
      `${JSON.stringify({ type: 'response', command: 'get_state', success: true, id: 't2', data: {} })}\n`,
    );
    await expect(promise).resolves.toMatchObject({ command: 'get_state' });
    // Advancing past the deadline must not produce an unhandled rejection.
    await vi.advanceTimersByTimeAsync(1000);
  });

  it('sends without timeoutMs never time out', async () => {
    const { bridge } = setup();
    let settled = false;
    void bridge.send({ type: 'prompt', message: 'hi' }).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(settled).toBe(false);
  });
});

describe('PiBridge garbage stdout lines', () => {
  it('routes JSON primitives/arrays/typeless objects to _unparsed without throwing', () => {
    const { child, events } = setup();
    // JSON.parse succeeds for all of these; `null` used to crash the process.
    for (const line of ['null', '42', '"x"', '[]', 'true', '{"noType":1}']) {
      expect(() => child.emitStdout(`${line}\n`)).not.toThrow();
      expect(events).toContainEqual({ type: '_unparsed', text: line });
    }
  });

  it('does not treat primitive JSON lines as protocol readiness', async () => {
    vi.useFakeTimers();
    try {
      const { child, bridge } = setup({ readyTimeoutMs: 60_000 });
      let ready = false;
      void bridge.ready().then(() => {
        ready = true;
      });
      child.emitStdout('null\n');
      await vi.advanceTimersByTimeAsync(0);
      expect(ready).toBe(false);
      child.emitStdout('{"type":"agent_start"}\n');
      await vi.advanceTimersByTimeAsync(0);
      expect(ready).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('PiBridge stream handling', () => {
  it('passes through non-JSON lines as _unparsed and stderr as _stderr', () => {
    const { child, events } = setup();
    child.emitStdout('pi booting banner\n');
    child.emitStderr('warning: something\n');
    expect(events).toContainEqual({ type: '_unparsed', text: 'pi booting banner' });
    expect(events).toContainEqual({ type: '_stderr', text: 'warning: something\n' });
  });

  it('forwards agent events verbatim', () => {
    const { child, events } = setup();
    child.emitStdout('{"type":"agent_start"}\n{"type":"turn_start"}\n');
    expect(events).toContainEqual({ type: 'agent_start' });
    expect(events).toContainEqual({ type: 'turn_start' });
  });
});

describe('PiBridge stdin failure handling', () => {
  it('absorbs async stdin stream errors as _bridge_error instead of crashing', () => {
    const { child, events } = setup();
    // Without the bridge's stdin 'error' listener this throws (in real Node:
    // uncaughtException in the Electron main process).
    expect(() => child.emitStdinError(new Error('write EPIPE'))).not.toThrow();
    expect(events).toContainEqual({ type: '_bridge_error', error: 'stdin: Error: write EPIPE' });
  });

  it('rejects only the send whose stdin write fails asynchronously', async () => {
    const { child, bridge } = setup();
    const doomed = bridge.send({ type: 'prompt', message: 'hi', id: 'doomed' });
    const survivor = bridge.send({ type: 'get_state', id: 'ok' });
    child.failWrite(0, new Error('write EPIPE'));
    await expect(doomed).rejects.toThrow('write EPIPE');
    child.emitStdout(
      `${JSON.stringify({ type: 'response', command: 'get_state', success: true, id: 'ok', data: {} })}\n`,
    );
    await expect(survivor).resolves.toMatchObject({ command: 'get_state' });
  });
});

describe('PiBridge spawn failure settlement', () => {
  it('settles the bridge on spawn failure (error fires, exit never does)', async () => {
    const { child, bridge, events } = setup();
    const inflight = bridge.send({ type: 'get_state', id: 'q' });
    child.pid = undefined; // Node never assigns a pid when spawn fails
    child.emitError(new Error('spawn pi ENOENT'));
    await expect(inflight).rejects.toThrow('pi failed to spawn: Error: spawn pi ENOENT');
    expect(bridge.alive).toBe(false);
    await expect(bridge.whenExited()).resolves.toBeUndefined();
    await expect(bridge.send({ type: 'abort' })).rejects.toThrow('pi process has exited');
    expect(events).toContainEqual({ type: '_bridge_error', error: 'Error: spawn pi ENOENT' });
  });

  it('keeps a post-spawn runtime error non-terminal', () => {
    const { child, bridge } = setup();
    child.emitError(new Error('EPERM'));
    expect(bridge.alive).toBe(true);
  });

  it("settles via 'close' when 'exit' never fires, exactly once", async () => {
    const { child, bridge, events } = setup();
    const inflight = bridge.send({ type: 'get_state', id: 'q' });
    child.emitClose(1, null);
    await expect(inflight).rejects.toThrow('pi exited (1)');
    expect(bridge.alive).toBe(false);
    child.emitExit(1, null); // late 'exit' after 'close' must not double-emit
    expect(events.filter((e) => e.type === '_bridge_exit')).toHaveLength(1);
  });
});

describe('PiBridge whenExited', () => {
  it('resolves once the child exits, and immediately thereafter', async () => {
    const { child, bridge } = setup();
    let settled = false;
    const wait = bridge.whenExited().then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    child.emitExit(0, null);
    await wait;
    expect(settled).toBe(true);
    await expect(bridge.whenExited()).resolves.toBeUndefined();
  });
});

describe('PiBridge readiness', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('resolves ready() on the first parsed line, not on unparsed banners', async () => {
    const { child, bridge } = setup({ readyTimeoutMs: 60_000 });
    let ready = false;
    void bridge.ready().then(() => {
      ready = true;
    });
    child.emitStdout('some banner\n');
    await vi.advanceTimersByTimeAsync(0);
    expect(ready).toBe(false);
    child.emitStdout('{"type":"agent_start"}\n');
    await vi.advanceTimersByTimeAsync(0);
    expect(ready).toBe(true);
  });

  it('falls back to the configurable timeout when nothing arrives', async () => {
    const { bridge } = setup({ readyTimeoutMs: 5000 });
    let ready = false;
    void bridge.ready().then(() => {
      ready = true;
    });
    await vi.advanceTimersByTimeAsync(4999);
    expect(ready).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(ready).toBe(true);
  });

  it('settles ready() when the spawn fails outright', async () => {
    const { child, bridge } = setup({ readyTimeoutMs: 60_000 });
    let ready = false;
    void bridge.ready().then(() => {
      ready = true;
    });
    child.emitError(new Error('spawn ENOENT'));
    await vi.advanceTimersByTimeAsync(0);
    expect(ready).toBe(true);
  });

  it('sends a get_state readiness probe by default', () => {
    const { child } = setup({ readyProbe: undefined });
    expect(child.lastCommand()).toMatchObject({ type: 'get_state' });
  });
});

describe('PiBridge extension UI dialog gating', () => {
  it('answers tracked dialog ids exactly once', () => {
    const { child, bridge } = setup();
    child.emitStdout(
      `${JSON.stringify({ type: 'extension_ui_request', id: 'd1', method: 'confirm', title: 't', message: 'm' })}\n`,
    );
    expect(bridge.respondUi('d1', { confirmed: true })).toBe(true);
    expect(JSON.parse(child.written[child.written.length - 1] ?? '')).toEqual({
      type: 'extension_ui_response',
      id: 'd1',
      confirmed: true,
    });
    // Second answer for the same id is dropped.
    expect(bridge.respondUi('d1', { confirmed: false })).toBe(false);
  });

  it('prunes timed dialogs after expiry so respondUi no-ops for ids pi already resolved', () => {
    vi.useFakeTimers();
    try {
      const { child, bridge } = setup();
      child.emitStdout(
        `${JSON.stringify({ type: 'extension_ui_request', id: 'd-timed', method: 'confirm', title: 't', message: 'm', timeout: 1000 })}\n`,
      );
      // pi auto-resolves at 1000ms and emits nothing; past that (plus grace),
      // answering would write a response pi silently ignores.
      vi.advanceTimersByTime(1500);
      expect(bridge.respondUi('d-timed', { confirmed: true })).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps untimed dialogs answerable indefinitely', () => {
    vi.useFakeTimers();
    try {
      const { child, bridge } = setup();
      child.emitStdout(
        `${JSON.stringify({ type: 'extension_ui_request', id: 'd-open', method: 'editor', title: 't' })}\n`,
      );
      vi.advanceTimersByTime(600_000);
      expect(bridge.respondUi('d-open', { value: 'text' })).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses to answer fire-and-forget requests and unknown ids', () => {
    const { child, bridge } = setup();
    child.emitStdout(
      `${JSON.stringify({ type: 'extension_ui_request', id: 'n1', method: 'notify', message: 'hello' })}\n`,
    );
    const writesBefore = child.written.length;
    expect(bridge.respondUi('n1', { confirmed: true })).toBe(false);
    expect(bridge.respondUi('nope', { cancelled: true })).toBe(false);
    expect(child.written.length).toBe(writesBefore);
  });
});

describe('PiBridge dispose kill ladder', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('ends stdin, SIGTERMs, then SIGKILLs after the grace period', () => {
    const { child, bridge } = setup({ killGraceMs: 1500 });
    bridge.dispose();
    expect(child.stdinEnded).toBe(true);
    expect(child.kills).toEqual(['SIGTERM']);
    vi.advanceTimersByTime(1500);
    expect(child.kills).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('skips the SIGKILL when the child exits within the grace period', () => {
    const { child, bridge } = setup({ killGraceMs: 1500 });
    bridge.dispose();
    child.emitExit(0, 'SIGTERM');
    vi.advanceTimersByTime(5000);
    expect(child.kills).toEqual(['SIGTERM']);
  });

  it('killNow SIGKILLs immediately and cancels the pending grace timer', () => {
    const { child, bridge } = setup({ killGraceMs: 1500 });
    bridge.dispose();
    expect(child.kills).toEqual(['SIGTERM']);
    bridge.killNow();
    expect(child.kills).toEqual(['SIGTERM', 'SIGKILL']);
    vi.advanceTimersByTime(10_000);
    // The grace timer was cleared; no duplicate SIGKILL.
    expect(child.kills).toEqual(['SIGTERM', 'SIGKILL']);
  });
});

describe('PiBridge spawn arguments', () => {
  it('passes --mode rpc, session/provider/model flags, repeated -e paths, and color env', () => {
    const { spawnCalls } = setup({
      provider: 'llamacpp',
      model: 'qwen3.6-27b',
      sessionPath: '/tmp/s.jsonl',
      noSession: false,
      extensionPaths: ['/ext/a.ts', '/ext/b.ts'],
      extraArgs: ['--no-extensions'],
    });
    const call = spawnCalls[0];
    expect(call).toBeDefined();
    expect(call?.command).toBe('/fake/pi');
    expect(call?.args).toEqual([
      '--mode',
      'rpc',
      '--provider',
      'llamacpp',
      '--model',
      'qwen3.6-27b',
      '--session',
      '/tmp/s.jsonl',
      '-e',
      '/ext/a.ts',
      '-e',
      '/ext/b.ts',
      '--no-extensions',
    ]);
    expect(call?.env.FORCE_COLOR).toBe('0');
    expect(call?.env.NO_COLOR).toBe('1');
  });

  it('spawns the bundled cli via injected execPath with ELECTRON_RUN_AS_NODE', () => {
    const { spawnCalls } = setup({
      binPath: undefined,
      appRoot: '/fake/app',
      execPath: '/fake/electron',
      isElectron: true,
      locateBundledCli: () => '/fake/app/nm/pi/dist/cli.js',
    });
    const call = spawnCalls[0];
    expect(call?.command).toBe('/fake/electron');
    expect(call?.args.slice(0, 3)).toEqual(['/fake/app/nm/pi/dist/cli.js', '--mode', 'rpc']);
    expect(call?.env.ELECTRON_RUN_AS_NODE).toBe('1');
  });
});
