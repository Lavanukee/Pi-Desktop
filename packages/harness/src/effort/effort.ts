/**
 * Effort slider → reliability knobs.
 *
 * The Claude-style effort slider (low / medium / high / max) maps to concrete
 * reliability settings the rest of the harness reads. This is exposed as a
 * typed config so other workstreams (provider repair ladder, gen-refine loops,
 * review passes) consume the same shape. The observable v0.1 knob is the repair
 * ladder's `repairAttempts` / `abortThreshold` (wired into rung 5).
 */

export type EffortLevel = 'low' | 'medium' | 'high' | 'max';

export const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'max'];

export function isEffortLevel(v: string): v is EffortLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(v);
}

export interface EffortKnobs {
  readonly level: EffortLevel;
  /**
   * Extra repair/fixer attempts before giving up on a malformed tool call.
   * Feeds the repair ladder; higher effort tolerates more retries.
   */
  readonly repairAttempts: number;
  /**
   * Unrepairable-failure count at which rung 5 aborts. Higher effort persists
   * longer before terminating. (Observable knob wired into the repair rungs.)
   */
  readonly abortThreshold: number;
  /** Extra self-review passes after producing an answer/edit. */
  readonly reviewPasses: number;
  /** Whether to run adversarial checks (e.g. try to break the produced output). */
  readonly adversarialChecks: boolean;
  /**
   * Hard per-turn tool-call cap — a generous backstop the loop detector aborts
   * on when a turn burns through this many tool calls without finishing. Scales
   * with effort so a "max" run is allowed to grind much longer than a "low" one.
   */
  readonly maxTurnSteps: number;
  /**
   * Whether the effort-gated REAL verify runs: after the model signals it is done
   * on a coding/file-ops turn, run the project's own checks (test/typecheck/lint)
   * in the working dir and feed failures back as a fix steer. On at high/max.
   */
  readonly realVerify: boolean;
  /**
   * Bound on how many times the REAL verify may feed a failing check back to the
   * model for a fix within one user turn (so it can't loop forever). 0 disables.
   */
  readonly verifyFixAttempts: number;
  /**
   * VLM image-refine iterations for high-quality gen mode. RESERVED: defined and
   * covered by the monotonic effort test, but not yet consumed anywhere — the gen
   * pillars (image/video/3D) land on the `modalities` branch and will read this
   * knob to bound their refine loop. Left in the table so the effort contract is
   * stable for that wave; remove the "reserved" note once a gen path consumes it.
   */
  readonly imageRefinePasses: number;
}

const KNOBS: Record<EffortLevel, EffortKnobs> = {
  low: {
    level: 'low',
    repairAttempts: 1,
    abortThreshold: 2,
    reviewPasses: 0,
    adversarialChecks: false,
    maxTurnSteps: 24,
    realVerify: false,
    verifyFixAttempts: 0,
    imageRefinePasses: 1,
  },
  medium: {
    level: 'medium',
    repairAttempts: 2,
    abortThreshold: 3,
    reviewPasses: 1,
    adversarialChecks: false,
    maxTurnSteps: 40,
    realVerify: false,
    verifyFixAttempts: 0,
    imageRefinePasses: 2,
  },
  high: {
    level: 'high',
    repairAttempts: 3,
    abortThreshold: 4,
    reviewPasses: 2,
    adversarialChecks: true,
    maxTurnSteps: 60,
    realVerify: true,
    verifyFixAttempts: 1,
    imageRefinePasses: 3,
  },
  max: {
    level: 'max',
    repairAttempts: 5,
    abortThreshold: 6,
    reviewPasses: 3,
    adversarialChecks: true,
    maxTurnSteps: 100,
    realVerify: true,
    verifyFixAttempts: 2,
    imageRefinePasses: 4,
  },
};

/** The full knob table (readonly). */
export const EFFORT_KNOBS: Readonly<Record<EffortLevel, EffortKnobs>> = KNOBS;

/** Resolve the reliability knobs for an effort level. */
export function effortKnobs(level: EffortLevel): EffortKnobs {
  return KNOBS[level];
}
