/**
 * The generating experience — a two-phase, WHOLE-VIEWPORT state (jedd).
 *
 * What it replaces: a 440px card floating near the bottom edge while the entire
 * viewport sat empty. jedd: "the progress bar is tiny, smooshed to the side and
 * the model doesn't appear immediately when generated, there's a whole viewport
 * that's just left blank rather than using the whole thing."
 *
 * The shape of it:
 *   Phase 1 — BUILDING. Nothing to look at yet, so the generating state owns the
 *     whole viewport: a wide progress bar across the middle, the stage, the live
 *     message, elapsed, and Cancel.
 *   Transition — the instant the engine emits the geometry, the model is shown.
 *   Phase 2 — REFINING. The model is on screen and must stay the subject, so the
 *     progress collapses to a slim bar pinned along the BOTTOM for texturing.
 *
 * This is not Trellis-specific: any stage run against a model already in the
 * viewport (retopo, rig, segment, texture) is phase 2 by definition, so the
 * studio behaves the same way everywhere.
 *
 * Honesty rules carried over: a real percentage only where the worker reports
 * steps, an indeterminate sweep where it genuinely cannot, elapsed time on long
 * stages, and cancellation reads as cancelled rather than failed.
 */
import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { Gen3dRole } from '../../electron/gen3d/gen3d-contract';
import { useGen3dStore } from './gen3d-client';
import { IcClose } from './icons';
import { useTripoStore } from './store';

/** Short chip label per stage, for the pipeline chain in the hero phase. */
const STAGE_CHIP: Record<Gen3dRole, string> = {
  image: 'Image',
  geometry: 'Geometry',
  texture: 'Texture',
  segment: 'Segment',
  retopo: 'Retopo',
  rig: 'Rig',
};

/** The chain shown for a job: a full generate run shows its whole pipeline so
 * the user can see what is still to come; a single stage op shows only itself. */
function chainFor(stage: Gen3dRole): readonly Gen3dRole[] {
  if (stage === 'image' || stage === 'geometry' || stage === 'texture') {
    return ['image', 'geometry', 'texture'];
  }
  return [stage];
}

const STAGE_TITLE: Record<Gen3dRole, string> = {
  image: 'Generating the source image',
  geometry: 'Building geometry',
  texture: 'Painting texture',
  segment: 'Segmenting parts',
  retopo: 'Rebuilding topology',
  rig: 'Fitting the skeleton',
};

/** What the user is waiting for, in one line, when there is no worker message. */
const STAGE_HINT: Record<Gen3dRole, string> = {
  image: 'Turning your prompt into a reference image.',
  geometry: 'Reconstructing a 3D surface from your image.',
  texture: 'Generating and baking PBR maps onto the mesh.',
  segment: 'Splitting the mesh into semantic parts.',
  retopo: 'Rebuilding the surface as clean quad topology.',
  rig: 'Measuring the shape and fitting joints to it.',
};

/** mm:ss since this job started. Null for the first few seconds — a timer on a
 * two-second stage is noise. */
function useElapsed(jobId: string | null, done: boolean): string | null {
  const [, force] = useState(0);
  const startRef = useRef<{ id: string; at: number } | null>(null);
  if (jobId !== null && startRef.current?.id !== jobId) {
    startRef.current = { id: jobId, at: Date.now() };
  }
  useEffect(() => {
    if (jobId === null || done) return;
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [jobId, done]);
  const start = startRef.current;
  if (start === null || jobId === null) return null;
  const secs = Math.max(0, Math.floor((Date.now() - start.at) / 1000));
  if (secs < 3) return null;
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s`;
}

function ProgressBar({
  percent,
  indeterminate,
  size,
}: {
  readonly percent: number;
  readonly indeterminate: boolean;
  readonly size: 'hero' | 'slim';
}): JSX.Element {
  return (
    <div
      className={`tp-genbar tp-genbar-${size}`}
      data-indeterminate={indeterminate}
      data-testid="tp-genbar"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      {...(indeterminate ? {} : { 'aria-valuenow': Math.round(percent) })}
    >
      <div
        className="tp-genbar-fill"
        style={indeterminate ? undefined : { width: `${Math.max(percent, 1.5)}%` }}
      />
    </div>
  );
}

export function GenStage(): JSX.Element | null {
  const job = useGen3dStore((s) => s.job);
  const modelReadyJobId = useGen3dStore((s) => s.modelReadyJobId);
  const cancelJob = useGen3dStore((s) => s.cancelJob);
  const clearJob = useGen3dStore((s) => s.clearJob);
  const loadedAssetId = useTripoStore((s) => s.loadedAssetId);
  const elapsed = useElapsed(job?.jobId ?? null, job?.done ?? true);

  // A finished job's bar should not sit over the result forever — but it must
  // stay long enough to actually read. Failures and cancellations never
  // auto-dismiss; the user closes those.
  useEffect(() => {
    if (job === null || !job.done || job.error !== undefined) return;
    const t = setTimeout(() => clearJob(), 6000);
    return () => clearTimeout(t);
  }, [job, clearJob]);

  if (job === null) return null;

  const cancelled = job.error === 'cancelled';
  const failed = job.error !== undefined && !cancelled;
  // Phase 2 the moment this job's model is on screen — either because the job
  // just produced it, or because the stage is running on a model that was
  // already loaded (every downstream stage).
  const showingModel = loadedAssetId !== null && (modelReadyJobId === job.jobId || !isBuildJob(job));
  const indeterminate = !job.done && job.stagePercent === 0 && job.overallPercent === 0;
  const title = failed
    ? `${STAGE_TITLE[job.stage]} failed`
    : cancelled
      ? 'Cancelled'
      : job.done
        ? 'Done'
        : STAGE_TITLE[job.stage];
  // The worker's last line is often just "Done", which would read as
  // "Done · Done" beside the title. Don't echo the title back.
  const rawDetail = job.message.length > 0 ? job.message : STAGE_HINT[job.stage];
  const detail = rawDetail.trim().toLowerCase() === title.trim().toLowerCase() ? '' : rawDetail;

  // ── phase 2: model on screen, progress collapses to a bottom bar ──────────
  if (showingModel || job.done || failed || cancelled) {
    return (
      <div
        className="tp-genfoot"
        data-testid="tp-genstage"
        data-phase={job.done || failed || cancelled ? 'end' : 'refining'}
        data-failed={failed}
      >
        <div className="tp-genfoot-row">
          <span className="tp-genfoot-title">{title}</span>
          <span className="tp-genfoot-msg" data-testid="tp-genstage-msg">
            {detail}
            {elapsed !== null && !job.done ? <span className="tp-genfoot-dim"> · {elapsed}</span> : null}
          </span>
          {!job.done && !failed && !cancelled && !indeterminate ? (
            <span className="tp-genfoot-pct">{Math.round(job.overallPercent)}%</span>
          ) : null}
          {job.done || failed || cancelled ? (
            <button
              type="button"
              className="tp-iconbtn"
              aria-label="Dismiss"
              data-testid="tp-genstage-dismiss"
              onClick={clearJob}
            >
              <IcClose size={14} />
            </button>
          ) : (
            <button
              type="button"
              className="tp-genfoot-cancel"
              data-testid="tp-genstage-cancel"
              onClick={() => void cancelJob()}
            >
              Cancel
            </button>
          )}
        </div>
        {!job.done && !failed && !cancelled ? (
          <ProgressBar percent={job.overallPercent} indeterminate={indeterminate} size="slim" />
        ) : null}
      </div>
    );
  }

  // ── phase 1: nothing to look at yet — take the whole viewport ─────────────
  return (
    <div className="tp-genhero" data-testid="tp-genstage" data-phase="building">
      <div className="tp-genhero-inner">
        <div className="tp-genhero-chips">
          {chainFor(job.stage).map((c) => {
            const chain = chainFor(job.stage);
            const at = chain.indexOf(job.stage);
            const i = chain.indexOf(c);
            return (
              <span
                key={c}
                className="tp-genhero-chip"
                data-state={i < at ? 'done' : i === at ? 'active' : 'todo'}
              >
                {STAGE_CHIP[c]}
              </span>
            );
          })}
        </div>
        <div className="tp-genhero-title" data-testid="tp-genstage-title">
          {title}
        </div>
        <ProgressBar percent={job.overallPercent} indeterminate={indeterminate} size="hero" />
        <div className="tp-genhero-meta">
          {!indeterminate ? (
            <span className="tp-genhero-pct">{Math.round(job.overallPercent)}%</span>
          ) : (
            <span className="tp-genhero-pct tp-genfoot-dim">working…</span>
          )}
          {elapsed !== null ? <span className="tp-genfoot-dim">{elapsed}</span> : null}
        </div>
        <div className="tp-genhero-msg" data-testid="tp-genstage-msg">
          {detail}
        </div>
        <button
          type="button"
          className="tp-genhero-cancel"
          data-testid="tp-genstage-cancel"
          onClick={() => void cancelJob()}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/** True for jobs that CREATE the model (so there is genuinely nothing to show
 * until geometry lands); false for stages that transform one already on screen. */
function isBuildJob(job: { readonly stage: Gen3dRole }): boolean {
  return job.stage === 'image' || job.stage === 'geometry';
}
