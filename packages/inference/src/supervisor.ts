/**
 * llama-server supervisor: launch, health-check, crash-restart, graceful
 * dispose, and TPS metrics — with the process runtime injected structurally so
 * it unit-tests in plain Node with a fake child (mirroring engine/pi-bridge).
 *
 * Launch modes encode the MTP exclusivity invariant that the later app-wiring
 * lane must respect:
 *   - 'fast-text'  → `--parallel N` (default 1 slot; the OOM-aware corp launcher
 *                    may request N>1, each slot getting the full `-c / N`) +
 *                    speculative decoding when the build supports it, one of:
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
import type { WatchdogHandle } from './watchdog.js';

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
  /**
   * Preserve <think> reasoning across the whole history via
   * `--reasoning-preserve` (default true). Set false to omit the flag.
   */
  readonly reasoningPreserve?: boolean;
  /**
   * Thinking-token budget (`--reasoning-budget`). -1 = unrestricted (default),
   * 0 = end thinking immediately, N>0 = cap reasoning at N tokens. Power-user
   * knob; a launch arg, so changing it needs a server relaunch.
   */
  readonly reasoningBudget?: number;
  /**
   * Message injected before the end-of-thinking tag when the reasoning budget is
   * exhausted (`--reasoning-budget-message`). Default 'time limit for reasoning
   * reached' so the model wraps up rather than being cut mid-token.
   */
  readonly reasoningBudgetMessage?: string;
  readonly extraArgs?: readonly string[];
}

/**
 * Build llama-server CLI args, enforcing the lazy-mmproj invariant symmetrically.
 * Pure; throws on a contradictory request so app wiring fails loudly:
 *   - a `fast-text` (default/speed) launch must NEVER carry an mmproj — that is
 *     the whole point of lazy loading, and `--mmproj` is mutually exclusive with
 *     MTP/spec-decode anyway; and
 *   - a `multimodal` (vision) launch must ALWAYS carry an mmproj — otherwise the
 *     server comes up vision-blind while the app believes vision is on (launch
 *     mode is sticky, so the on-demand trigger would no-op forever and every
 *     image silently fail). See {@link mmprojFileFor} for the resolution seam.
 */
export function assembleServerArgs(cfg: LaunchConfig): string[] {
  if (cfg.launchMode === 'fast-text' && cfg.mmprojPath !== undefined) {
    throw new Error('fast-text (MTP) mode is mutually exclusive with --mmproj');
  }
  if (cfg.launchMode === 'multimodal' && cfg.mmprojPath === undefined) {
    throw new Error('multimodal (vision) mode requires an --mmproj projector path');
  }
  const args = ['-m', cfg.modelPath, '--host', cfg.host, '--port', String(cfg.port)];
  if (cfg.contextSize !== undefined) args.push('-c', String(cfg.contextSize));

  // Server-wide sampling defaults, tuned to BREAK the repetition/looping jedd
  // observed in regular chat (2026-07-20). The old set (temp 0.6 / top-p 0.95 /
  // top-k 20) was too greedy — low temp + tight top-k collapse onto a repeating
  // groove. The fix, per jedd's diagnosis: raise temperature (>0.75) + top-k
  // (>40), lower top-p (<0.92) to widen the sampling pool, and — crucially — turn
  // on the DRY sampler (llama.cpp's sequence-repetition penalty), which is the
  // targeted anti-loop tool that a flat repeat-penalty is not (a flat penalty
  // punishes legitimately-repeated code symbols; DRY only penalizes long repeated
  // *sequences*, and dry_allowed_length=70 leaves short repeats like `}` / `];`
  // untouched). These are server DEFAULTS — a request may still override any.
  args.push(
    '--temp',
    '0.8',
    '--top-p',
    '0.9',
    '--top-k',
    '50',
    '--min-p',
    '0.0',
    '--presence-penalty',
    '0.0',
    // repeat-penalty stays 1.0 (DISABLED) — DRY replaces it (a classic penalty
    // hurts code, which legitimately repeats tokens).
    '--repeat-penalty',
    '1.0',
    // DRY: multiplier 1.0 (on), base 1.75 (>1.6, steep growth past the allowed
    // run), allowed-length 70 (don't punish short/structural repeats), penalty
    // last-n 4096 (cover the last several reasoning + tool-use activities).
    '--dry-multiplier',
    '1.0',
    '--dry-base',
    '1.75',
    '--dry-allowed-length',
    '70',
    '--dry-penalty-last-n',
    '4096',
  );

  // Preserve the model's <think> reasoning across the WHOLE history, not just the
  // most recent assistant turn (llama.cpp `--reasoning-preserve`, env
  // LLAMA_ARG_REASONING_PRESERVE). For templates that advertise
  // `supports_preserve_reasoning` this re-injects each prior turn's reasoning
  // trace when rendering the prompt, so the model keeps its own chain-of-thought
  // through a long tool-using turn instead of amnesia'ing after every tool call.
  // A no-op on templates without support, so it's safe to send unconditionally.
  // The client side of this is buildChatCompletionsRequest carrying each
  // assistant turn's reasoning_content back (see provider-llamacpp/stream.ts).
  if (cfg.reasoningPreserve !== false) args.push('--reasoning-preserve');

  // Thinking-budget guardrail (llama.cpp `--reasoning-budget`, env
  // LLAMA_ARG_THINK_BUDGET): -1 = unrestricted (default, current behaviour),
  // 0 = end thinking immediately, N>0 = cap the reasoning at N tokens. Exposed
  // so a power user can bound runaway chain-of-thought. When the budget is
  // exhausted the server injects `--reasoning-budget-message` just before the
  // end-of-thinking tag so the model wraps up cleanly instead of being cut mid
  // word. These are LAUNCH args (a change needs a server relaunch), unlike the
  // per-request sampling params.
  args.push('--reasoning-budget', String(cfg.reasoningBudget ?? -1));
  args.push(
    '--reasoning-budget-message',
    cfg.reasoningBudgetMessage ?? 'time limit for reasoning reached',
  );

  if (cfg.launchMode === 'fast-text') {
    // Single slot by default; the OOM-aware corp launcher may request K slots
    // (each getting the full `-c / K` context — the caller sizes `-c` to
    // perSlot × K), while KEEPING speculative decoding on across the slots.
    args.push('--parallel', String(cfg.parallel ?? 1));
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

  /**
   * Parent-death watchdog factory. When provided, each spawned llama-server is
   * guarded by a watchdog (see `watchdog.ts`) that SIGKILLs it if THIS process
   * dies via a hard crash / SIGKILL where the graceful kill ladder can't run —
   * so no llama-server ever outlives the app. Omitted in unit tests (they inject
   * a fake) and unset by default (no watchdog spawned), keeping launches inert.
   */
  readonly watchdogFactory?: (targetPid: number) => WatchdogHandle;

  /**
   * Health endpoint path (default `/health`). A non-llama.cpp OpenAI-compatible
   * server (the round-12 MLX `mlx_lm.server`, which has no `/health`) probes
   * `/v1/models` instead — see {@link createMlxSupervisor}.
   */
  readonly healthPath?: string;
  /**
   * Override the launch args entirely (given the resolved port), bypassing
   * {@link assembleServerArgs}. Lets an alternative engine (MLX via `uv run
   * mlx_lm.server`) reuse this supervisor's crash-restart / health / dispose
   * skeleton with its OWN argv. When set, `serverPath` is the command to spawn
   * (e.g. the `uv` binary) and this builds its arguments. Unset → llama.cpp args.
   */
  readonly buildArgsFn?: (port: number) => string[];

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
  private watchdog: WatchdogHandle | null = null;
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
    return `http://${this.host}:${this.port}${this.opts.healthPath ?? '/health'}`;
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
    // An alternative engine (MLX) supplies its own argv builder; otherwise
    // assemble the llama-server flags (enforcing the MTP⊥mmproj invariant).
    if (this.opts.buildArgsFn !== undefined) return this.opts.buildArgsFn(this.port);
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

  /** Arm a fresh parent-death watchdog for `pid` (replacing any previous one). */
  private armWatchdog(pid: number | undefined): void {
    this.disarmWatchdog();
    if (this.opts.watchdogFactory === undefined || pid === undefined || pid <= 0) return;
    try {
      this.watchdog = this.opts.watchdogFactory(pid);
    } catch {
      // A watchdog we couldn't launch must never block the server launch.
      this.watchdog = null;
    }
  }

  /** Stand the current watchdog down (we are reaping the child ourselves). Idempotent. */
  private disarmWatchdog(): void {
    const w = this.watchdog;
    this.watchdog = null;
    if (w !== null) {
      try {
        w.stop();
      } catch {
        // best-effort
      }
    }
  }

  private handleExit(code: number | null, signal: string | null): void {
    if (this.killTimer !== null) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }
    this.child = null;
    // The child is gone — its watchdog has nothing left to guard.
    this.disarmWatchdog();
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
    // Arm the parent-death watchdog immediately (before health) so even a
    // crash during startup can't leave an orphaned llama-server behind.
    this.armWatchdog(child.pid);
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
      this.disarmWatchdog();
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
    this.disarmWatchdog();
    this.emit({ type: 'exit', reason: 'disposed' });
  }

  /**
   * Synchronous, immediate SIGKILL of the llama-server child — the app-quit /
   * utilityProcess-teardown backstop where the async {@link dispose} ladder
   * cannot run (a `process.on('exit')` handler only runs synchronous work, and a
   * caught SIGTERM must reap the grandchild before the process leaves). Idempotent
   * and safe to call after dispose(); leaves no orphaned llama-server holding the
   * model in RAM/VRAM. The OS reclaims the child's GPU allocation on process death.
   */
  killImmediately(): void {
    this.disposed = true;
    if (this.killTimer !== null) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }
    // Stand the watchdog down synchronously — we're reaping the child right here,
    // so the sidecar must not also try (and its own process must not linger).
    this.disarmWatchdog();
    const child = this.child;
    this.child = null;
    if (child === null) return;
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
}
