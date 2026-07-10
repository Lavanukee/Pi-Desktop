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
  /** VLM image-refine iterations for high-quality gen mode (v0.2 gen pillar). */
  readonly imageRefinePasses: number;
}

const KNOBS: Record<EffortLevel, EffortKnobs> = {
  low: {
    level: 'low',
    repairAttempts: 1,
    abortThreshold: 2,
    reviewPasses: 0,
    adversarialChecks: false,
    imageRefinePasses: 1,
  },
  medium: {
    level: 'medium',
    repairAttempts: 2,
    abortThreshold: 3,
    reviewPasses: 1,
    adversarialChecks: false,
    imageRefinePasses: 2,
  },
  high: {
    level: 'high',
    repairAttempts: 3,
    abortThreshold: 4,
    reviewPasses: 2,
    adversarialChecks: true,
    imageRefinePasses: 3,
  },
  max: {
    level: 'max',
    repairAttempts: 5,
    abortThreshold: 6,
    reviewPasses: 3,
    adversarialChecks: true,
    imageRefinePasses: 4,
  },
};

/** The full knob table (readonly). */
export const EFFORT_KNOBS: Readonly<Record<EffortLevel, EffortKnobs>> = KNOBS;

/** Resolve the reliability knobs for an effort level. */
export function effortKnobs(level: EffortLevel): EffortKnobs {
  return KNOBS[level];
}
