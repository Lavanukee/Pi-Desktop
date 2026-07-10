import { describe, expect, it } from 'vitest';
import { spawnCapture } from './python.js';

const NODE = process.execPath;

describe('spawnCapture', () => {
  it('captures stdout and a normal exit code', async () => {
    const r = await spawnCapture(NODE, ['-e', "process.stdout.write('hello')"], {
      timeoutMs: 5000,
      maxOutputBytes: 10_000,
    });
    expect(r.stdout).toBe('hello');
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(r.stdoutTruncated).toBe(false);
  });

  it('captures a non-zero exit code and stderr', async () => {
    const r = await spawnCapture(NODE, ['-e', "process.stderr.write('boom'); process.exit(3)"], {
      timeoutMs: 5000,
      maxOutputBytes: 10_000,
    });
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toBe('boom');
  });

  it('feeds stdin input to the child', async () => {
    const script =
      "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>process.stdout.write(s.toUpperCase()))";
    const r = await spawnCapture(NODE, ['-e', script], {
      input: 'abc',
      timeoutMs: 5000,
      maxOutputBytes: 10_000,
    });
    expect(r.stdout).toBe('ABC');
    expect(r.exitCode).toBe(0);
  });

  it('kills a runaway process on timeout', async () => {
    const start = Date.now();
    const r = await spawnCapture(NODE, ['-e', 'setInterval(() => {}, 1000)'], {
      timeoutMs: 200,
      maxOutputBytes: 10_000,
    });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBeNull();
    expect(r.signal).toBe('SIGKILL');
    expect(Date.now() - start).toBeLessThan(5000);
  });

  it('caps output at maxOutputBytes and flags truncation', async () => {
    const r = await spawnCapture(NODE, ['-e', "process.stdout.write('x'.repeat(100000))"], {
      timeoutMs: 5000,
      maxOutputBytes: 1000,
    });
    expect(r.stdout.length).toBe(1000);
    expect(r.stdoutTruncated).toBe(true);
    expect(r.exitCode).toBe(0);
  });

  it('kills the process when the abort signal fires', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const r = await spawnCapture(NODE, ['-e', 'setInterval(() => {}, 1000)'], {
      timeoutMs: 5000,
      maxOutputBytes: 10_000,
      signal: controller.signal,
    });
    expect(r.aborted).toBe(true);
    expect(r.exitCode).toBeNull();
  });

  it('rejects when the command cannot be spawned', async () => {
    await expect(
      spawnCapture('definitely-not-a-real-binary-xyz', [], {
        timeoutMs: 1000,
        maxOutputBytes: 100,
      }),
    ).rejects.toThrow();
  });
});
