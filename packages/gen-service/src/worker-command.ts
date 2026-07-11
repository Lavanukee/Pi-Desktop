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

/**
 * Pinned mflux version passed to `uv --with`. Bump deliberately. Verified on this
 * M5 Pro (2026-07): `uv run --with mflux==0.18.0 mflux-generate-z-image-turbo …`
 * generated a PNG end-to-end. mflux pulls mlx + its Metal wheels transitively.
 */
export const MFLUX_PIN = '0.18.0';

/** uv-provisioned CPython version for the worker (matches web-tools/mlx). */
export const DEFAULT_PYTHON_VERSION = '3.12';

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
  /** mflux version pin (default {@link MFLUX_PIN}). */
  readonly mfluxPin?: string;
  /** uv-provisioned Python version (default {@link DEFAULT_PYTHON_VERSION}). */
  readonly python?: string;
  /**
   * Extra `uv --with` deps for a modality's backend (e.g. `mlx-audio` for TTS).
   * Image needs only mflux, so this is empty for phase 1.
   */
  readonly extraWith?: readonly string[];
}

/**
 * Build the argv for the `uv` binary that launches the worker:
 *
 *   run --no-project --python <v> --with mflux==<pin> [--with <dep> …] python <worker.py>
 *
 * The job JSON is written to the worker's stdin (see {@link ../client}); the
 * worker streams {@link ../protocol!GenEvent}s back on stdout. Pure.
 */
export function buildWorkerUvArgs(opts: WorkerUvArgsOptions): string[] {
  const args = [
    'run',
    '--no-project',
    '--python',
    opts.python ?? DEFAULT_PYTHON_VERSION,
    '--with',
    `mflux==${opts.mfluxPin ?? MFLUX_PIN}`,
  ];
  for (const dep of opts.extraWith ?? []) {
    args.push('--with', dep);
  }
  args.push('python', opts.workerScript);
  return args;
}
