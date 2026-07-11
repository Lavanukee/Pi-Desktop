/**
 * Build the command that launches the Python generation worker under uv, and
 * resolve the bundled worker script. Pure + injectable so the argv is testable
 * without spawning (mirrors inference/mlx-manager's `assembleMlxServerArgs` and
 * afm/helper-path's binary resolution).
 *
 * The worker is launched exactly the same way locally and (later) remotely — the
 * argv here IS the remote command too; only the transport that runs it changes.
 * That is what keeps the job API remote-capable from day one.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Backend } from './protocol.js';

/**
 * Pinned mflux version passed to `uv --with`. Bump deliberately. Verified on this
 * M5 Pro (2026-07): `uv run --with mflux==0.18.0 mflux-generate-z-image-turbo …`
 * generated a PNG end-to-end. mflux pulls mlx + its Metal wheels transitively.
 * [measured]
 */
export const MFLUX_PIN = '0.18.0';

/**
 * Pin passed to `uv --with mlx-audio==<pin>` for the TTS worker path. Forward-
 * dated — verify the exact release at build time. [projected]
 */
export const MLX_AUDIO_PIN = '0.2.3';

/** uv-provisioned CPython version for the worker (matches web-tools/mlx). */
export const DEFAULT_PYTHON_VERSION = '3.12';

/**
 * The base `uv --with` package(s) a backend's `worker.py` modality dispatch
 * needs, BEFORE any entry-specific {@link WorkerUvArgsOptions.extraWith}. This is
 * the fix for the old hardcoded `--with mflux`: a TTS or 3D job must NOT drag in
 * mflux. Only the process-per-job uv-worker backends appear here — `comfyui`
 * (persistent aiohttp server) and `hyperframes` (Node+ffmpeg) do NOT go through
 * this argv builder, so they resolve to no base package.
 *
 * 3D deps (`triposr` / `trellis`) are forward-dated: the exact package set is
 * finalised when the Phase-D 3D worker lands. [projected]
 */
export function baseWorkerWith(backend: Backend, mfluxPin: string = MFLUX_PIN): readonly string[] {
  switch (backend) {
    case 'mflux':
      return [`mflux==${mfluxPin}`];
    case 'mlx-audio':
      return [`mlx-audio==${MLX_AUDIO_PIN}`];
    case 'triposr':
      // TripoSR one-shot LRM; MPS-fallback torch stack. [projected deps]
      return ['torch', 'torchvision', 'transformers'];
    case 'trellis':
      // trellis2-mlx persistent MLX worker (NOT ComfyUI). [fwd slug + projected]
      return ['mlx', 'trellis2-mlx'];
    case 'comfyui':
    case 'hyperframes':
      // Not driven by the uv worker — persistent server / Node path.
      return [];
  }
}

/** Env var an embedder can set to point at an explicit worker.py (packaged app). */
export const GEN_WORKER_PATH_ENV = 'PI_GEN_WORKER_PATH';

/** Absolute path to this package root (…/packages/gen-service), derived from src/. */
function packageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url)); // …/packages/gen-service/src
  return path.resolve(here, '..');
}

/**
 * Resolve the bundled worker script path, in priority order:
 *   1. an explicit override (packaged app passes the extraResources path),
 *   2. `PI_GEN_WORKER_PATH`,
 *   3. this package's `python/worker.py`.
 */
export function resolveWorkerScript(override?: string): string {
  if (override !== undefined && override.length > 0) return override;
  const fromEnv = process.env[GEN_WORKER_PATH_ENV];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return path.join(packageRoot(), 'python', 'worker.py');
}

export interface WorkerUvArgsOptions {
  /** Absolute path to worker.py (from {@link resolveWorkerScript}). */
  readonly workerScript: string;
  /**
   * The job's backend — selects the base `uv --with` package(s) via
   * {@link baseWorkerWith}. Defaults to `mflux` (image), preserving the phase-1
   * behaviour. A TTS job passes `mlx-audio`, a 3D job `triposr`/`trellis`; none
   * of them force mflux.
   */
  readonly backend?: Backend;
  /** mflux version pin (default {@link MFLUX_PIN}); applies to the mflux base. */
  readonly mfluxPin?: string;
  /** uv-provisioned Python version (default {@link DEFAULT_PYTHON_VERSION}). */
  readonly python?: string;
  /**
   * Extra `uv --with` deps ADDED ON TOP of the backend's base package(s) (e.g. a
   * codec). Additive only — it never changes which base backend package is used.
   */
  readonly extraWith?: readonly string[];
  /**
   * Launch the worker in persistent `--serve` stdin-loop mode instead of the
   * default one-job-per-process mode. This is the TRELLIS.2 3D path: its ~15GB
   * weights must load ONCE and stay resident across many assets, so a
   * persistent-worker adapter (Phase D) drives it with `serveMode:true` and
   * streams one job envelope per line. Default `false` → the existing
   * process-per-job behaviour (image/TTS), byte-for-byte unchanged.
   */
  readonly serveMode?: boolean;
}

/**
 * Build the argv for the `uv` binary that launches the worker:
 *
 *   run --no-project --python <v> --with <base…> [--with <extra> …] python <worker.py>
 *
 * The base `--with` package(s) come from the job's `backend` via
 * {@link baseWorkerWith} (mflux for image, mlx-audio for TTS, the 3D deps for
 * triposr/trellis) — NOT a hardcoded mflux. The job JSON is written to the
 * worker's stdin (see {@link ../client}); the worker streams
 * {@link ../protocol!GenEvent}s back on stdout. Pure.
 */
export function buildWorkerUvArgs(opts: WorkerUvArgsOptions): string[] {
  const args = ['run', '--no-project', '--python', opts.python ?? DEFAULT_PYTHON_VERSION];
  for (const dep of baseWorkerWith(opts.backend ?? 'mflux', opts.mfluxPin)) {
    args.push('--with', dep);
  }
  for (const dep of opts.extraWith ?? []) {
    args.push('--with', dep);
  }
  args.push('python', opts.workerScript);
  // Persistent 3D (TRELLIS.2) serve mode: worker.py loads the pipeline once and
  // reads one job envelope per stdin line until EOF / a `{"type":"shutdown"}`.
  if (opts.serveMode === true) {
    args.push('--serve');
  }
  return args;
}
