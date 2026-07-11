/**
 * Pure helper for the round-12 footer model dropdown (W3): builds the ordered
 * fast / balanced / intelligent rows the popup shows under "Auto", differing
 * only by which line leads:
 *
 *   - USER mode  → the tier LABEL leads ("Fast"), the real model name is the
 *     grey secondary ("gemma4 e2b") — friendly first, honest underneath;
 *   - POWER mode → the real model NAME leads, the tier label is the grey
 *     secondary — power users see the actual model first.
 *
 * Store/browser-free on purpose so it unit-tests in the node env (importing the
 * footer component pulls in `window`-touching modules).
 */

// Imported from the harness SOURCE (not the barrel): the '@pi-desktop/harness'
// barrel drags the extension + pi-coding-agent SDK into the renderer bundle and
// breaks `vite build`; tier.ts is pure + browser-safe. See auto-router.ts.
import {
  MODEL_TIERS,
  type ModelTier,
  TIER_LABEL,
} from '../../../../packages/harness/src/classify/tier.ts';
import type { LlmTierPick } from '../../electron/ipc-contract';
import type { ModelSelection, UserMode } from '../../electron/settings/settings-contract';

/** One tier row in the footer dropdown. */
export interface TierMenuRow {
  tier: ModelTier;
  /** Bold, primary line: tier label (user) or model name (power). */
  primary: string;
  /** Grey secondary line: model name (user) or tier label (power). Null when the
   * tier hasn't resolved a model yet (catalog still loading). */
  secondary: string | null;
  /** Whether the tier's model is already on disk (drives the "download" nudge). */
  downloaded: boolean;
  /** Download size in bytes (0 = unknown). */
  bytes: number;
}

/**
 * Build the three tier rows for the footer dropdown, ordered fast → balanced →
 * intelligent. When `tierModels` is absent (catalog not loaded), the rows still
 * render the tier labels (with no grey model name) so the dropdown is never
 * empty.
 */
export function buildTierRows(
  tierModels: Record<ModelTier, LlmTierPick> | undefined,
  userMode: UserMode,
): TierMenuRow[] {
  return MODEL_TIERS.map((tier) => {
    const pick = tierModels?.[tier];
    const label = TIER_LABEL[tier];
    const modelName = pick?.displayName ?? null;
    const power = userMode === 'power';
    return {
      tier,
      // Power leads with the model name (falling back to the label before load).
      primary: power ? (modelName ?? label) : label,
      // The "other" vocabulary is the grey secondary.
      secondary: power ? (modelName !== null ? label : null) : modelName,
      downloaded: pick?.downloaded ?? false,
      bytes: pick?.bytes ?? 0,
    };
  });
}

/**
 * The footer model-chip label, now driven by the SELECTION MODE (round-16) rather
 * than the experience mode — the chip names *what the user chose*, identically in
 * user and power mode:
 *
 *   - `auto`  → "Auto · <routed tier>" ("Auto · Balanced"), or plain "Auto" until
 *     the classifier resolves a tier this session — in BOTH modes. (This is the
 *     fix: power+auto previously leaked the raw running model name; now Auto
 *     always speaks for routing.)
 *   - `tier`  → the friendly TIER label alone ("Balanced"/"Fast"/"Intelligent"),
 *     never "Auto", never the raw model id — user mode pinning a capability tier.
 *   - `model` → the pinned model's friendly name — power mode pinning a specific
 *     model.
 *
 * Returns `null` when there is nothing to name yet (no running model / catalog not
 * loaded) so the caller supplies its "Choose model" / "Pick a model" fallback.
 * `userMode` is retained in the signature (call-site + contract stability) though
 * the label no longer branches on it. Pure + node-testable (importing the footer
 * component pulls in `window`-touching modules).
 */
export function chipLabel(
  userMode: UserMode,
  selection: ModelSelection,
  activeTier: ModelTier | null,
  modelName: string | null,
): string | null {
  // Auto names the routed TIER in both user and power mode ("Auto · Balanced"),
  // resting on plain "Auto" before the classifier has resolved a tier.
  if (selection.mode === 'auto')
    return activeTier !== null ? `Auto · ${TIER_LABEL[activeTier]}` : 'Auto';
  // A pinned capability tier → the friendly tier label alone.
  if (selection.mode === 'tier') return TIER_LABEL[selection.tier];
  // A pinned specific model → its friendly name (null → caller fallback).
  return modelName;
}
