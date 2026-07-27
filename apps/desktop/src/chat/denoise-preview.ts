/**
 * The live-denoising placeholder's state: real intermediate frames in, plus a
 * continuous `resolve` value the animation can read on every rAF tick.
 *
 * ## Why a reducer and not just an event handler
 * A 4-step Mage-Flow-Turbo run gives the UI FIVE frames over about five
 * seconds, after roughly eleven seconds of silent model loading (MEASURED — see
 * mlx_image_worker's PREVIEW_MAX_PX block). Painting only what arrives would be
 * a card that sits perfectly still for eleven seconds, then twitches five times.
 * So the frames are the truth and {@link resolveAt} is the tween BETWEEN them:
 * it extrapolates from the cadence measured so far, which is what lets blur,
 * grain and colour move continuously while the model is mid-step.
 *
 * Everything here is pure and clock-injected so it can be tested without a
 * renderer, a sidecar, or a GPU.
 */

import type { Gen3dJobPreview } from '../../electron/gen3d/gen3d-contract';

/** One real decoded frame, stamped with when the UI actually received it. */
export interface DenoiseFrame {
  /** `data:image/jpeg;base64,…` — UI-only; never written anywhere durable. */
  readonly dataUri: string;
  readonly step: number;
  readonly totalSteps: number;
  /** Arrival time on the renderer's clock (ms). */
  readonly at: number;
}

export interface DenoiseState {
  /** The engine job these frames belong to, or null when nothing is running. */
  readonly jobId: string | null;
  /** Newest LAST. Only the last two are ever drawn, but the arrival times of
   * all of them are what make the cadence estimate stable. */
  readonly frames: readonly DenoiseFrame[];
  /** width / height of the image being made. 1 until the first frame says. */
  readonly aspect: number;
  /** Set when the job ends, so the card can land on 1.0 instead of stalling
   * wherever the extrapolation happened to be. */
  readonly finishedAt: number | null;
}

export const EMPTY_DENOISE: DenoiseState = {
  jobId: null,
  frames: [],
  aspect: 1,
  finishedAt: null,
};

/**
 * Seed cadence before two frames exist to measure one from.
 *
 * MEASURED on this machine at 1024px/4 steps: frames landed 1.27, 1.28, 1.25
 * and 1.48 s apart. 1300 ms is the middle of that, so the very first gap is
 * tweened at close to the rate the following ones actually run at.
 */
export const SEED_CADENCE_MS = 1300;

/** Cadence estimates outside this range are the engine hiccuping (a slow first
 * decode, a stalled write), not the sampler's real rate. Clamping stops one
 * outlier from freezing the tween or making it sprint. */
const MIN_CADENCE_MS = 250;
const MAX_CADENCE_MS = 6000;

/**
 * How far into the NEXT step the tween may run before that step actually
 * arrives. Short of 1.0 on purpose: the extrapolation should walk right up to
 * the next frame and wait there, never past it, so a real frame always lands on
 * an unfinished card and has something visible left to deliver.
 */
const LOOKAHEAD = 0.92;

/** Ease the raw 0..1 position so the last stretch — where a turbo model does
 * most of its visible work — is not rushed. */
function ease(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return 1 - (1 - c) ** 1.7;
}

/** Fold one preview frame in, starting a new run when the job id changes. */
export function noteFrame(
  state: DenoiseState,
  jobId: string,
  preview: Gen3dJobPreview,
  now: number,
): DenoiseState {
  const fresh = state.jobId !== jobId;
  const base = fresh ? EMPTY_DENOISE : state;
  const aspect =
    preview.width > 0 && preview.height > 0 ? preview.width / preview.height : base.aspect;
  return {
    jobId,
    aspect,
    finishedAt: null,
    frames: [
      ...base.frames,
      {
        dataUri: preview.dataUri,
        step: preview.step,
        totalSteps: Math.max(1, preview.totalSteps),
        at: now,
      },
    ],
  };
}

/** The job ended (or failed). Frames are kept so the card can land on the last
 * one instead of blinking back to the idle texture on the final tick. */
export function noteDone(state: DenoiseState, jobId: string, now: number): DenoiseState {
  if (state.jobId !== jobId) return state;
  return { ...state, finishedAt: now };
}

/** Clear everything — a new tool call starting, or the placeholder unmounting. */
export function resetDenoise(): DenoiseState {
  return EMPTY_DENOISE;
}

/** The mean gap between the frames seen so far, or the seed when there is
 * nothing to measure yet. */
export function cadenceMs(frames: readonly DenoiseFrame[]): number {
  if (frames.length < 2) return SEED_CADENCE_MS;
  const first = frames[0];
  const last = frames[frames.length - 1];
  if (first === undefined || last === undefined) return SEED_CADENCE_MS;
  const mean = (last.at - first.at) / (frames.length - 1);
  return Math.max(MIN_CADENCE_MS, Math.min(MAX_CADENCE_MS, mean));
}

/**
 * How resolved the picture should look right now, 0..1 — the value the
 * animation reads on every frame.
 *
 * The tween lives BETWEEN the real steps: from the last frame's step it walks
 * forward at the measured cadence, capped {@link LOOKAHEAD} short of the next
 * step so it never overtakes reality. That is the whole point — with frames
 * ~1.3 s apart, a plain crossfade would leave the card motionless for most of
 * every gap, which reads as a hang rather than as work.
 */
export function resolveAt(state: DenoiseState, now: number): number {
  if (state.finishedAt !== null) return 1;
  const frames = state.frames;
  const last = frames[frames.length - 1];
  if (last === undefined) return 0;
  const total = last.totalSteps;
  const elapsedSteps = (now - last.at) / cadenceMs(frames);
  const position = last.step + Math.max(0, Math.min(LOOKAHEAD, elapsedSteps));
  return ease(Math.min(1, position / total));
}

/** The frame to paint, and the one under it during a reveal. */
export function visibleFrames(state: DenoiseState): {
  readonly current: DenoiseFrame | undefined;
  readonly previous: DenoiseFrame | undefined;
} {
  const n = state.frames.length;
  return { current: state.frames[n - 1], previous: state.frames[n - 2] };
}
