/**
 * llama-server supervisor: launch, health-check, crash-restart, graceful
 * dispose, and TPS metrics — with the process runtime injected structurally so
 * it unit-tests in plain Node with a fake child (mirroring engine/pi-bridge).
 *
 * Launch modes encode the MTP exclusivity invariant that the later app-wiring
 * lane must respect:
 *   - 'fast-text'  → single slot (`--parallel 1`) + speculative decoding when the
 *                    build supports it, one of:
 *                      · MTP     — `--spec-type draft-mtp --spec-draft-n-max N`
 *                        (embedded head, or a sibling head via `--model-draft`).
 *                      · EAGLE-3 — `--spec-type draft-eagle3 --model-draft <draft>
 *                        --spec-draft-n-max N` (a separate draft GGUF).
 *                    NEVER `--mmproj`.
 *   - 'multimodal' → `--mmproj`, spec-decode OFF, `--parallel` may be > 1.
 * `assembleServerArgs()` is exported and pure so those flags can be inspected
 * and tested without spawning anything.
 */
import { spawn as spawnCb } from 'node:child_process';
import { createServer } from 'node:net';
import type { LaunchMode } from './catalog.js';

/** llama.cpp per-request `timings` block (subset we read). */
export interface LlamaTimings {
  readonly prompt_n?: number;
  readonly prompt_ms?: number;
  readonly prompt_per_second?: number;
  readonly predicted_n?: number;
  readonly predicted_ms?: number;
  readonly predicted_per_second?: number;
}

export interface ServerMetrics {
  /** Most recent generation throughput (tokens/sec). */
  readonly lastTps: number | undefined;
  /** Exponential moving average of TPS across samples. */
  readonly avgTps: number | undefined;
  readonly samples: number;
  readonly totalPredictedTokens: number;
}

/** Structural slice of ChildProcess so tests inject a fake. */
export interface LlamaChildProcess {
  readonly pid?: number;
  stdout: { on(event: 'data', cb: (chunk: Buffer | string) => void): void } | null;
  stderr: { on(event: 'data', cb: (chunk: Buffer | string) => void): void } | null;
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: 'exit', cb: (code: number | null, signal: string | null) => void): void;
  kill(signal?: 'SIGTERM' | 'SIGKILL'): void;
}

export type LlamaSpawnFn = (
  command: string,
  args: string[],
  options: { env: Record<string, string | undefined> },
) => LlamaChildProcess;

export type SupervisorEvent =
  | { type: 'starting'; attempt: number }
  | { type: 'ready'; baseUrl: string; port: number; pid: number }
  | { type: 'log'; stream: 'stdout' | 'stderr'; text: string }
  | { type: 'crash'; code: number | null; signal: string | null }
  | { type: 'restart'; attempt: number; delayMs: number }
  | { type: 'exit'; reason: 'disposed' | 'failed'; detail?: string }
  | { type: 'metrics'; metrics: ServerMetrics };

export type SupervisorListener = (event: SupervisorEvent) => void;

export interface LaunchConfig {
  readonly modelPath: string;
  readonly host: string;
  readonly port: number;
  readonly contextSize?: number;
  readonly parallel?: number;
  readonly launchMode: LaunchMode;
  readonly mmprojPath?: string;
  readonly mtpPath?: string;
  /** Whether the build advertises `draft-mtp` (from probeServerFeatures). */
  readonly mtpSupported?: boolean;
  /** Whether the model embeds its MTP head (Qwen3.6). */
  readonly mtpEmbedded?: boolean;
  /** Speculative-decoding method for a fast-text launch (default 'draft-mtp'). */
  readonly specType?: 'draft-mtp' | 'draft-eagle3';
  /** EAGLE-3 draft model path (paired via `--model-draft`). */
  readonly draftPath?: string;
  /** Whether the build advertises `draft-eagle3` (from probeServerFeatures). */
  readonly eagle3Supported?: boolean;
  readonly specDraftNMax?: number;
  readonly extraArgs?: readonly string[];
}

/**
 * Build llama-server CLI args, enforcing the MTP⊥mmproj invariant.
 * Pure; throws on a contradictory request so app wiring fails loudly.
 */
export function assembleServerArgs(cfg: LaunchConfig): string[] {
  if (cfg.launchMode === 'fast-text' && cfg.mmprojPath !== undefined) {
    throw new Error('fast-text (MTP) mode is mutually exclusive with --mmproj');
  }
  const args = ['-m', cfg.modelPath, '--host', cfg.host, '--port', String(cfg.port)];
  if (cfg.contextSize !== undefined) args.push('-c', String(cfg.contextSize));

  if (cfg.launchMode === 'fast-text') {
    // Speculative decoding requires a single slot.
    args.push('--parallel', '1');
    if ((cfg.specType ?? 'draft-mtp') === 'draft-eagle3') {
      // EAGLE-3 always needs a separate draft model.
      if (cfg.eagle3Supported === true && cfg.draftPath !== undefined) {
        args.push(
          '--spec-type',
          'draft-eagle3',
          '--spec-draft-n-max',
          String(cfg.specDraftNMax ?? 3),
          '--model-draft',
          cfg.draftPath,
        );
      }
    } else {
      // MTP: an embedded head, or a sibling head passed via --model-draft.
      const mtpAvailable = cfg.mtpEmbedded === true || cfg.mtpPath !== undefined;
      if (cfg.mtpSupported === true && mtpAvailable) {
        args.push('--spec-type', 'draft-mtp', '--spec-draft-n-max', String(cfg.specDraftNMax ?? 2));
        if (cfg.mtpPath !== undefined) args.push('--model-draft', cfg.mtpPath);
      }
    }
  } else {
    if (cfg.mmprojPath !== undefined) args.push('--mmproj', cfg.mmprojPath);
    args.push('--parallel', String(cfg.parallel ?? 1));
  }

  if (cfg.extraArgs !== undefined) args.push(...cfg.extraArgs);
  return args;
}

/** Bind an ephemeral port and immediately release it for the child to claim. */
export function findFreePort(host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, host, () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        server.close(() => reject(new Error('could not determine free port')));
        return;
      }
      const { port } = addr;
      server.close(() => resolve(port));
    });
  });
}

export interface SupervisorOptions {
  readonly serverPath: string;
  readonly modelPath: string;
  readonly launchMode: LaunchMode;
  readonly host?: string;
  /** Fixed port; when undefined a free port is chosen at start(). */
  readonly port?: number;
  readonly contextSize?: number;
  readonly parallel?: number;
  readonly mmprojPath?: string;
  readonly mtpPath?: string;
  readonly mtpSupported?: boolean;
  readonly mtpEmbedded?: boolean;
  readonly specType?: 'draft-mtp' | 'draft-eagle3';
  readonly draftPath?: string;
  readonly eagle3Supported?: boolean;
  readonly specDraftNMax?: number;
  readonly extraArgs?: readonly string[];
  readonly env?: Record<string, string | undefined>;

  // -- lifecycle tuning ---------------------------------------------------
  readonly healthTimeoutMs?: number;
  readonly healthIntervalMs?: number;
  readonly maxRestarts?: number;
  readonly restartBaseDelayMs?: number;
  readonly killGraceMs?: number;

  // -- structural injection (tests) --------------------------------------
  readonly spawnFn?: LlamaSpawnFn;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

export interface StartResult {
  readonly baseUrl: string;
  readonly port: number;
  readonly pid: number;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });

export class LlamaServerSupervisor {
  private readonly listeners = new Set<SupervisorListener>();
  private readonly host: string;
  private readonly maxRestarts: number;
  private readonly restartBaseDelayMs: number;
  private readonly healthTimeoutMs: number;
  private readonly healthIntervalMs: number;
  private readonly killGraceMs: number;
  private readonly spawnFn: LlamaSpawnFn;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  private child: LlamaChildProcess | null = null;
  private port = 0;
  private disposed = false;
  private started = false;
  private restartCount = 0;
  private killTimer: ReturnType<typeof setTimeout> | null = null;

  // metrics
  private lastTps: number | undefined;
  private avgTps: number | undefined;
  private samples = 0;
  private totalPredicted = 0;

  constructor(private readonly opts: SupervisorOptions) {
    this.host = opts.host ?? '127.0.0.1';
    this.maxRestarts = opts.maxRestarts ?? 3;
    this.restartBaseDelayMs = opts.restartBaseDelayMs ?? 500;
    this.healthTimeoutMs = opts.healthTimeoutMs ?? 60_000;
    this.healthIntervalMs = opts.healthIntervalMs ?? 250;
    this.killGraceMs = opts.killGraceMs ?? 3_000;
    this.spawnFn = opts.spawnFn ?? ((cmd, args, o) => spawnCb(cmd, args, o) as LlamaChildProcess);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  on(listener: SupervisorListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: SupervisorEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        // A listener throwing must never take down the supervisor.
      }
    }
  }

  get baseUrl(): string {
    return `http://${this.host}:${this.port}/v1`;
  }
  get healthUrl(): string {
    return `http://${this.host}:${this.port}/health`;
  }
  get metrics(): ServerMetrics {
    return {
      lastTps: this.lastTps,
      avgTps: this.avgTps,
      samples: this.samples,
      totalPredictedTokens: this.totalPredicted,
    };
  }
  get running(): boolean {
    return this.child !== null && !this.disposed;
  }

  /** Feed a llama.cpp `timings` block to update TPS (called by the provider). */
  recordTimings(t: LlamaTimings | undefined): void {
    if (t === undefined) return;
    const tps =
      t.predicted_per_second ??
      (t.predicted_n !== undefined && t.predicted_ms !== undefined && t.predicted_ms > 0
        ? (t.predicted_n / t.predicted_ms) * 1000
        : undefined);
    if (tps === undefined || !Number.isFinite(tps)) return;
    this.lastTps = tps;
    this.avgTps = this.avgTps === undefined ? tps : this.avgTps * 0.7 + tps * 0.3;
    this.samples += 1;
    if (t.predicted_n !== undefined) this.totalPredicted += t.predicted_n;
    this.emit({ type: 'metrics', metrics: this.metrics });
  }

  private buildArgs(): string[] {
    return assembleServerArgs({
      modelPath: this.opts.modelPath,
      host: this.host,
      port: this.port,
      contextSize: this.opts.contextSize,
      parallel: this.opts.parallel,
      launchMode: this.opts.launchMode,
      mmprojPath: this.opts.mmprojPath,
      mtpPath: this.opts.mtpPath,
      mtpSupported: this.opts.mtpSupported,
      mtpEmbedded: this.opts.mtpEmbedded,
      specType: this.opts.specType,
      draftPath: this.opts.draftPath,
      eagle3Supported: this.opts.eagle3Supported,
      specDraftNMax: this.opts.specDraftNMax,
      extraArgs: this.opts.extraArgs,
    });
  }

  private async pollHealth(): Promise<boolean> {
    const deadline = this.now() + this.healthTimeoutMs;
    while (this.now() < deadline) {
      if (this.disposed) return false;
      try {
        const res = await this.fetchImpl(this.healthUrl);
        if (res.ok) return true;
      } catch {
        // Not up yet.
      }
      await sleep(this.healthIntervalMs);
    }
    return false;
  }

  private wireChild(child: LlamaChildProcess): void {
    child.stdout?.on('data', (c) => this.emit({ type: 'log', stream: 'stdout', text: String(c) }));
    child.stderr?.on('data', (c) => this.emit({ type: 'log', stream: 'stderr', text: String(c) }));
    child.on('error', (err) => this.emit({ type: 'log', stream: 'stderr', text: String(err) }));
    child.on('exit', (code, signal) => this.handleExit(code, signal));
  }

  private handleExit(code: number | null, signal: string | null): void {
    if (this.killTimer !== null) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }
    this.child = null;
    if (this.disposed) return;
    this.emit({ type: 'crash', code, signal });
    void this.attemptRestart();
  }

  private async attemptRestart(): Promise<void> {
    if (this.disposed) return;
    if (this.restartCount >= this.maxRestarts) {
      this.emit({ type: 'exit', reason: 'failed', detail: 'max restarts exceeded' });
      return;
    }
    this.restartCount += 1;
    const delayMs = this.restartBaseDelayMs * 2 ** (this.restartCount - 1);
    this.emit({ type: 'restart', attempt: this.restartCount, delayMs });
    await sleep(delayMs);
    if (this.disposed) return;
    const ok = await this.spawnOnce();
    if (!ok) await this.attemptRestart();
  }

  /** Spawn the child and wait for health. Returns false on failed health. */
  private async spawnOnce(): Promise<boolean> {
    if (this.disposed) return false;
    this.emit({ type: 'starting', attempt: this.restartCount });
    const args = this.buildArgs();
    const child = this.spawnFn(this.opts.serverPath, args, {
      env: { ...(this.opts.env ?? process.env) },
    });
    this.child = child;
    this.wireChild(child);
    const healthy = await this.pollHealth();
    if (!healthy) {
      // Health never came up; kill this instance and let restart logic decide.
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
      if (this.child === child) this.child = null;
      return false;
    }
    this.emit({ type: 'ready', baseUrl: this.baseUrl, port: this.port, pid: child.pid ?? -1 });
    return true;
  }

  /**
   * Launch and wait until the server is healthy. Resolves with the base URL, or
   * rejects if the server never becomes healthy within maxRestarts attempts.
   */
  async start(): Promise<StartResult> {
    if (this.started) throw new Error('supervisor already started');
    this.started = true;
    this.port = this.opts.port ?? (await findFreePort(this.host));

    // Initial attempt + backoff retries, but here we surface failure to the
    // caller instead of the fire-and-forget crash loop.
    for (let attempt = 0; attempt <= this.maxRestarts; attempt++) {
      if (this.disposed) throw new Error('supervisor disposed during start');
      if (attempt > 0) {
        const delayMs = this.restartBaseDelayMs * 2 ** (attempt - 1);
        this.restartCount = attempt;
        this.emit({ type: 'restart', attempt, delayMs });
        await sleep(delayMs);
      }
      const ok = await this.spawnOnce();
      if (ok) {
        this.restartCount = 0; // reset budget for ongoing supervision
        return { baseUrl: this.baseUrl, port: this.port, pid: this.child?.pid ?? -1 };
      }
    }
    this.emit({ type: 'exit', reason: 'failed', detail: 'server never became healthy' });
    throw new Error(`llama-server never became healthy on port ${this.port}`);
  }

  /** Graceful shutdown: SIGTERM, then SIGKILL after killGraceMs. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const child = this.child;
    if (child === null) {
      this.emit({ type: 'exit', reason: 'disposed' });
      return;
    }
    try {
      child.kill('SIGTERM');
    } catch {
      // already gone
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        if (this.killTimer !== null) {
          clearTimeout(this.killTimer);
          this.killTimer = null;
        }
        resolve();
      };
      child.on('exit', done);
      this.killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
        done();
      }, this.killGraceMs);
      this.killTimer.unref?.();
    });
    this.child = null;
    this.emit({ type: 'exit', reason: 'disposed' });
  }
}
