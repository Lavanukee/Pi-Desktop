/**
 * Pure display logic for the round-12 composer bar (jedd #6), split out so it is
 * unit-testable in the node desktop test env (ComposerBar.tsx itself pulls React
 * + the canvas ProjectPicker + zustand hooks). Maps:
 *   - the harness `activeTier` → the CENTER tier label (via TIER_LABEL),
 *   - the harness `activeClass` → the hover copy "request categorized as …",
 *   - `effortMode` + `effort` + `activeTier` → the RIGHT effort readout: "Effort ·
 *     Auto" in auto mode (the word "Auto", mirroring the model chip), or "Effort ·
 *     <Level>" when an explicit level is pinned. The tier still drives the slider
 *     POSITION in auto so the knob rests where routing would land.
 *
 * The harness stays 4-level; Auto ↔ tier resolution lives entirely here + in
 * `state/model-selection` (imported, not redefined).
 */
// Import from the harness SOURCE module, NOT the '@pi-desktop/harness' barrel:
// value-importing from the barrel (TIER_LABEL) drags the pi SDK →
// @mistralai/@opentelemetry into the renderer bundle and breaks `vite build`
// (matches auto-router.ts's source-import fix). Types from the barrel are fine
// (erased at build).
import type { ChatMsg } from '@pi-desktop/engine';
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
  /** Auto mode: the slider POSITION follows the tier's auto level and a drag flips
   * to a pinned level; the label reads the word "Effort · Auto". */
  readonly auto: boolean;
  /** The explicit detent index (0..EFFORT_STEP_COUNT-1) for aria + keyboard. */
  readonly index: number;
  /** Fill fraction (0..1): auto → the tier's auto level; level → the level. */
  readonly fill: number;
  /** Labeled readout: "Effort · Auto" (auto) or "Effort · Balanced/High/Max" (level). */
  readonly label: string;
  /** Screen-reader value text. */
  readonly valueText: string;
}

/**
 * Resolve the slider surface. In Auto the fill follows the active tier
 * (fast→min, balanced→mid, intelligent→the tick below max via
 * `autoEffortForTier`); with no tier yet it rests on the last explicit level. The
 * Auto readout is the literal "Effort · Auto" (mirroring the model chip's Auto),
 * while the slider position still shows where routing would land. In level mode it
 * pins the explicit level and reads "Effort · <Level>" (max is only reachable
 * here, by an explicit drag).
 */
export function effortSliderView(
  effortMode: EffortMode,
  effort: EffortLevel,
  activeTier: ModelTier | null,
): EffortSliderView {
  if (effortMode === 'auto') {
    // In Auto the readout says the literal word "Auto" ("Effort · Auto"), NOT the
    // resolved level — Auto means "let routing pick the effort", mirroring the
    // model chip's Auto. The tier still drives the slider POSITION (index/fill)
    // via `autoEffortForTier` so the knob rests where routing would land; before
    // the classifier runs (no tier) it rests on the last explicit level.
    const level = activeTier !== null ? autoEffortForTier(activeTier) : effort;
    const index = Math.max(0, EFFORT_STEPS.indexOf(level));
    const fill = levelToSlider(level);
    return {
      auto: true,
      index,
      fill,
      label: 'Effort · Auto',
      valueText: 'Effort, Auto',
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

/** The context-fullness ring's derived value (round-A #5 — the ring moved from the
 * input-bar footer to the LEFT of Effort on this bar). */
export interface ContextGaugeView {
  /** Fullness fraction 0..1 (used tokens / launched context window). */
  readonly value: number;
  /** Tokens used in the most recent measured turn (for the tooltip copy). */
  readonly usedTokens: number;
}

/**
 * Derive the context-fullness ring from the most recent assistant turn's total
 * tokens over the launched model's context window. Returns null when no turn has
 * usage yet or the window is unknown (0) — the ring simply doesn't render. Pure +
 * node-testable; ComposerBar renders the result to the left of the Effort button.
 */
export function deriveContextGauge(
  messages: readonly ChatMsg[],
  contextWindow: number,
): ContextGaugeView | null {
  if (contextWindow <= 0) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.kind === 'assistant' && m.usage !== undefined) {
      const usedTokens = m.usage.totalTokens;
      return { value: Math.min(1, usedTokens / contextWindow), usedTokens };
    }
  }
  return null;
}
