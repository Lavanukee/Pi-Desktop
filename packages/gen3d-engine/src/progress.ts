/**
 * Pure progress mapping: sidecar worker events → the contract's job updates.
 *
 * A job is a plan of weighted stages (e.g. text→3D with texture:
 * image 0.12 → geometry 0.58 → texture 0.30). Workers emit per-step events
 * inside a stage; this module turns them into stagePercent / overallPercent
 * and passes artifacts through UNTOUCHED the moment they exist (geometry-first
 * is the UX contract: the untextured GLB event arrives while texturing runs).
 */

export type Gen3dStage =
  | 'image'
  | 'geometry'
  | 'texture'
  | 'segment'
  | 'retopo'
  | 'rig'
  /** Text -> an animation clip written into an already-rigged model. Runs after
   * `rig` rather than in the generation pipeline: it needs a skeleton to drive,
   * and it takes a prompt of its own. */
  | 'motion';

export interface StagePlan {
  readonly stage: Gen3dStage;
  /** Fraction of the whole pipeline this stage represents; plan sums to 1. */
  readonly weight: number;
}

/** Weights are tuned from measured runs on this hardware class (M-series,
 * 24 GB): Mage-Flow Turbo 4-step ≈ tens of seconds; TRELLIS geometry dominates;
 * the tex-SLAT + Metal bake is roughly half of geometry time. */
export function planGenerate(kind: 'text' | 'image', texture: boolean): readonly StagePlan[] {
  if (kind === 'text') {
    return texture
      ? [
          { stage: 'image', weight: 0.12 },
          { stage: 'geometry', weight: 0.58 },
          { stage: 'texture', weight: 0.3 },
        ]
      : [
          { stage: 'image', weight: 0.15 },
          { stage: 'geometry', weight: 0.85 },
        ];
  }
  return texture
    ? [
        { stage: 'geometry', weight: 0.65 },
        { stage: 'texture', weight: 0.35 },
      ]
    : [{ stage: 'geometry', weight: 1 }];
}

export function planStageOp(
  op: 'segment' | 'retopo' | 'texture' | 'rig' | 'motion',
): readonly StagePlan[] {
  return [{ stage: op, weight: 1 }];
}

/** What the rig stage's shape probe measured — the basis for asking the user
 * "humanoid?" instead of guessing. */
export interface HumanoidProbe {
  readonly isHumanoid: boolean;
  /** 0..1 — how strongly the mesh reads as a humanoid. */
  readonly confidence: number;
  readonly height: number;
  readonly width: number;
  readonly depth: number;
  readonly armSpanRatio: number;
  /** Plain-language notes on what did NOT match (shown to the user). */
  readonly reasons: readonly string[];
}

/**
 * One INTERMEDIATE frame of a stage still in flight — the image worker's
 * per-step denoise output (mflux `--stepwise-image-output-dir`), so the UI can
 * show the picture resolving instead of a spinner.
 *
 * Separate from `artifact` on purpose, and the separation is a guarantee rather
 * than tidiness: an artifact is a real output that gets registered, opened,
 * passed to the next stage, and written into the tool result the MODEL reads. A
 * preview is UI-only and transient — it must never reach the model's context or
 * the session transcript. Shipping it as a small inline data URI (a MEASURED
 * 12-17 KB of 256px JPEG, vs 1.4-2.1 MB for the step's full-res PNG) rather
 * than a path is what keeps that true with no cleanup to get wrong: there is no
 * file on disk for anything downstream to pick up.
 */
export interface JobPreview {
  /** `data:image/jpeg;base64,…` — the downscaled frame. */
  readonly dataUri: string;
  /** Sampler step this frame came out of; 0 is the initial pure-noise latent. */
  readonly step: number;
  readonly totalSteps: number;
  /** FULL-resolution dimensions of the image being generated (not the
   * thumbnail's) — the UI sizes its placeholder to this aspect ratio. */
  readonly width: number;
  readonly height: number;
}

/** One event on the sidecar's /events stream with type:"job". */
export interface SidecarJobEvent {
  readonly jobId: string;
  readonly stage: Gen3dStage;
  /** Index into the job's plan. */
  readonly stageIndex: number;
  readonly message: string;
  readonly step?: number;
  readonly totalSteps?: number;
  readonly artifact?: {
    /** 'model-obj' is the retopo stage's quad mesh — glTF cannot store quads. */
    readonly kind: 'image' | 'model-glb' | 'model-obj';
    readonly path: string;
    readonly label: string;
    /** A viewer-sized copy to DISPLAY when the real mesh is too heavy for the
     * renderer (TRELLIS geometry has measured 14.2M triangles). `path` stays
     * the full-resolution mesh that downstream stages consume. */
    readonly previewPath?: string;
  };
  /** Humanoid measurements from the rig stage's shape probe. */
  readonly humanoid?: HumanoidProbe;
  /** A live denoising frame — see {@link JobPreview}. */
  readonly preview?: JobPreview;
  readonly stageDone?: boolean;
  readonly done: boolean;
  readonly error?: string;
}

/** The contract's Gen3dJobUpdate, kept structural so this package does not
 * import from the app (gen3d-main re-exports the nominal type). */
export interface JobUpdate {
  readonly jobId: string;
  readonly stage: Gen3dStage;
  readonly message: string;
  readonly stagePercent: number;
  readonly overallPercent: number;
  readonly artifact?: SidecarJobEvent['artifact'];
  readonly humanoid?: HumanoidProbe;
  readonly preview?: JobPreview;
  readonly done: boolean;
  readonly error?: string;
}

function clampPct(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Map one sidecar job event onto the contract shape given the job's plan.
 * Unknown stageIndex (defensive) treats prior weight as 0.
 */
export function mapJobEvent(plan: readonly StagePlan[], ev: SidecarJobEvent): JobUpdate {
  const stagePercent =
    ev.stageDone === true
      ? 100
      : ev.totalSteps !== undefined && ev.totalSteps > 0 && ev.step !== undefined
        ? clampPct((ev.step / ev.totalSteps) * 100)
        : 0;

  let before = 0;
  for (let i = 0; i < Math.min(ev.stageIndex, plan.length); i++) {
    const entry = plan[i];
    if (entry !== undefined) before += entry.weight;
  }
  const weight = plan[ev.stageIndex]?.weight ?? 0;
  const overallPercent =
    ev.done && ev.error === undefined
      ? 100
      : clampPct((before + weight * (stagePercent / 100)) * 100);

  return {
    jobId: ev.jobId,
    stage: ev.stage,
    message: ev.message,
    stagePercent: ev.done && ev.error === undefined ? 100 : stagePercent,
    overallPercent,
    ...(ev.artifact !== undefined ? { artifact: ev.artifact } : {}),
    ...(ev.humanoid !== undefined ? { humanoid: ev.humanoid } : {}),
    // Passed through untouched. A preview carries no step weight of its own —
    // the worker's `progress` events already drive the percentages, and a frame
    // arriving must never rewind the bar.
    ...(ev.preview !== undefined ? { preview: ev.preview } : {}),
    done: ev.done,
    ...(ev.error !== undefined ? { error: ev.error } : {}),
  };
}
