/**
 * Pure progress mapping: sidecar worker events → the contract's job updates.
 *
 * A job is a plan of weighted stages (e.g. text→3D with texture:
 * image 0.12 → geometry 0.58 → texture 0.30). Workers emit per-step events
 * inside a stage; this module turns them into stagePercent / overallPercent
 * and passes artifacts through UNTOUCHED the moment they exist (geometry-first
 * is the UX contract: the untextured GLB event arrives while texturing runs).
 */

export type Gen3dStage = 'image' | 'geometry' | 'texture' | 'segment' | 'retopo' | 'rig';

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

export function planStageOp(op: 'segment' | 'retopo' | 'texture' | 'rig'): readonly StagePlan[] {
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
    done: ev.done,
    ...(ev.error !== undefined ? { error: ev.error } : {}),
  };
}
