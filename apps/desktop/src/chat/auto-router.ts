/**
 * The round-12 Auto model router (W3).
 *
 * When `modelSelection.mode === 'auto'`, every send classifies the outgoing
 * prompt (the pure `classify` heuristic), maps the task class → a capability
 * tier (fast / balanced / intelligent), resolves that tier → the concrete model
 * this machine runs for it (`recommendation.tierModels`), and — if it differs
 * from the running server model — performs the existing HARD restart (llama
 * dispose + start + pi respawn on the same session) so the turn runs on the
 * routed model.
 *
 * The switching decision is deliberately conservative (see {@link decideRoute}):
 *   - switch only on a real model-id change (two tiers can share one model on a
 *     small machine → that's a no-op, never a restart);
 *   - sticky-up / lazy-down hysteresis — upgrade immediately, but downgrade only
 *     after {@link DOWNGRADE_TURNS} consecutive turns want a lower tier;
 *   - a debounce so rapid consecutive sends don't thrash the (seconds-long)
 *     restart;
 *   - NEVER auto-switch to a model that isn't downloaded — surface the friendly
 *     auto-download prompt instead;
 *   - a live "switching…" banner (in model-selection-store) so the restart
 *     latency is honest.
 *
 * The pure core (`decideRoute`, `tierForPrompt`, `tierForModelId`,
 * `downloadPromptView`) is store-free + node-testable; the impure orchestration
 * below reads the live stores and drives the restart.
 */

// NOTE: imported from the harness SOURCE modules, not the '@pi-desktop/harness'
// barrel. The barrel re-exports the whole extension (subagent scheduler →
// node:os/child_process, repair bridge, and the pi-coding-agent SDK →
// @mistralai/@opentelemetry), which the renderer bundle can't tree-shake and
// which breaks `vite build`. classify.ts + tier.ts are pure, dependency-free,
// and node/browser-safe, so a direct source import keeps the bundle clean. (A
// tidier fix would be a renderer-safe `@pi-desktop/harness/classify` subpath
// export — that's W5's package to touch.)
import { classify, type TaskClass } from '../../../../packages/harness/src/classify/classify.ts';
import {
  MODEL_TIERS,
  type ModelTier,
  modelTierForClass,
  TIER_LABEL,
} from '../../../../packages/harness/src/classify/tier.ts';
import type { LlmTierPick } from '../../electron/ipc-contract';
import type { EffortLevel } from '../../electron/settings/settings-contract';
import { useLlmStore } from '../state/llm-store';
import { activateLocalModel } from '../state/local-model';
import { autoEffortForTier } from '../state/model-selection';
import { type DowngradeMemory, useModelSelectionStore } from '../state/model-selection-store';
import { applyHarnessConfig } from '../state/pi-connect';
import { setModelSelection, useSettingsStore } from '../state/settings-store';

// --- Tuning knobs ----------------------------------------------------------

/** Lazy-down: consecutive turns that must want a lower tier before we downgrade. */
export const DOWNGRADE_TURNS = 2;
/** Debounce: don't restart the server more than once per this window (ms). */
export const SWITCH_DEBOUNCE_MS = 1500;

/** Tier ordering (fast=0 < balanced=1 < intelligent=2). */
export function tierRank(tier: ModelTier): number {
  return MODEL_TIERS.indexOf(tier);
}

// --- Pure classification / resolution --------------------------------------

/** Classify a prompt and map it to the capability tier the Auto router targets.
 * A `forcedClass` (from a composer "+" force-action) short-circuits the heuristic
 * so the routed model matches the pinned task class regardless of prompt text. */
export function tierForPrompt(
  prompt: string,
  opts: { hasImages?: boolean; forcedClass?: TaskClass } = {},
): ModelTier {
  return modelTierForClass(
    classify({ prompt, hasImages: opts.hasImages, forcedClass: opts.forcedClass }).class,
  );
}

/** The tier whose resolved model matches `modelId` (the currently-running one),
 * or null when the model isn't one of the tier picks. On a small machine where
 * two tiers share a model id, the first (lowest) matching tier wins — harmless,
 * since the same-model guard in {@link decideRoute} short-circuits first. */
export function tierForModelId(
  tierModels: Record<ModelTier, LlmTierPick> | undefined,
  modelId: string | null,
): ModelTier | null {
  if (tierModels === undefined || modelId === null) return null;
  for (const tier of MODEL_TIERS) {
    if (tierModels[tier].modelId === modelId) return tier;
  }
  return null;
}

// --- Pure routing decision -------------------------------------------------

/** The router's cross-turn memory (mirrors model-selection-store's fields). */
export interface RouterMemory {
  pendingDowngrade: DowngradeMemory | null;
  lastSwitchAt: number;
}

export interface RouteInputs {
  /** Tier of the currently-running server model (derived), or null if unknown. */
  currentTier: ModelTier | null;
  /** Tier the classifier wants for this turn. */
  desiredTier: ModelTier;
  /** The concrete model id `desiredTier` resolves to on this machine. */
  targetModelId: string;
  /** The currently-running server model id, or null when none is up. */
  currentModelId: string | null;
  /** Whether the target tier's model is already on disk. */
  downloaded: boolean;
  /** `Date.now()` at decision time (injected for testability). */
  now: number;
}

export type RouteAction = 'none' | 'switch' | 'download-prompt';

export interface RouteDecision {
  action: RouteAction;
  /** Why — for logging / the "switching…" surfaces / tests. */
  reason: string;
  /** The memory to commit after this decision (whether or not we switch). */
  memory: RouterMemory;
}

/**
 * Decide whether Auto should switch the running model this turn. Pure — all I/O
 * is the caller's job. Encodes the sticky-up / lazy-down hysteresis, the
 * same-model no-op guard, the not-downloaded → prompt rule, and the debounce.
 */
export function decideRoute(mem: RouterMemory, inp: RouteInputs): RouteDecision {
  // 1. The target model is already running → never restart. Covers two tiers
  //    resolving to the SAME model id on a small machine (a "switch" that is a
  //    real no-op). Clears any half-counted downgrade.
  if (inp.currentModelId !== null && inp.currentModelId === inp.targetModelId) {
    return {
      action: 'none',
      reason: 'same-model',
      memory: { pendingDowngrade: null, lastSwitchAt: mem.lastSwitchAt },
    };
  }

  const cur = inp.currentTier;
  const des = inp.desiredTier;

  // Initial routing and upgrades act immediately (sticky-up); a same-tier /
  // different-model id reconciles; a downgrade is lazy. All three fall through
  // to the switch below except a downgrade still counting up.
  if (cur !== null && tierRank(des) < tierRank(cur)) {
    // DOWNGRADE → lazy: require DOWNGRADE_TURNS consecutive turns wanting it.
    const count =
      mem.pendingDowngrade !== null && mem.pendingDowngrade.tier === des
        ? mem.pendingDowngrade.count + 1
        : 1;
    if (count < DOWNGRADE_TURNS) {
      return {
        action: 'none',
        reason: 'lazy-down-waiting',
        memory: { pendingDowngrade: { tier: des, count }, lastSwitchAt: mem.lastSwitchAt },
      };
    }
  }

  // A move is warranted. Never auto-switch to a model that isn't on disk.
  if (!inp.downloaded) {
    return {
      action: 'download-prompt',
      reason: 'not-downloaded',
      memory: { pendingDowngrade: null, lastSwitchAt: mem.lastSwitchAt },
    };
  }

  // Debounce heavy restarts across rapid consecutive sends.
  if (inp.now - mem.lastSwitchAt < SWITCH_DEBOUNCE_MS) {
    return {
      action: 'none',
      reason: 'debounced',
      memory: { pendingDowngrade: null, lastSwitchAt: mem.lastSwitchAt },
    };
  }

  return {
    action: 'switch',
    reason: cur === null ? 'initial' : 'tier-change',
    memory: { pendingDowngrade: null, lastSwitchAt: inp.now },
  };
}

// --- Auto-download prompt view (pure) --------------------------------------

/** Bytes → a friendly "N GB" / "N MB" (empty when unknown, so copy can omit it). */
export function formatTierBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const gb = bytes / 1e9;
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

export interface DownloadPromptView {
  /** e.g. "Download intelligent model" — no jargon, no manager reference. */
  title: string;
  /** Grey secondary, e.g. "qwen3.6 27b · 16 GB". */
  detail: string;
  modelId: string;
  quant: string;
}

/** Build the friendly auto-download card copy for a pending tier, or null. */
export function downloadPromptView(
  pending: { tier: ModelTier; pick: LlmTierPick } | null,
): DownloadPromptView | null {
  if (pending === null) return null;
  const { tier, pick } = pending;
  const size = formatTierBytes(pick.bytes);
  return {
    title: `Download ${TIER_LABEL[tier].toLowerCase()} model`,
    detail: size.length > 0 ? `${pick.displayName} · ${size}` : pick.displayName,
    modelId: pick.modelId,
    quant: pick.quant,
  };
}

// --- Impure orchestration (reads the live stores, drives the restart) -------

/** The tier picks resolved for this machine (undefined before catalog load). */
function tierModels(): Record<ModelTier, LlmTierPick> | undefined {
  return useLlmStore.getState().recommendation?.tierModels;
}

/** The last effort level auto-pushed to the harness — so `effort:'auto'` only
 * fires a `/harness effort` when the tier (hence the level) actually changes,
 * not on every send. */
let lastAutoEffort: EffortLevel | null = null;

/**
 * When effort is in 'auto' mode, the effort level FOLLOWS the active tier
 * (fast→low, balanced→medium, intelligent→high — max is explicit-drag only).
 * Push it to the harness only on a real change (round-12: the effort slider's
 * Auto tracks the classifier's per-turn tier). No-op when effort is pinned.
 */
function pushAutoEffort(tier: ModelTier): void {
  if (useSettingsStore.getState().settings.effortMode !== 'auto') return;
  const level = autoEffortForTier(tier);
  if (level === lastAutoEffort) return;
  lastAutoEffort = level;
  void applyHarnessConfig({ effort: level });
}

/**
 * Perform the hard-restart switch to a tier's model. Surfaces the live
 * "switching…" banner for the (seconds-long) llama-server restart, then reuses
 * the proven {@link activateLocalModel} path (start server → respawn pi on the
 * same session → re-point the model). Best-effort: a failed switch is swallowed
 * and self-corrects next turn (the current model id is re-read live).
 */
async function performSwitch(tier: ModelTier, pick: LlmTierPick): Promise<void> {
  const store = useModelSelectionStore.getState();
  store.setSwitching({ toTier: tier, toName: pick.displayName });
  try {
    await activateLocalModel(pick.modelId, pick.quant);
  } catch {
    // Leave the current model in place; the next turn re-derives from live state.
  } finally {
    useModelSelectionStore.getState().setSwitching(null);
  }
}

/**
 * Auto-router entry — called by `sendPrompt` BEFORE the prompt is dispatched.
 * No-op unless the selection is Auto. Awaited by the sender so the turn runs on
 * the routed model; the download-prompt path returns immediately (a slow
 * download must never block a send). Never throws.
 */
export async function maybeRouteAuto(
  prompt: string,
  opts: { hasImages?: boolean; forcedClass?: TaskClass } = {},
): Promise<void> {
  try {
    if (useSettingsStore.getState().settings.modelSelection.mode !== 'auto') return;
    const models = tierModels();
    if (models === undefined) return; // catalog not loaded → nothing to route to

    const currentModelId = useLlmStore.getState().status.model?.id ?? null;
    const desiredTier = tierForPrompt(prompt, {
      hasImages: opts.hasImages,
      forcedClass: opts.forcedClass,
    });
    // Auto effort tracks the classifier's tier for this turn (independent of
    // whether the MODEL switches — two tiers can share one model but want
    // different effort).
    pushAutoEffort(desiredTier);
    const pick = models[desiredTier];

    const sel = useModelSelectionStore.getState();
    const decision = decideRoute(
      { pendingDowngrade: sel.pendingDowngrade, lastSwitchAt: sel.lastSwitchAt },
      {
        currentTier: tierForModelId(models, currentModelId),
        desiredTier,
        targetModelId: pick.modelId,
        currentModelId,
        downloaded: pick.downloaded,
        now: Date.now(),
      },
    );

    // Commit the cross-turn memory regardless of the action.
    useModelSelectionStore.setState({
      pendingDowngrade: decision.memory.pendingDowngrade,
      lastSwitchAt: decision.memory.lastSwitchAt,
    });

    if (decision.action === 'download-prompt') {
      useModelSelectionStore.getState().setPendingDownload({ tier: desiredTier, pick });
      return;
    }
    if (decision.action === 'switch') {
      useModelSelectionStore.getState().setPendingDownload(null);
      await performSwitch(desiredTier, pick);
    }
  } catch {
    // Routing must never take a send down with it.
  }
}

// --- Explicit footer selections (bypass hysteresis) ------------------------

/**
 * Footer dropdown "Auto" — persist the auto selection and clear any pending
 * download card. The next send routes per the classifier.
 */
export async function selectAuto(): Promise<void> {
  useModelSelectionStore.getState().setPendingDownload(null);
  await setModelSelection({ mode: 'auto' });
}

/**
 * Footer dropdown tier pick — persist the pinned tier AND apply it now. Unlike
 * the Auto router this is an explicit choice, so there's no hysteresis: switch
 * immediately when the model is downloaded, or surface the friendly download
 * prompt when it isn't.
 */
export async function selectTier(tier: ModelTier): Promise<void> {
  await setModelSelection({ mode: 'tier', tier });
  // A pinned tier is fixed, so push its auto effort once (if effort is 'auto').
  pushAutoEffort(tier);
  const models = tierModels();
  if (models === undefined) return;
  const pick = models[tier];

  if (!pick.downloaded) {
    useModelSelectionStore.getState().setPendingDownload({ tier, pick });
    return;
  }
  useModelSelectionStore.getState().setPendingDownload(null);
  const currentModelId = useLlmStore.getState().status.model?.id ?? null;
  useModelSelectionStore.getState().markSwitched(Date.now());
  if (pick.modelId === currentModelId) return; // already on it — no restart
  await performSwitch(tier, pick);
}

/**
 * AutoDownloadPrompt "Download" — download the pending tier's model, then (on a
 * confirmed download) switch to it. Clears the card either way.
 */
export async function downloadPendingTier(): Promise<void> {
  const pending = useModelSelectionStore.getState().pendingDownload;
  if (pending === null) return;
  const { tier, pick } = pending;
  await useLlmStore.getState().downloadModel(pick.modelId, pick.quant);
  // refreshCatalog (inside downloadModel) refreshes the tier picks' downloaded flag.
  const fresh = useLlmStore.getState().recommendation?.tierModels?.[tier] ?? pick;
  useModelSelectionStore.getState().setPendingDownload(null);
  if (fresh.downloaded) await performSwitch(tier, fresh);
}
