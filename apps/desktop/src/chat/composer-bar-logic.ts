/**
 * Pure display logic for the round-12 composer bar (jedd #6), split out so it is
 * unit-testable in the node desktop test env (ComposerBar.tsx itself pulls React
 * + the canvas ProjectPicker + zustand hooks). Maps:
 *   - the harness `activeTier` → the CENTER tier label (via TIER_LABEL),
 *   - the harness `activeClass` → the hover copy "request categorized as …",
 *   - `effortMode` + `effort` + `activeTier` → the RIGHT effort readout: "Effort ·
 *     Adaptive" in auto mode, or "Effort · <Level>" when an explicit level is
 *     pinned. The tier still drives the slider POSITION in auto so the knob rests
 *     where routing would land. (jedd #12: the auto readout says "Adaptive", NOT
 *     "Auto", so it never collides with the model chip's "Auto" — the two chips
 *     name clearly distinct axes, model vs effort, instead of two bare "Auto"s.)
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

/** Matches a working dir that lives inside the per-conversation sandbox root
 * `~/.pi/desktop/sandbox/<id>/` — home-independent so it holds wherever `$HOME`
 * is. Used by {@link usesSandbox} to detect the missing-project fallback. */
const SANDBOX_CWD = /(^|\/)\.pi\/desktop\/sandbox(\/|$)/;

/** True when a working dir is (inside) the per-conversation sandbox — such chats
 * are NOT auto-grouped into a folder (jedd: sandbox chats stay ungrouped unless
 * manually assigned). Empty/unknown cwds are treated as sandbox-like (ungrouped). */
export function isSandboxCwd(cwd: string | null | undefined): boolean {
  if (cwd === null || cwd === undefined || cwd === '') return true;
  return SANDBOX_CWD.test(cwd);
}

/**
 * LEFT (jedd #13) — whether the composer's folder chip should surface the
 * per-conversation SANDBOX state instead of a (possibly stale) project name. It's
 * true when a project is selected but pi is actually running inside the
 * conversation sandbox `~/.pi/desktop/sandbox/<id>/`: the project folder went
 * missing on disk and the harness rerouted the live working dir there (see the
 * CRITICAL missing-project wave) rather than the dead path.
 *
 * Prefers an explicit store flag (`usingSandbox`, if that wave has landed it) when
 * the caller passes one; otherwise INFERS it from pi's live session cwd. It keys
 * on the cwd being UNDER the sandbox root (not merely "cwd ≠ project path") so a
 * valid project never false-warns when the OS realpath's its folder — e.g. macOS
 * resolves `/tmp/foo` to `/private/tmp/foo`, which a naive path-equality check
 * would read as "not in the project". Returns false when no project is selected
 * (the plain "No project" state, not a stale-folder warning) or before the session
 * cwd is known. Pure + node-testable.
 */
export function usesSandbox(
  activePath: string | null,
  sessionCwd: string | null | undefined,
  flag?: boolean,
): boolean {
  if (flag !== undefined) return flag;
  if (activePath === null) return false;
  if (sessionCwd === null || sessionCwd === undefined || sessionCwd === '') return false;
  return SANDBOX_CWD.test(sessionCwd);
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
   * to a pinned level; the label reads "Effort · Adaptive". */
  readonly auto: boolean;
  /** The explicit detent index (0..EFFORT_STEP_COUNT-1) for aria + keyboard. */
  readonly index: number;
  /** Fill fraction (0..1): auto → the tier's auto level; level → the level. */
  readonly fill: number;
  /** Labeled readout: "Effort · Adaptive" (auto) or "Effort · Balanced/High/Max" (level). */
  readonly label: string;
  /** Screen-reader value text. */
  readonly valueText: string;
}

/**
 * Resolve the slider surface. In Auto the fill follows the active tier
 * (fast→min, balanced→mid, intelligent→the tick below max via
 * `autoEffortForTier`); with no tier yet it rests on the last explicit level. The
 * Auto readout is "Effort · Adaptive" (a distinct word from the model chip's
 * "Auto", jedd #12), while the slider position still shows where routing would
 * land. In level mode it
 * pins the explicit level and reads "Effort · <Level>" (max is only reachable
 * here, by an explicit drag).
 */
export function effortSliderView(
  effortMode: EffortMode,
  effort: EffortLevel,
  activeTier: ModelTier | null,
): EffortSliderView {
  if (effortMode === 'auto') {
    // In Auto the readout says "Adaptive" ("Effort · Adaptive"), NOT the resolved
    // level — it means "let routing pick the effort". A distinct word from the
    // model chip's "Auto" (jedd #12) so the two never read as duplicate "Auto"s.
    // The tier still drives the slider POSITION (index/fill) via `autoEffortForTier`
    // so the knob rests where routing would land; before the classifier runs (no
    // tier) it rests on the last explicit level.
    const level = activeTier !== null ? autoEffortForTier(activeTier) : effort;
    const index = Math.max(0, EFFORT_STEPS.indexOf(level));
    const fill = levelToSlider(level);
    return {
      auto: true,
      index,
      fill,
      label: 'Effort · Adaptive',
      valueText: 'Effort, adaptive',
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

/**
 * The ring from pi's OWN accounting — the harness republishes
 * `ctx.getContextUsage().percent` in its status blob every turn
 * (`HarnessStatus.contextPercent`, 0..100). This is the authoritative,
 * provider-independent source: it updates whether the model is a local llama, a
 * remote provider, or AFM — none of which reliably report the
 * `AssistantMsg.usage.totalTokens` the {@link deriveContextGauge} fallback needs,
 * and it doesn't depend on the launched llama's context window (0 when no local
 * server is up). Returns null when the harness hasn't published a percent yet.
 * `usedTokens` is only derivable when the window is also known (0 otherwise — the
 * tooltip then hides the token line).
 */
export function contextGaugeFromPercent(
  percent: number | null | undefined,
  contextWindow: number,
): ContextGaugeView | null {
  if (percent === null || percent === undefined || !Number.isFinite(percent)) return null;
  const value = Math.min(1, Math.max(0, percent / 100));
  return { value, usedTokens: contextWindow > 0 ? Math.round(value * contextWindow) : 0 };
}

/**
 * Resolve the context ring, preferring pi's own {@link contextGaugeFromPercent}
 * accounting (updates on every provider) and falling back to the launched-window
 * token math ({@link deriveContextGauge}) only when the harness hasn't reported a
 * percent. This is why the ring is no longer "stuck" — it no longer requires both
 * a launched llama window AND provider-reported usage tokens.
 */
export function resolveContextGauge(opts: {
  contextPercent: number | null | undefined;
  messages: readonly ChatMsg[];
  contextWindow: number;
}): ContextGaugeView | null {
  return (
    contextGaugeFromPercent(opts.contextPercent, opts.contextWindow) ??
    deriveContextGauge(opts.messages, opts.contextWindow)
  );
}

/**
 * Keep the ring steady across a momentary null. A freshly {@link
 * resolveContextGauge}-d value can transiently resolve to `null` mid-conversation
 * even though the context is not actually empty — e.g. a model swap zeroes the
 * launched window for a frame (percent path unknown AND window 0), or the harness
 * status is briefly cleared/republished between turns. Blanking the ring on those
 * single frames reads as a flicker, so this holds the last non-null gauge whenever
 * the fresh read is null. The caller drops the held value when the THREAD identity
 * changes (new / switched session) so a fresh conversation starts empty instead of
 * inheriting the prior fill — see {@link ComposerBar}'s ContextRegion. Pure.
 */
export function stickyContextGauge(
  fresh: ContextGaugeView | null,
  previous: ContextGaugeView | null,
): ContextGaugeView | null {
  return fresh ?? previous;
}
