/**
 * Unit coverage for the live-denoise state machine.
 *
 * The properties that actually matter to the animation, and each of which was a
 * real way to get it wrong:
 *   - the tween MOVES between real frames (the whole reason it exists);
 *   - it never overtakes the next real step;
 *   - it is monotonic — the card must never un-resolve;
 *   - a new job id starts from noise instead of inheriting the last picture;
 *   - the cadence is learned from arrivals, not assumed.
 */
import { describe, expect, it } from 'vitest';
import {
  cadenceMs,
  type DenoiseState,
  EMPTY_DENOISE,
  noteDone,
  noteFrame,
  resolveAt,
  SEED_CADENCE_MS,
  visibleFrames,
} from './denoise-preview';

function preview(step: number, total = 4, width = 1024, height = 1024) {
  return { dataUri: `data:image/jpeg;base64,f${step}`, step, totalSteps: total, width, height };
}

/** A run of `count` frames landing `gap` ms apart, starting at `t0`. */
function run(count: number, gap = 1300, t0 = 1000): DenoiseState {
  let s = EMPTY_DENOISE;
  for (let i = 0; i < count; i++) s = noteFrame(s, 'job-a', preview(i), t0 + i * gap);
  return s;
}

describe('denoise state', () => {
  it('starts empty and unresolved', () => {
    expect(resolveAt(EMPTY_DENOISE, 0)).toBe(0);
    expect(visibleFrames(EMPTY_DENOISE).current).toBeUndefined();
  });

  it('takes the aspect ratio from the frame, not from a guess', () => {
    const s = noteFrame(EMPTY_DENOISE, 'job-a', preview(0, 4, 1024, 768), 0);
    expect(s.aspect).toBeCloseTo(1024 / 768, 5);
  });

  it('keeps a bad aspect from the engine out of the layout', () => {
    const s = noteFrame(EMPTY_DENOISE, 'job-a', preview(0, 4, 0, 0), 0);
    expect(s.aspect).toBe(1);
  });

  it('starts a fresh run when the job id changes', () => {
    const first = run(3);
    const second = noteFrame(first, 'job-b', preview(0), 99_999);
    expect(second.frames).toHaveLength(1);
    expect(second.jobId).toBe('job-b');
    // A second generation in the same turn must begin at noise, not carry the
    // previous picture forward while the new one loads.
    expect(resolveAt(second, 99_999)).toBeCloseTo(0, 5);
  });

  it('exposes the newest frame and the one beneath it', () => {
    const { current, previous } = visibleFrames(run(3));
    expect(current?.step).toBe(2);
    expect(previous?.step).toBe(1);
  });
});

describe('cadence', () => {
  it('uses the seed until there are two arrivals to measure', () => {
    expect(cadenceMs([])).toBe(SEED_CADENCE_MS);
    expect(cadenceMs(run(1).frames)).toBe(SEED_CADENCE_MS);
  });

  it('learns the real cadence from arrival times', () => {
    expect(cadenceMs(run(5, 800).frames)).toBeCloseTo(800, 5);
    expect(cadenceMs(run(5, 2200).frames)).toBeCloseTo(2200, 5);
  });

  it('clamps an outlier so one stall cannot freeze or sprint the tween', () => {
    expect(cadenceMs(run(2, 60_000).frames)).toBeLessThanOrEqual(6000);
    expect(cadenceMs(run(2, 1).frames)).toBeGreaterThanOrEqual(250);
  });
});

describe('the tween between real steps', () => {
  it('keeps moving while no new frame arrives', () => {
    // The requirement in one assertion: with frames ~1.3 s apart, the card must
    // not sit still in the gap.
    const s = run(2);
    const t = 1000 + 1300; // the moment frame 1 landed
    const a = resolveAt(s, t);
    const b = resolveAt(s, t + 400);
    const c = resolveAt(s, t + 900);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it('never overtakes the step that has not happened yet', () => {
    const s = run(2); // last real step is 1 of 4
    const far = resolveAt(s, 10_000_000);
    // Capped short of step 2/4 = 0.5 raw. Eased, but still strictly under what
    // step 2 itself would show.
    const atStepTwo = resolveAt(noteFrame(s, 'job-a', preview(2), 3600), 3600);
    expect(far).toBeLessThan(atStepTwo);
  });

  it('is monotonic across a whole run — the card never un-resolves', () => {
    let s = EMPTY_DENOISE;
    let last = -1;
    for (let i = 0; i < 5; i++) {
      const at = 1000 + i * 1300;
      s = noteFrame(s, 'job-a', preview(i), at);
      for (let dt = 0; dt < 1300; dt += 100) {
        const v = resolveAt(s, at + dt);
        expect(v).toBeGreaterThanOrEqual(last - 1e-9);
        last = v;
      }
    }
  });

  it('lands exactly on 1 when the job finishes', () => {
    const s = noteDone(run(3), 'job-a', 9999);
    expect(resolveAt(s, 9999)).toBe(1);
    expect(resolveAt(s, 20_000)).toBe(1);
  });

  it('ignores a done for a different job', () => {
    const s = noteDone(run(3), 'other-job', 9999);
    expect(s.finishedAt).toBeNull();
  });

  it('reaches full resolve on the final step', () => {
    const s = run(5); // steps 0..4 of 4
    expect(resolveAt(s, 1000 + 4 * 1300)).toBeCloseTo(1, 5);
  });
});
