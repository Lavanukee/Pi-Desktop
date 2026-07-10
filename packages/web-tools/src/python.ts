/**
 * python_run execution: a bounded process runner plus an injectable
 * `PythonRuntime`, with a uv-managed implementation.
 *
 * `spawnCapture` is the low-level primitive — it runs a command in a sandbox
 * cwd with a hard timeout (SIGKILL, process-group-wide on POSIX so orphans die
 * too), per-stream output byte caps, external-abort support, and structured
 * stdout/stderr/exit capture. It is exercised directly in unit tests with cheap
 * shell commands (no uv), while the tool wires against the `PythonRuntime`
 * interface so tests inject a fake runner.
 *
 * `uvPythonRuntime` provisions an isolated Python via uv (never system Python):
 * it writes the script into a fresh temp dir and runs it with
 * `uv run --no-project --python <ver>`, letting uv fetch a managed CPython on
 * first use. `ensureUv` (uv.ts) is injectable so unit tests never need a real uv.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureUv, type UvInstall } from './uv.js';

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
  // On POSIX, run in a new process group so SIGKILL reaches the whole tree
  // (uv → python → any children) on timeout. Windows has no process groups here.
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

export type PythonRunResult = ProcessResult;

export interface PythonRunOptions {
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  /** Sandbox working dir; a fresh temp dir is created (and cleaned) when omitted. */
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly signal?: AbortSignal;
}

/** Injectable seam so the tool can run without a real uv/Python in unit tests. */
export interface PythonRuntime {
  run(script: string, opts?: PythonRunOptions): Promise<PythonRunResult>;
}

export const DEFAULT_PYTHON_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 200_000;
export const DEFAULT_PYTHON_VERSION = '3.12';

export interface UvPythonRuntimeOptions {
  /** Injectable uv bootstrap (tests). Default: {@link ensureUv}. */
  readonly ensure?: () => Promise<UvInstall>;
  readonly pythonVersion?: string;
  /** Extra args inserted before `python <script>` (e.g. `--with numpy` later). */
  readonly extraUvArgs?: readonly string[];
}

/** A {@link PythonRuntime} backed by a uv-provisioned, isolated Python. */
export function uvPythonRuntime(opts: UvPythonRuntimeOptions = {}): PythonRuntime {
  const ensure = opts.ensure ?? ((): Promise<UvInstall> => ensureUv());
  const pyVersion = opts.pythonVersion ?? DEFAULT_PYTHON_VERSION;
  return {
    async run(script, runOpts = {}) {
      const install = await ensure();
      const timeoutMs = runOpts.timeoutMs ?? DEFAULT_PYTHON_TIMEOUT_MS;
      const maxOutputBytes = runOpts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
      const createdSandbox = runOpts.cwd === undefined;
      const cwd = runOpts.cwd ?? (await mkdtemp(join(tmpdir(), 'pi-web-tools-py-')));
      const scriptPath = join(cwd, 'script.py');
      await writeFile(scriptPath, script, 'utf8');

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ...runOpts.env,
        // Provision a managed CPython on demand; never fall back to system Python.
        UV_PYTHON_DOWNLOADS: 'automatic',
      };
      const args = [
        'run',
        '--no-project',
        '--quiet',
        '--python',
        pyVersion,
        ...(opts.extraUvArgs ?? []),
        'python',
        scriptPath,
      ];
      try {
        return await spawnCapture(install.uvPath, args, {
          cwd,
          env,
          timeoutMs,
          maxOutputBytes,
          signal: runOpts.signal,
        });
      } finally {
        if (createdSandbox) await rm(cwd, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}
