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
import type { UserMode } from '../../electron/settings/settings-contract';

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
