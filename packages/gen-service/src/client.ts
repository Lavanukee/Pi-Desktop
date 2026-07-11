/**
 * GenServiceClient — the Node half of the generation worker. It launches the uv
 * worker ({@link ./worker-command}), streams the job JSON to its stdin, parses
 * the worker's NDJSON {@link GenEvent}s, and resolves with the produced outputs.
 *
 * The process runtime is injected structurally (`spawnFn`) so it unit-tests in
 * plain Node against a fake worker — mirroring afm/stream.ts and
 * inference/supervisor.ts. The command it builds IS remote-capable: swap the
 * default local-uv `spawnFn` for one that runs the same argv over SSH and the
 * exact same NDJSON stream flows back, no protocol change.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { type GenEvent, type GenJob, type GenOutput, NdjsonParser } from './protocol.js';
import { buildWorkerUvArgs, resolveWorkerScript } from './worker-command.js';

/** Minimal stdin surface (write the job, then close). */
export interface GenWritable {
  write(data: string, cb?: (err?: Error | null) => void): void;
  end(): void;
  on(event: 'error', cb: (err: Error) => void): void;
}

/** Minimal readable surface (stdout / stderr). */
export interface GenReadable {
  on(event: 'data', cb: (chunk: Buffer | string) => void): void;
}

/** Structural child so tests inject a fake without spawning uv. */
export interface GenChildProcess {
  readonly pid?: number;
  stdin: GenWritable | null;
  stdout: GenReadable | null;
  stderr: GenReadable | null;
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: 'exit', cb: (code: number | null, signal: string | null) => void): void;
  kill(signal?: NodeJS.Signals): void;
}

export type GenSpawnFn = (
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv },
) => GenChildProcess;

/** Real spawn with piped stdio, adapted to {@link GenChildProcess}. */
export const defaultGenSpawn: GenSpawnFn = (command, args, options) =>
  nodeSpawn(command, args as string[], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: options.env,
  }) as unknown as GenChildProcess;

export class GenAbortError extends Error {
  constructor() {
    super('generation aborted');
    this.name = 'GenAbortError';
  }
}

/** Resolve an executable by scanning PATH (absolute path). Mirrors mlx-manager. */
async function resolveOnPath(
  name: string,
  pathEnv: string | undefined,
): Promise<string | undefined> {
  for (const dir of (pathEnv ?? '').split(delimiter)) {
    if (dir.length === 0) continue;
    const candidate = join(dir, name);
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // keep scanning
    }
  }
  return undefined;
}

export interface GenServiceClientOptions {
  /** The `uv` binary path. When unset it is resolved on PATH at first run. */
  readonly uvPath?: string;
  /** Explicit worker.py path (packaged app). Default = bundled `python/worker.py`. */
  readonly workerScript?: string;
  /** mflux pin passed to `uv --with` (default {@link MFLUX_PIN}). */
  readonly mfluxPin?: string;
  readonly python?: string;
  /** Injectable spawn (tests / a remote transport). Default: local uv spawn. */
  readonly spawnFn?: GenSpawnFn;
  /** Injectable uv resolver (tests). Default: PATH probe. */
  readonly resolveUv?: () => Promise<string>;
}

export interface RunJobOptions {
  /** Called for EVERY worker event (start/download/progress/candidate/done/error/log). */
  readonly onEvent?: (event: GenEvent) => void;
  /** Aborts the job and SIGKILLs the worker. */
  readonly signal?: AbortSignal;
  /** Extra `uv --with` deps for this job's backend (e.g. `mlx-audio`). */
  readonly extraWith?: readonly string[];
}

/**
 * Runs generation jobs by spawning the uv worker. One client can run many jobs
 * (each `run()` spawns its own worker); serialization/concurrency is the
 * JobQueue's concern, not the client's.
 */
export class GenServiceClient {
  readonly #opts: GenServiceClientOptions;
  #uvPath: string | undefined;

  constructor(opts: GenServiceClientOptions = {}) {
    this.#opts = opts;
    this.#uvPath = opts.uvPath;
  }

  async #resolveUvPath(): Promise<string> {
    if (this.#uvPath !== undefined) return this.#uvPath;
    if (this.#opts.resolveUv !== undefined) {
      this.#uvPath = await this.#opts.resolveUv();
      return this.#uvPath;
    }
    const found = await resolveOnPath('uv', process.env.PATH);
    if (found === undefined) {
      throw new Error(
        'uv is required to run generation models. Install uv (https://docs.astral.sh/uv/) and retry.',
      );
    }
    this.#uvPath = found;
    return found;
  }

  /**
   * Run one job to completion. Resolves with the produced outputs on the worker's
   * terminal `done`; rejects on `error`, an unexpected exit, or abort.
   */
  async run(job: GenJob, options: RunJobOptions = {}): Promise<GenOutput[]> {
    if (options.signal?.aborted === true) throw new GenAbortError();
    const uvPath = await this.#resolveUvPath();
    const workerScript = resolveWorkerScript(this.#opts.workerScript);
    const args = buildWorkerUvArgs({
      workerScript,
      mfluxPin: this.#opts.mfluxPin,
      python: this.#opts.python,
      extraWith: options.extraWith,
    });
    const spawnFn = this.#opts.spawnFn ?? defaultGenSpawn;

    return await new Promise<GenOutput[]>((resolve, reject) => {
      let child: GenChildProcess;
      try {
        child = spawnFn(uvPath, args, {
          env: { ...process.env, UV_PYTHON_DOWNLOADS: 'automatic' },
        });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      const parser = new NdjsonParser();
      let settled = false;
      let outputs: GenOutput[] | null = null;
      let errored: { message: string; recoverable?: boolean } | null = null;
      let stderrTail = '';

      const onAbort = (): void => {
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
        settle(() => reject(new GenAbortError()));
      };

      const cleanup = (): void => {
        options.signal?.removeEventListener('abort', onAbort);
      };
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };

      const handleEvent = (event: GenEvent): void => {
        options.onEvent?.(event);
        if (event.event === 'done') {
          outputs = [...event.outputs];
        } else if (event.event === 'error') {
          errored = { message: event.message, recoverable: event.recoverable };
        }
      };

      if (options.signal !== undefined) {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }

      child.stdout?.on('data', (chunk) => {
        for (const event of parser.push(String(chunk))) handleEvent(event);
      });
      child.stderr?.on('data', (chunk) => {
        stderrTail = (stderrTail + String(chunk)).slice(-2000);
      });
      child.on('error', (err) => settle(() => reject(err)));
      child.on('exit', (code) => {
        for (const event of parser.flush()) handleEvent(event);
        if (errored !== null) {
          const e = errored as { message: string; recoverable?: boolean };
          settle(() => reject(new Error(e.message)));
          return;
        }
        if (outputs !== null) {
          const out = outputs as GenOutput[];
          settle(() => resolve(out));
          return;
        }
        const detail = stderrTail.trim().length > 0 ? `: ${stderrTail.trim().slice(-500)}` : '';
        settle(() =>
          reject(
            new Error(
              `gen worker exited (code ${code ?? 'null'}) without a done/error event${detail}`,
            ),
          ),
        );
      });

      // Send the job envelope, then close stdin.
      try {
        child.stdin?.on('error', (err) => settle(() => reject(err)));
        child.stdin?.write(`${JSON.stringify(job)}\n`, (err) => {
          if (err != null) settle(() => reject(err));
        });
        child.stdin?.end();
      } catch (err) {
        settle(() => reject(err instanceof Error ? err : new Error(String(err))));
      }
    });
  }
}
