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
 * THE BAR ITSELF is chunked, one chunk per stage the job will really run, with
 * the stage's own word written above it — jedd: "instead of showing 'image
 * geometry texture' at the top which is confusing and explains nothing, why
 * don't you split the progressbar into a bunch of little chunks and then make
 * them green and show like 'texturing' while they're going, and then 'textured'
 * or 'modeled' above each after they finish". So the chips are gone: the label
 * IS the state ("Texturing" → "Textured"), the ticks fill as that stage runs,
 * and the whole chunk goes green when it lands. Which chunks appear comes from
 * the plan recorded at dispatch (gen3d-client), so a run from a supplied image
 * never shows an image chunk it will not run.
 *
 * Honesty rules carried over: a real percentage only where the worker reports
 * steps, an indeterminate sweep where it genuinely cannot, elapsed time on long
 * stages, and cancellation reads as cancelled rather than failed. The easing
 * (useEased) interpolates BETWEEN reported values only — it never runs ahead of
 * what the engine actually said.
 */
import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { Gen3dRole } from '../../electron/gen3d/gen3d-contract';
import { useGen3dStore } from './gen3d-client';
import { IcClose } from './icons';
import { useTripoStore } from './store';

/**
 * The label over each chunk of the bar: what is happening while it runs, and
 * what it produced once it is green. jedd: "show like 'texturing' while they're
 * going, and then 'textured' or 'modeled' above each after they finish" — the
 * word itself carries the state, so the row reads as a sentence about the run
 * rather than as a legend that has to be decoded.
 */
const STAGE_WORD: Record<Gen3dRole, { readonly doing: string; readonly done: string }> = {
  image: { doing: 'Drawing', done: 'Drawn' },
  geometry: { doing: 'Modeling', done: 'Modeled' },
  texture: { doing: 'Texturing', done: 'Textured' },
  segment: { doing: 'Segmenting', done: 'Segmented' },
  retopo: { doing: 'Remeshing', done: 'Remeshed' },
  rig: { doing: 'Rigging', done: 'Rigged' },
};

/** Ticks per chunk — enough to read as "filling", few enough to stay legible. */
const TICKS = { hero: 7, slim: 5 } as const;

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

/**
 * Eases a reported percentage into a continuous one.
 *
 * The workers report in jumps — a tqdm step is several percent, and the gap
 * between two of them can be seconds — so a bar driven straight off the report
 * sits frozen and then lurches. jedd: "why don't you interpolate the
 * progressbar". This walks toward whatever was last reported at a fixed rate,
 * so the movement is smooth and, crucially, still bounded by the truth: it
 * never runs past the reported value and never goes backwards inside a stage.
 */
function useEased(target: number, animate: boolean): number {
  const [shown, setShown] = useState(target);
  const shownRef = useRef(target);
  useEffect(() => {
    if (!animate) {
      shownRef.current = target;
      setShown(target);
      return;
    }
    let raf = 0;
    let last = performance.now();
    const step = (now: number): void => {
      const dt = Math.min(now - last, 100);
      last = now;
      const cur = shownRef.current;
      const gap = target - cur;
      if (Math.abs(gap) < 0.15) {
        shownRef.current = target;
        setShown(target);
        return;
      }
      // Backwards only happens between jobs/stages — snap, don't rewind.
      const next = gap < 0 ? target : cur + gap * (1 - Math.exp(-dt / 260));
      shownRef.current = next;
      setShown(next);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, animate]);
  return shown;
}

/**
 * True once the reported percentage has stood still for a while.
 *
 * Real stages go quiet for a long time: the PBR bake reports one line and then
 * works for a minute with no tqdm behind it. A bar that just stops moving reads
 * as hung, which is the same complaint the whole redesign is answering — so the
 * chunk being worked on says "still going" without inventing progress.
 */
function useStalled(percent: number, running: boolean, afterMs = 5000): boolean {
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    setStalled(false);
    if (!running) return;
    const t = setTimeout(() => setStalled(true), afterMs);
    return () => clearTimeout(t);
  }, [percent, running, afterMs]);
  return stalled;
}

/** One chunk of the bar: a row of ticks that fill left to right, green once the
 * stage behind them is finished. */
function Chunk({
  role,
  state,
  percent,
  size,
  indeterminate,
  stalled,
}: {
  readonly role: Gen3dRole;
  readonly state: 'done' | 'active' | 'todo';
  readonly percent: number;
  readonly size: 'hero' | 'slim';
  readonly indeterminate: boolean;
  readonly stalled: boolean;
}): JSX.Element {
  const n = TICKS[size];
  const word = STAGE_WORD[role];
  // The tick the stage is currently inside — the one that pulses when the
  // worker goes quiet.
  const leading = Math.min(n - 1, Math.floor((percent / 100) * n));
  return (
    <div className="tp-chunk" data-state={state} data-testid={`tp-chunk-${role}`}>
      <span className="tp-chunk-label" data-testid={`tp-chunk-label-${role}`}>
        {state === 'done' ? word.done : word.doing}
      </span>
      <div className="tp-chunk-ticks" data-indeterminate={indeterminate && state === 'active'}>
        {Array.from({ length: n }, (_, i) => {
          // Each tick owns an equal slice of the chunk; its fill is how far the
          // stage has come into that slice.
          const fill = Math.max(0, Math.min(1, (percent / 100) * n - i));
          return (
            <span
              className="tp-chunk-tick"
              key={i}
              data-pulse={stalled && state === 'active' && i === leading}
              style={{ ['--tp-tick' as string]: fill }}
            >
              <span className="tp-chunk-tick-fill" />
            </span>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The whole bar: one chunk per stage this job will actually run.
 *
 * The percentage is derived FROM the chunks — (finished chunks + how far into
 * the active one) / total — rather than taken from the engine's own overall
 * figure. jedd: "that progressbar makes no sense", and it didn't: the engine's
 * overall is weighted by expected stage cost, so the hero showed a Modeling
 * chunk filled to its last tick sitting next to "65%". One of those had to go,
 * and the chunks are the thing the user is actually looking at.
 *
 * `onPercent` hands the derived number back up so the readouts agree with the
 * bar by construction instead of by coincidence.
 */
function ChunkedProgress({
  stages,
  current,
  percent,
  indeterminate,
  size,
  onPercent,
}: {
  readonly stages: readonly Gen3dRole[];
  readonly current: Gen3dRole;
  readonly percent: number;
  readonly indeterminate: boolean;
  readonly size: 'hero' | 'slim';
  readonly onPercent?: (value: number) => void;
}): JSX.Element {
  // A plan that does not contain the running stage cannot describe this job
  // (a restored window, or an engine that inserted a stage) — show what is
  // actually running rather than a chain with nothing highlighted.
  const plan = stages.includes(current) ? stages : [current];
  const at = plan.indexOf(current);
  // A RUNNING stage never fills its last tick. A full row of blue next to a
  // label still in the present tense reads as stuck; full means green means
  // done, with no exceptions, so the chunk can only complete by advancing.
  const eased = Math.min(useEased(percent, !indeterminate), 94);
  const stalled = useStalled(percent, !indeterminate);
  const derived = ((at + eased / 100) / plan.length) * 100;
  useEffect(() => {
    onPercent?.(derived);
  }, [derived, onPercent]);
  return (
    <div
      className={`tp-chunks tp-chunks-${size}`}
      data-testid="tp-genbar"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={`${STAGE_WORD[current].doing}, stage ${at + 1} of ${plan.length}`}
      {...(indeterminate ? {} : { 'aria-valuenow': Math.round(derived) })}
    >
      {plan.map((role, i) => (
        <Chunk
          key={role}
          role={role}
          // A stage the engine has moved past is finished, whatever its last
          // reported percent was (workers stop reporting before they hand off).
          state={i < at ? 'done' : i === at ? 'active' : 'todo'}
          percent={i < at ? 100 : i === at ? eased : 0}
          size={size}
          indeterminate={indeterminate}
          stalled={stalled}
        />
      ))}
    </div>
  );
}

export function GenStage(): JSX.Element | null {
  const job = useGen3dStore((s) => s.job);
  const jobPlan = useGen3dStore((s) => s.jobPlan);
  const modelReadyJobId = useGen3dStore((s) => s.modelReadyJobId);
  const cancelJob = useGen3dStore((s) => s.cancelJob);
  const clearJob = useGen3dStore((s) => s.clearJob);
  const loadedAssetId = useTripoStore((s) => s.loadedAssetId);
  const elapsed = useElapsed(job?.jobId ?? null, job?.done ?? true);
  // The bar owns the number; the readouts follow it. See ChunkedProgress.
  const [shownPercent, setShownPercent] = useState(0);

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
  // The heading is about the JOB; the chunks say which stage. Naming the stage
  // here too gave "Building geometry" as a title over a chunk labelled
  // "Modeling" — the same fact twice, in two vocabularies. A failure still has
  // to name what failed, so that case keeps the stage.
  const title = failed
    ? `${STAGE_TITLE[job.stage]} failed`
    : cancelled
      ? 'Cancelled'
      : job.done
        ? 'Done'
        : isBuildJob(job) || job.stage === 'texture'
          ? 'Building your model'
          : STAGE_TITLE[job.stage];
  // The worker's last line is often just "Done", which would read as
  // "Done · Done" beside the title. Don't echo the title back.
  const rawDetail = job.message.length > 0 ? job.message : STAGE_HINT[job.stage];
  const detail = rawDetail.trim().toLowerCase() === title.trim().toLowerCase() ? '' : rawDetail;
  const stages = jobPlan?.jobId === job.jobId ? jobPlan.stages : [job.stage];
  const bar = (size: 'hero' | 'slim'): JSX.Element => (
    <ChunkedProgress
      stages={stages}
      current={job.stage}
      percent={job.stagePercent > 0 ? job.stagePercent : job.overallPercent}
      indeterminate={indeterminate}
      size={size}
      onPercent={setShownPercent}
    />
  );

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
            <span className="tp-genfoot-pct">{Math.round(shownPercent)}%</span>
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
        {!job.done && !failed && !cancelled ? bar('slim') : null}
      </div>
    );
  }

  // ── phase 1: nothing to look at yet — take the whole viewport ─────────────
  return (
    <div className="tp-genhero" data-testid="tp-genstage" data-phase="building">
      <div className="tp-genhero-inner">
        <div className="tp-genhero-title" data-testid="tp-genstage-title">
          {title}
        </div>
        {bar('hero')}
        <div className="tp-genhero-meta">
          {!indeterminate ? (
            <span className="tp-genhero-pct">{Math.round(shownPercent)}%</span>
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
