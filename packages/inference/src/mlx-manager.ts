/**
 * MLX server manager (round-12 foundation) — the Apple-Silicon alternative to
 * the llama.cpp path. Mirrors {@link ./llamacpp-manager} (ensure a runtime) +
 * reuses {@link LlamaServerSupervisor} (lifecycle) for the `mlx_lm.server`
 * OpenAI-compatible server, launched via the same `uv` bootstrap the rest of the
 * app uses for isolated Python.
 *
 * Two things differ from llama.cpp and are encoded here (see round12-mlx.md §5):
 *   - **Launch:** `uv run --with mlx-lm mlx_lm.server --model <mlx-community repo>`.
 *     The model artifact is an `mlx-community/*` safetensors repo (NOT a GGUF),
 *     which `mlx_lm.server` auto-downloads into the HF cache on first launch.
 *   - **Health:** `mlx_lm.server` exposes NO `/health`; readiness is a 200 on
 *     `GET /v1/models`. It also emits no `timings` block, so TPS is computed
 *     CLIENT-side by @pi-desktop/provider-mlx (this manager only owns lifecycle).
 *
 * `assembleMlxServerArgs` is pure + exported so the argv is inspectable/testable
 * without spawning anything (mirrors `assembleServerArgs`). MTP/EAGLE/mmproj do
 * not apply on MLX, so there is no exclusivity branch here.
 *
 * Electron-free; PATH resolution + spawn are the only I/O and are injectable.
 */
import { stat } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { LlamaServerSupervisor } from './supervisor.js';

/**
 * Pinned `mlx-lm` version passed to uv `--with`. Bump deliberately; the ephemeral
 * `uv run --with mlx-lm==<pin>` form resolves + caches it (and its Metal wheels)
 * on first use, mirroring web-tools' `uvPythonRuntime` `--with` seam.
 *
 * Verified on this M5 Pro (2026-07): `uv run --with mlx-lm==0.29.1 --with
 * transformers==4.56.2 … import mlx_lm.server` → OK. (A NAKED `--with mlx-lm`
 * pulls the latest `transformers`, which import-fails mlx-lm's tokenizer
 * registration — hence both pins below.)
 */
export const MLX_LM_PIN = '0.29.1';

/**
 * Pinned `transformers` version. `mlx_lm.server` import-breaks on too-new
 * `transformers` (an `AutoTokenizer.register` API skew), so pin it alongside
 * mlx-lm — the concrete fix a naked `--with mlx-lm` smoke uncovered.
 */
export const TRANSFORMERS_PIN = '4.56.2';

/** MLX is Apple-Silicon-only by construction (Metal). Gate the whole path on it. */
export function isMlxSupported(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): boolean {
  return platform === 'darwin' && arch === 'arm64';
}

export interface MlxServerArgsConfig {
  /** The MLX model — an `mlx-community/*` HF repo id or a local snapshot dir. */
  readonly repo: string;
  readonly host: string;
  readonly port: number;
  /** Same-family draft repo for speculative decoding (`--draft-model`); optional. */
  readonly draftRepo?: string;
  /** Draft tokens per step when a draft repo is set (mlx-lm default 3). */
  readonly numDraftTokens?: number;
  /** `mlx-lm` version pin for uv `--with` (default {@link MLX_LM_PIN}). */
  readonly mlxLmPin?: string;
  /** `transformers` version pin for uv `--with` (default {@link TRANSFORMERS_PIN}). */
  readonly transformersPin?: string;
  /** Python version uv provisions for the run (default 3.12). */
  readonly python?: string;
}

/**
 * Build the argv passed to the `uv` binary to launch `mlx_lm.server`. Pure.
 *
 * `uv run --no-project --python <v> --with mlx-lm==<pin> --with
 * transformers==<pin> mlx_lm.server --model <repo> --host <h> --port <p>
 * [--draft-model <r> --num-draft-tokens <n>]`. Both pins are load-bearing (see
 * {@link MLX_LM_PIN} / {@link TRANSFORMERS_PIN}).
 */
export function assembleMlxServerArgs(cfg: MlxServerArgsConfig): string[] {
  const args = [
    'run',
    '--no-project',
    '--python',
    cfg.python ?? '3.12',
    '--with',
    `mlx-lm==${cfg.mlxLmPin ?? MLX_LM_PIN}`,
    '--with',
    `transformers==${cfg.transformersPin ?? TRANSFORMERS_PIN}`,
    'mlx_lm.server',
    '--model',
    cfg.repo,
    '--host',
    cfg.host,
    '--port',
    String(cfg.port),
  ];
  if (cfg.draftRepo !== undefined && cfg.draftRepo.length > 0) {
    args.push(
      '--draft-model',
      cfg.draftRepo,
      '--num-draft-tokens',
      String(cfg.numDraftTokens ?? 3),
    );
  }
  return args;
}

/** How `mlx_lm.server` is reached (its command + provenance). */
export interface MlxRuntime {
  /** Absolute path (PATH probe) to the `uv` binary that launches the server. */
  readonly uvPath: string;
  readonly source: 'path';
}

/** Resolve an executable by scanning PATH (so we get an absolute path). */
async function resolveOnPath(
  name: string,
  pathEnv: string | undefined,
): Promise<string | undefined> {
  for (const dir of (pathEnv ?? '').split(delimiter)) {
    if (dir.length === 0) continue;
    const candidate = join(dir, name);
    try {
      const s = await stat(candidate);
      if (s.isFile()) return candidate;
    } catch {
      // not here; keep scanning
    }
  }
  return undefined;
}

export interface EnsureMlxOptions {
  /** PATH string to scan when probing uv (tests). Default `process.env.PATH`. */
  readonly pathEnv?: string;
}

/**
 * Ensure the MLX runtime is available; return how to invoke it.
 *
 * FOUNDATION: this resolves an existing `uv` on PATH (uv is how the whole app
 * provisions isolated Python — see web-tools). The auto-DOWNLOAD of uv (via
 * web-tools' `ensureUv`, so a machine without uv self-bootstraps) is DEFERRED to
 * keep this package free of web-tools' web-scraping deps; until then MLX asks the
 * user to install uv. `mlx-lm` itself needs no install step — the first
 * `uv run --with mlx-lm==<pin>` resolves + caches it.
 */
export async function ensureMlx(opts: EnsureMlxOptions = {}): Promise<MlxRuntime> {
  const uvPath = await resolveOnPath('uv', opts.pathEnv ?? process.env.PATH);
  if (uvPath === undefined) {
    throw new Error(
      'uv is required to run MLX models on Apple Silicon. Install uv ' +
        '(https://docs.astral.sh/uv/) and retry.',
    );
  }
  return { uvPath, source: 'path' };
}

export interface CreateMlxSupervisorOptions {
  /** The `uv` binary path (from {@link ensureMlx}). */
  readonly uvPath: string;
  /** The MLX model repo/dir passed to `mlx_lm.server --model`. */
  readonly repo: string;
  readonly host?: string;
  readonly port?: number;
  readonly draftRepo?: string;
  readonly mlxLmPin?: string;
  /**
   * Health timeout. Longer than llama.cpp's default: first launch resolves uv +
   * `mlx-lm` (and Metal wheels) AND loads multi-GB weights into unified memory
   * before the socket answers.
   */
  readonly healthTimeoutMs?: number;
}

/**
 * Build a supervisor for `mlx_lm.server`, reusing {@link LlamaServerSupervisor}'s
 * crash-restart/backoff/dispose skeleton via its `buildArgsFn` + `healthPath`
 * seams: the command is `uv`, the args launch `mlx_lm.server`, and readiness is
 * probed on `/v1/models` (no `/health`).
 */
export function createMlxSupervisor(
  opts: CreateMlxSupervisorOptions & {
    readonly spawnFn?: ConstructorParameters<typeof LlamaServerSupervisor>[0]['spawnFn'];
    readonly fetchImpl?: typeof fetch;
    readonly now?: () => number;
  },
): LlamaServerSupervisor {
  const host = opts.host ?? '127.0.0.1';
  return new LlamaServerSupervisor({
    serverPath: opts.uvPath,
    modelPath: opts.repo, // unused by buildArgsFn; kept for logging/parity
    launchMode: 'fast-text', // placeholder — buildArgsFn overrides the argv
    host,
    port: opts.port,
    healthPath: '/v1/models',
    healthTimeoutMs: opts.healthTimeoutMs ?? 180_000,
    buildArgsFn: (port) =>
      assembleMlxServerArgs({
        repo: opts.repo,
        host,
        port,
        draftRepo: opts.draftRepo,
        mlxLmPin: opts.mlxLmPin,
      }),
    spawnFn: opts.spawnFn,
    fetchImpl: opts.fetchImpl,
    now: opts.now,
  });
}
