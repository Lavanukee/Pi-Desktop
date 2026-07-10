import { describe, expect, it } from 'vitest';
import {
  buildChildSpawnPlan,
  type ChildLike,
  extractExtensionPaths,
  runChildAgent,
  type SpawnLike,
} from './child-agent.js';
import { SUBAGENT_DEPTH_ENV } from './types.js';

/** A scriptable fake child process implementing the structural {@link ChildLike}. */
class FakeChild implements ChildLike {
  readonly pid = 4242;
  readonly stdinData: string[] = [];
  readonly killed: string[] = [];
  #stdout: Array<(c: string) => void> = [];
  #stderr: Array<(c: string) => void> = [];
  #exit: Array<(code: number | null, signal: string | null) => void> = [];
  #error: Array<(err: Error) => void> = [];

  readonly stdin = {
    write: (d: string) => {
      this.stdinData.push(d);
    },
    end: () => {},
  };
  readonly stdout = {
    on: (_e: 'data', cb: (c: string) => void) => {
      this.#stdout.push(cb);
    },
  };
  readonly stderr = {
    on: (_e: 'data', cb: (c: string) => void) => {
      this.#stderr.push(cb);
    },
  };
  on(event: 'exit' | 'error', cb: (...a: never[]) => void): void {
    if (event === 'exit') this.#exit.push(cb as never);
    else this.#error.push(cb as never);
  }
  kill(signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): void {
    this.killed.push(signal);
  }
  // --- test drivers ---
  line(obj: unknown): void {
    for (const cb of this.#stdout) cb(`${JSON.stringify(obj)}\n`);
  }
  stderrText(t: string): void {
    for (const cb of this.#stderr) cb(t);
  }
  exit(code: number | null, signal: string | null): void {
    for (const cb of this.#exit) cb(code, signal);
  }
}

function capturingSpawn(): { spawn: SpawnLike; child: () => FakeChild } {
  let created: FakeChild | undefined;
  const spawn: SpawnLike = () => {
    created = new FakeChild();
    return created;
  };
  return {
    spawn,
    child: () => {
      if (created === undefined) throw new Error('child not spawned');
      return created;
    },
  };
}

describe('extractExtensionPaths', () => {
  it('pulls -e / --extension pairs, ignoring flags', () => {
    const paths = extractExtensionPaths([
      'node',
      'cli.js',
      '--mode',
      'rpc',
      '-e',
      '/a/harness.ts',
      '--extension',
      '/b/provider.ts',
      '-e',
      '--broken',
    ]);
    expect(paths).toEqual(['/a/harness.ts', '/b/provider.ts']);
  });
});

describe('buildChildSpawnPlan', () => {
  it('reuses the parent launcher + extensions, forces a fresh headless session, bumps depth', () => {
    const plan = buildChildSpawnPlan(
      ['node', '/app/cli.js', '--mode', 'rpc', '--session', '/x.jsonl', '-e', '/h.ts'],
      { PATH: '/usr/bin' },
    );
    expect(plan.command).toBe('node');
    expect(plan.args).toEqual([
      '/app/cli.js',
      '--mode',
      'rpc',
      '--no-session',
      '--no-extensions',
      '-e',
      '/h.ts',
    ]);
    expect(plan.env[SUBAGENT_DEPTH_ENV]).toBe('1');
    expect(plan.env.FORCE_COLOR).toBe('0');
    expect(plan.env.NO_COLOR).toBe('1');
  });

  it('increments an inherited depth', () => {
    const plan = buildChildSpawnPlan(['node', 'cli.js'], { [SUBAGENT_DEPTH_ENV]: '1' });
    expect(plan.env[SUBAGENT_DEPTH_ENV]).toBe('2');
  });

  it('applies model/provider overrides', () => {
    const plan = buildChildSpawnPlan(
      ['node', 'cli.js'],
      {},
      { model: 'gemma', provider: 'llamacpp' },
    );
    expect(plan.args).toContain('--model');
    expect(plan.args).toContain('gemma');
    expect(plan.args).toContain('--provider');
    expect(plan.args).toContain('llamacpp');
  });

  it('falls back to PI_BIN when there is no cli entry in argv', () => {
    const plan = buildChildSpawnPlan(['pi'], { PI_BIN: '/opt/mock-pi' });
    expect(plan.command).toBe('/opt/mock-pi');
    expect(plan.args[0]).toBe('--mode');
  });
});

describe('runChildAgent — summary-only contract', () => {
  it('returns ONLY the final assistant turn, never the transcript or tool calls', async () => {
    const { spawn, child } = capturingSpawn();
    const steps: string[] = [];
    const p = runChildAgent({
      goal: 'find the answer',
      timeoutMs: 5000,
      spawn,
      argv: ['node', 'cli.js'],
      env: {},
      onStep: (s) => steps.push(s),
    });
    const c = child();
    // Turn 1: the child narrates + calls a tool (this is transcript — must NOT leak).
    c.line({ type: 'turn_start' });
    c.line({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'Checking the docs.' },
    });
    c.line({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_start',
        contentIndex: 0,
        partial: { content: [{ type: 'toolCall', name: 'read' }] },
      },
    });
    c.line({
      type: 'turn_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Checking the docs.' }] },
    });
    // Turn 2: the final answer — this is the ONLY thing that should return.
    c.line({ type: 'turn_start' });
    c.line({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'The answer is 42.' },
    });
    c.line({
      type: 'turn_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'The answer is 42.' }] },
    });
    c.line({ type: 'agent_end' });

    const res = await p;
    expect(res.ok).toBe(true);
    expect(res.summary).toBe('The answer is 42.');
    // Summary-only: the intermediate turn + tool call must not be present.
    expect(res.summary).not.toContain('Checking the docs');
    expect(res.summary).not.toContain('read');
    expect(res.steps).toBe(1);
    expect(steps).toEqual(['read']); // one live step surfaced from the tool call
    // Teardown ran (SIGTERM issued) so the child never lingers.
    expect(c.killed).toContain('SIGTERM');
  });

  it('handles U+2028 inside a JSON string without splitting the record', async () => {
    const { spawn, child } = capturingSpawn();
    const p = runChildAgent({
      goal: 'x',
      timeoutMs: 5000,
      spawn,
      argv: ['node', 'cli.js'],
      env: {},
    });
    const c = child();
    c.line({ type: 'turn_start' });
    c.line({
      type: 'turn_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'line A line B' }] },
    });
    c.line({ type: 'agent_end' });
    const res = await p;
    expect(res.summary).toBe('line A line B');
  });
});

describe('runChildAgent — failure paths never hang', () => {
  it('surfaces a child crash (exit before agent_end) as a failure', async () => {
    const { spawn, child } = capturingSpawn();
    const p = runChildAgent({
      goal: 'x',
      timeoutMs: 5000,
      spawn,
      argv: ['node', 'cli.js'],
      env: {},
    });
    const c = child();
    c.line({ type: 'turn_start' });
    c.stderrText('Segfault in provider\n');
    c.exit(1, null);
    const res = await p;
    expect(res.ok).toBe(false);
    expect(res.timedOut).toBe(false);
    expect(res.error).toMatch(/exited before completing/);
    expect(res.error).toMatch(/Segfault/);
  });

  it('times out and tears the child down without hanging', async () => {
    const { spawn, child } = capturingSpawn();
    const p = runChildAgent({ goal: 'x', timeoutMs: 20, spawn, argv: ['node', 'cli.js'], env: {} });
    const c = child();
    c.line({ type: 'turn_start' }); // then goes silent forever
    const res = await p;
    expect(res.ok).toBe(false);
    expect(res.timedOut).toBe(true);
    expect(c.killed).toContain('SIGTERM');
  });

  it('resolves (not rejects) on a spawn throw', async () => {
    const spawn: SpawnLike = () => {
      throw new Error('ENOENT');
    };
    const res = await runChildAgent({
      goal: 'x',
      timeoutMs: 5000,
      spawn,
      argv: ['node', 'cli.js'],
      env: {},
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/spawn failed/);
  });

  it('aborts promptly when the parent signal fires', async () => {
    const { spawn, child } = capturingSpawn();
    const ac = new AbortController();
    const p = runChildAgent({
      goal: 'x',
      timeoutMs: 5000,
      spawn,
      argv: ['node', 'cli.js'],
      env: {},
      signal: ac.signal,
    });
    child().line({ type: 'turn_start' });
    ac.abort();
    const res = await p;
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/aborted/);
    expect(child().killed).toContain('SIGTERM');
  });
});
