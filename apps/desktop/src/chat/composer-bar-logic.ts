/**
 * Pure display logic for the round-12 composer bar (jedd #6), split out so it is
 * unit-testable in the node desktop test env (ComposerBar.tsx itself pulls React
 * + the canvas ProjectPicker + zustand hooks). Maps:
 *   - the harness `activeTier` → the CENTER tier label (via TIER_LABEL),
 *   - the harness `activeClass` → the hover copy "request categorized as …",
 *   - `effortMode` + `effort` + `activeTier` → the RIGHT effort-slider view
 *     ("Auto · <tier>" fill from the tier, or an explicit level).
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

function capitalize(word: string): string {
  return word.length === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1);
}

/** Everything the {@link EffortSlider} needs, derived from settings + the tier. */
export interface EffortSliderView {
  /** Auto mode: the readout is "Auto · <tier>" and a drag flips to a level. */
  readonly auto: boolean;
  /** The explicit detent index (0..EFFORT_STEP_COUNT-1) for aria + keyboard. */
  readonly index: number;
  /** Fill fraction (0..1): auto → the tier's auto level; level → the level. */
  readonly fill: number;
  /** Active-mode readout: "Auto · balanced" / "Auto" (no tier yet) / "High". */
  readonly label: string;
  /** Screen-reader value text. */
  readonly valueText: string;
}

/**
 * Resolve the slider surface. In Auto the fill follows the active tier
 * (fast→min, balanced→mid, intelligent→the tick below max via
 * `autoEffortForTier`); with no tier yet it rests on the last explicit level
 * and reads plain "Auto". In level mode it pins the explicit level (max is only
 * reachable here, by an explicit drag).
 */
export function effortSliderView(
  effortMode: EffortMode,
  effort: EffortLevel,
  activeTier: ModelTier | null,
): EffortSliderView {
  if (effortMode === 'auto') {
    const level = activeTier !== null ? autoEffortForTier(activeTier) : effort;
    const index = Math.max(0, EFFORT_STEPS.indexOf(level));
    const fill = levelToSlider(level);
    return activeTier !== null
      ? { auto: true, index, fill, label: `Auto · ${activeTier}`, valueText: `Auto, ${activeTier}` }
      : { auto: true, index, fill, label: 'Auto', valueText: 'Auto' };
  }
  const index = Math.max(0, EFFORT_STEPS.indexOf(effort));
  const fill = levelToSlider(effort);
  const label = capitalize(effort);
  return { auto: false, index, fill, label, valueText: `${label} effort` };
}

/** Map a detent index the slider emits back to its effort level. */
export function levelForIndex(index: number): EffortLevel {
  const clamped = Math.min(EFFORT_STEPS.length - 1, Math.max(0, index));
  return EFFORT_STEPS[clamped] as EffortLevel;
}
