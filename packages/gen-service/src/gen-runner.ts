/**
 * makeGenRunner — the single dispatching {@link JobRunner} the {@link JobQueue}
 * takes, so the queue (and gen-manager, gen-bridge, gen-canvas) stay backend-
 * agnostic. It routes by `job.backend`:
 *
 *   - `comfyui` → the persistent-server {@link ComfyClient} adapter;
 *   - everything else (`mflux` / `mlx-audio` / `triposr` / `trellis`) → the
 *     process-per-job {@link GenServiceClient} uv worker.
 *
 * Both runners share the exact same `run(job, opts) → GenOutput[]` shape, so the
 * queue's heavy/light unified-memory gating (which keys off the ENTRY, not the
 * backend) works across both for free — a heavy ComfyUI video job and a heavy MLX
 * job already mutually exclude with no new memory logic.
 */
import { GenServiceClient } from './client.js';
import type { JobRunner } from './job-queue.js';
import type { GenJob, GenOutput } from './protocol.js';

/** The minimal runner surface {@link makeGenRunner} composes (ComfyClient / GenServiceClient both satisfy it). */
export interface GenRunnerLike {
  run(
    job: GenJob,
    opts: {
      onEvent?: (event: import('./protocol.js').GenEvent) => void;
      signal?: AbortSignal;
      extraWith?: readonly string[];
    },
  ): Promise<GenOutput[]>;
}

export interface MakeGenRunnerDeps {
  /** The ComfyUI adapter for `comfyui`-backend jobs. */
  readonly comfy: GenRunnerLike;
  /** The uv-worker client for every other backend (default: a fresh {@link GenServiceClient}). */
  readonly gen?: GenRunnerLike;
}

/**
 * Compose one {@link JobRunner} that dispatches `comfyui` jobs to the ComfyUI
 * adapter and all others to the uv-worker client. Pass the result straight to
 * `new JobQueue({ runner })`.
 */
export function makeGenRunner(deps: MakeGenRunnerDeps): JobRunner {
  const gen = deps.gen ?? new GenServiceClient();
  return (job, opts) => (job.backend === 'comfyui' ? deps.comfy : gen).run(job, opts);
}
