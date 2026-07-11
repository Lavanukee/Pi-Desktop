/**
 * Pure display logic for the round-12 composer bar (jedd #6), split out so it is
 * unit-testable in the node desktop test env (ComposerBar.tsx itself pulls React
 * + the canvas ProjectPicker + zustand hooks). Maps:
 *   - the harness `activeTier` → the CENTER tier label (via TIER_LABEL),
 *   - the harness `activeClass` → the hover copy "request categorized as …",
 *   - `effortMode` + `effort` + `activeTier` → the RIGHT effort readout
 *     ("Effort · <Level>": the auto level resolved from the tier, or the
 *     explicit level), mirroring the model chip's "Auto · <Tier>".
 *
 * The harness stays 4-level; Auto ↔ tier resolution lives entirely here + in
 * `state/model-selection` (imported, not redefined).
 */
// Import from the harness SOURCE module, NOT the '@pi-desktop/harness' barrel:
// value-importing from the barrel (TIER_LABEL) drags the pi SDK →
// @mistralai/@opentelemetry into the renderer bundle and breaks `vite build`
// (matches auto-router.ts's source-import fix). Types from the barrel are fine
// (erased at build).
import { type ModelTier, TIER_LABEL } from '../../../../packages/harness/src/classify/tier.ts';
import type { EffortLevel, EffortMode } from '../../electron/settings/settings-contract';
import { autoEffortForTier, EFFORT_STEPS, levelToSlider } from '../state/model-selection';
import { classLabel } from './harness-status';

/** The number of effort detents the slider snaps to (low/medium/high/max). */
export const EFFORT_STEP_COUNT = EFFORT_STEPS.length;

/** CENTER: the user-facing tier label (Fast/Balanced/Intelligent), or null
 * before the classifier has run this session. */
export function tierLabel(tier: ModelTier | null): string | null {
  return tier === null ? null : TIER_LABEL[tier];
}

/** CENTER hover: "request categorized as basic tools", or null with no class. */
export function classificationHover(activeClass: string | null | undefined): string | null {
  const cls = classLabel(activeClass ?? null);
  return cls === null ? null : `request categorized as ${cls}`;
}

/**
 * Display names for the 4-level effort scale. The mid detent (the auto-resolved
 * default for the balanced tier) reads "Balanced" so the effort readout
 * ("Effort · Balanced") mirrors the model chip's "Auto · Balanced". The
 * underlying effort values/logic stay low/medium/high/max — this is display only.
 */
const EFFORT_DISPLAY: Record<EffortLevel, string> = {
  low: 'Low',
  medium: 'Balanced',
  high: 'High',
  max: 'Max',
};

/** The user-facing display name for an effort level (e.g. `medium` → "Balanced"). */
export function effortDisplay(level: EffortLevel): string {
  return EFFORT_DISPLAY[level];
}

/** Everything the {@link EffortSlider} needs, derived from settings + the tier. */
export interface EffortSliderView {
  /** Auto mode: the readout follows the tier's auto level and a drag flips to a
   * pinned level; either way the label reads "Effort · <Level>". */
  readonly auto: boolean;
  /** The explicit detent index (0..EFFORT_STEP_COUNT-1) for aria + keyboard. */
  readonly index: number;
  /** Fill fraction (0..1): auto → the tier's auto level; level → the level. */
  readonly fill: number;
  /** Labeled two-part readout: "Effort · Balanced" / "Effort · High" / "Effort · Max". */
  readonly label: string;
  /** Screen-reader value text. */
  readonly valueText: string;
}

/**
 * Resolve the slider surface. In Auto the fill follows the active tier
 * (fast→min, balanced→mid, intelligent→the tick below max via
 * `autoEffortForTier`); with no tier yet it rests on the last explicit level.
 * In level mode it pins the explicit level (max is only reachable here, by an
 * explicit drag). The readout is always the labeled two-part "Effort · <Level>"
 * (the word "Effort" is kept next to the control), mirroring the model chip's
 * "Auto · <Tier>" — the mid/auto default reads "Effort · Balanced".
 */
export function effortSliderView(
  effortMode: EffortMode,
  effort: EffortLevel,
  activeTier: ModelTier | null,
): EffortSliderView {
  if (effortMode === 'auto') {
    // The readout names the EFFORT LEVEL the tier resolves to (Low/Balanced/
    // High), not the tier itself — "Effort · Balanced", not "Effort · balanced".
    // Before the classifier runs (no tier) it rests on the explicit level.
    const level = activeTier !== null ? autoEffortForTier(activeTier) : effort;
    const index = Math.max(0, EFFORT_STEPS.indexOf(level));
    const fill = levelToSlider(level);
    const display = effortDisplay(level);
    return {
      auto: true,
      index,
      fill,
      label: `Effort · ${display}`,
      valueText: `Effort, ${display}`,
    };
  }
  const index = Math.max(0, EFFORT_STEPS.indexOf(effort));
  const fill = levelToSlider(effort);
  const display = effortDisplay(effort);
  return { auto: false, index, fill, label: `Effort · ${display}`, valueText: `${display} effort` };
}

/** Map a detent index the slider emits back to its effort level. */
export function levelForIndex(index: number): EffortLevel {
  const clamped = Math.min(EFFORT_STEPS.length - 1, Math.max(0, index));
  return EFFORT_STEPS[clamped] as EffortLevel;
}
