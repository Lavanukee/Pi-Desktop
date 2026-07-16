import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { startParentDeathWatchdog, WATCHDOG_SCRIPT } from './watchdog.js';

// --- Unit: spawn wiring + stop() semantics (no real processes) --------------

/** Fake stdin capturing writes/end + unref. */
class FakeStdin extends EventEmitter {
  readonly written: string[] = [];
  unrefCount = 0;
  end(chunk?: string): void {
    if (chunk !== undefined) this.written.push(chunk);
    this.emit('finish');
  }
  write(chunk: string): boolean {
    this.written.push(chunk);
    return true;
  }
  unref(): void {
    this.unrefCount += 1;
  }
}

class FakeChild extends EventEmitter {
  readonly stdin = new FakeStdin();
  readonly killed: string[] = [];
  unrefCount = 0;
  constructor(readonly pid = 111) {
    super();
  }
  unref(): void {
    this.unrefCount += 1;
  }
  kill(signal: string = 'SIGTERM'): boolean {
    this.killed.push(signal);
    return true;
  }
}

const asChild = (c: FakeChild): ChildProcess => c as unknown as ChildProcess;

describe('startParentDeathWatchdog (wiring)', () => {
  it('spawns the sidecar detached with the script + target pid and unrefs', () => {
    let captured: { cmd: string; args: string[]; options: Record<string, unknown> } | undefined;
    const child = new FakeChild(999);
    const spawnFn = vi.fn(
      (cmd: string, args: readonly string[], options: Record<string, unknown>) => {
        captured = { cmd, args: [...args], options };
        return asChild(child);
      },
    );

    startParentDeathWatchdog({
      targetPid: 4242,
      spawnFn: spawnFn as unknown as typeof spawn,
    });

    expect(captured?.args[0]).toBe('-e');
    expect(captured?.args[1]).toBe(WATCHDOG_SCRIPT);
    expect(captured?.args[2]).toBe('4242');
    expect(captured?.options.detached).toBe(true);
    expect(captured?.options.stdio).toEqual(['pipe', 'ignore', 'ignore']);
    const env = captured?.options.env as Record<string, string>;
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(child.unrefCount).toBe(1);
    expect(child.stdin.unrefCount).toBe(1);
  });

  it('stop() disarms (writes `disarm`) then SIGKILLs the sidecar, idempotently', () => {
    const child = new FakeChild();
    const spawnFn = vi.fn(() => asChild(child));
    const handle = startParentDeathWatchdog({
      targetPid: 1,
      spawnFn: spawnFn as unknown as typeof spawn,
    });

    handle.stop();
    expect(child.stdin.written.join('')).toContain('disarm');
    expect(child.killed).toContain('SIGKILL');

    handle.stop(); // idempotent — no second kill
    expect(child.killed.filter((s) => s === 'SIGKILL')).toHaveLength(1);
  });

  it('omits ELECTRON_RUN_AS_NODE when runAsNode is false', () => {
    const child = new FakeChild();
    const spawnFn = vi.fn((_c: string, _a: readonly string[], _o: Record<string, unknown>) =>
      asChild(child),
    );
    startParentDeathWatchdog({
      targetPid: 1,
      spawnFn: spawnFn as unknown as typeof spawn,
      runAsNode: false,
      env: { PATH: '/x' },
    });
    const options = spawnFn.mock.calls[0]?.[2] as Record<string, unknown>;
    const env = options.env as Record<string, string>;
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });
});

// --- Integration: run the REAL sidecar against a REAL orphaned child ---------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true;
    await sleep(25);
  }
  return cond();
}

/** A long-lived stand-in for llama-server we must never leak. */
function spawnVictim(): ChildProcess {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' });
}

/** The real sidecar with its stdin wired to a pipe WE hold (playing "the parent"). */
function spawnWatchdogProc(targetPid: number): ChildProcess {
  return spawn(process.execPath, ['-e', WATCHDOG_SCRIPT, String(targetPid)], {
    detached: true,
    stdio: ['pipe', 'ignore', 'ignore'],
  });
}

describe('WATCHDOG_SCRIPT (end-to-end)', () => {
  it('SIGKILLs the tracked child when its parent dies (stdin pipe EOF)', async () => {
    const victim = spawnVictim();
    const vpid = victim.pid;
    expect(vpid).toBeGreaterThan(0);
    const wd = spawnWatchdogProc(vpid ?? -1);
    try {
      await sleep(250); // let both processes come up
      expect(alive(vpid ?? -1)).toBe(true);
      // Simulate hard parent death: close the pipe WITHOUT disarming → the
      // sidecar reads EOF and must reap the orphan.
      wd.stdin?.end();
      const died = await waitUntil(() => !alive(vpid ?? -1), 8000);
      expect(died).toBe(true);
    } finally {
      try {
        victim.kill('SIGKILL');
      } catch {
        /* already reaped */
      }
      try {
        wd.kill('SIGKILL');
      } catch {
        /* already exited */
      }
    }
  }, 15_000);

  it('does NOT kill the tracked child after `disarm` (graceful teardown)', async () => {
    const victim = spawnVictim();
    const vpid = victim.pid ?? -1;
    const wd = spawnWatchdogProc(vpid);
    try {
      await sleep(250);
      wd.stdin?.end('disarm\n'); // stand down → the sidecar exits without killing
      await sleep(900); // give it every chance to (wrongly) reap
      expect(alive(vpid)).toBe(true);
    } finally {
      try {
        victim.kill('SIGKILL');
      } catch {
        /* already reaped */
      }
      try {
        wd.kill('SIGKILL');
      } catch {
        /* already exited */
      }
    }
  }, 15_000);
});
