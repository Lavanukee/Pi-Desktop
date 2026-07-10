/**
 * A tiny bounded process runner — the single low-level primitive every connector
 * ultimately shells out through (`osascript`, `sqlite3`).
 *
 * It is deliberately a self-contained copy rather than a dependency on
 * web-tools' `spawnCapture`: mac-connectors stays a leaf package with no
 * cross-tool coupling, in keeping with the low-weight-CLI philosophy. The
 * contract is the same — a hard timeout (SIGKILL, process-group-wide on POSIX so
 * a wedged `osascript` can't orphan children), per-stream output byte caps, and
 * external-abort support — so failures are always bounded and never hang the
 * agent loop.
 */
import { spawn as nodeSpawn } from 'node:child_process';

export interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  /** Exit code, or null if the process was terminated by a signal. */
  readonly exitCode: number | null;
  /** Terminating signal name, or null on a normal exit. */
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly durationMs: number;
}

export interface SpawnCaptureOptions {
  /** Written to stdin then closed, when provided. */
  readonly input?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  /** Per-stream cap; excess is dropped and the corresponding truncated flag set. */
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
}

class CappedBuffer {
  private readonly chunks: Buffer[] = [];
  private len = 0;
  truncated = false;
  constructor(private readonly max: number) {}
  push(chunk: Buffer): void {
    if (this.len >= this.max) {
      this.truncated = true;
      return;
    }
    const remaining = this.max - this.len;
    if (chunk.length > remaining) {
      this.chunks.push(chunk.subarray(0, remaining));
      this.len = this.max;
      this.truncated = true;
    } else {
      this.chunks.push(chunk);
      this.len += chunk.length;
    }
  }
  toString(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

/** Spawn a command and capture output under timeout / size / abort bounds. */
export async function spawnCapture(
  command: string,
  args: readonly string[],
  opts: SpawnCaptureOptions,
): Promise<ProcessResult> {
  const start = Date.now();
  // On POSIX, run in a new process group so SIGKILL reaches the whole tree on
  // timeout. Windows (never a target here) has no process groups.
  const detached = process.platform !== 'win32';
  const child = nodeSpawn(command, [...args], {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    detached,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const stdout = new CappedBuffer(opts.maxOutputBytes);
  const stderr = new CappedBuffer(opts.maxOutputBytes);
  let timedOut = false;
  let aborted = false;
  let settled = false;

  const kill = (signal: NodeJS.Signals): void => {
    if (detached && typeof child.pid === 'number') {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {
        // group already gone — fall through to direct kill
      }
    }
    try {
      child.kill(signal);
    } catch {
      // already dead
    }
  };

  const timer = setTimeout(() => {
    timedOut = true;
    kill('SIGKILL');
  }, opts.timeoutMs);

  const onAbort = (): void => {
    aborted = true;
    kill('SIGKILL');
  };
  if (opts.signal !== undefined) {
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }

  child.stdout?.on('data', (d: Buffer) => stdout.push(d));
  child.stderr?.on('data', (d: Buffer) => stderr.push(d));

  if (opts.input !== undefined && child.stdin !== null) {
    child.stdin.on('error', () => {}); // ignore EPIPE if the process exits early
    child.stdin.write(opts.input);
    child.stdin.end();
  }

  const cleanup = (): void => {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  };

  return await new Promise<ProcessResult>((resolve, reject) => {
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });
    child.on('close', (code, sig) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        exitCode: code,
        signal: sig,
        timedOut,
        aborted,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        durationMs: Date.now() - start,
      });
    });
  });
}
