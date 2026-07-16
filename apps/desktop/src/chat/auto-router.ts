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
import { agentInFlight, applyHarnessConfig } from '../state/pi-connect';
import { usePiStore } from '../state/pi-slice';
import { setModelSelection, useSettingsStore } from '../state/settings-store';
import { parseHarnessStatus } from './harness-status';

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
 * so the routed model matches the pinned task class regardless of prompt text.
 *
 * `priorClass` + `turnIndex` thread the SAME conversation-continuity signal the
 * harness's own classifier uses (a terse follow-up like "continue" inherits the
 * prior task's class). Sourcing `priorClass` from the harness's published
 * `activeClass` is how the app router's tier-1 stays in lock-step with the
 * harness's classification for a task (see {@link maybeRouteAuto}) — without it
 * the app would reclassify a bare "continue" from scratch and disagree on the
 * model mid-task. */
export function tierForPrompt(
  prompt: string,
  opts: {
    hasImages?: boolean;
    forcedClass?: TaskClass;
    priorClass?: TaskClass;
    turnIndex?: number;
  } = {},
): ModelTier {
  return modelTierForClass(
    classify({
      prompt,
      hasImages: opts.hasImages,
      forcedClass: opts.forcedClass,
      priorClass: opts.priorClass,
      turnIndex: opts.turnIndex,
    }).class,
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

// --- Pure startup-preload pick (a model is ALWAYS loaded) ------------------

/** Inputs to {@link pickPreloadModel} (mirrors the live llm-store fields). */
export interface PreloadInputs {
  /** The 3 tier picks resolved for this machine (undefined before catalog load). */
  tierModels: Record<ModelTier, LlmTierPick> | undefined;
  /** Model ids currently on disk (the supervisor's downloaded set). */
  downloadedModelIds: readonly string[];
  /** Whether an inference server is already up. */
  serverRunning: boolean;
  /** The model id currently resident, or null when none is up. */
  currentModelId: string | null;
}

/**
 * Pure: pick the FASTEST already-downloaded model to preload at startup so a
 * model is always resident with the lowest possible TTFT. Walks the tiers fast →
 * balanced → intelligent and returns the first whose model is on disk (fast is
 * the fastest, so the first downloaded one is the fastest available). Returns
 * null — nothing to preload — when a model is already resident, the catalog
 * hasn't loaded, or nothing is downloaded yet.
 */
export function pickPreloadModel(inp: PreloadInputs): { modelId: string; quant: string } | null {
  // Already resident → nothing to preload.
  if (inp.serverRunning && inp.currentModelId !== null) return null;
  if (inp.tierModels === undefined) return null;
  for (const tier of MODEL_TIERS) {
    const pick = inp.tierModels[tier];
    if (inp.downloadedModelIds.includes(pick.modelId)) {
      return { modelId: pick.modelId, quant: pick.quant };
    }
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
  /**
   * Whether a turn is currently in flight (streaming / a queued follow-up). When
   * true the running model is LOCKED for the task and Auto must NOT hard-restart
   * llama — the switch waits for the next clean idle boundary. Defaults to false
   * (a fresh, idle send). Explicit user model changes never reach here, so they
   * are unaffected by this gate.
   */
  inFlight?: boolean;
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
  // 0. A turn is IN FLIGHT → the model is locked for the task. Never hard-restart
  //    llama mid-stream/mid-task; hold the current model and leave the cross-turn
  //    memory UNTOUCHED (a queued follow-up is not a fresh routing decision, so it
  //    must not advance the debounce clock or the lazy-down counter). Auto still
  //    routes at the next clean IDLE boundary; an explicit user model change never
  //    calls decideRoute, so it bypasses this gate entirely.
  if (inp.inFlight === true) {
    return { action: 'none', reason: 'in-flight', memory: mem };
  }

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

// --- Explicit (user-driven) tier pick (pure) -------------------------------

export type ExplicitSwitchAction = 'download-prompt' | 'none' | 'switch';

/**
 * The decision for an EXPLICIT user tier pick (footer dropdown / model menu).
 * Deliberately un-gated: unlike the Auto router this has NO hysteresis, NO
 * debounce, and NO in-flight lock — an explicit user model change is honored
 * immediately (the user asked for it), even mid-stream. A tier whose model isn't
 * on disk opens the friendly download flow instead of switching; the
 * already-running model is a no-op. This is the counterpart to
 * {@link decideRoute}'s in-flight gate: the gate stops IMPLICIT mid-task
 * switches, this stays open so a user can always take manual control.
 */
export function explicitSwitchAction(inp: {
  downloaded: boolean;
  targetModelId: string;
  currentModelId: string | null;
}): ExplicitSwitchAction {
  if (!inp.downloaded) return 'download-prompt';
  if (inp.currentModelId !== null && inp.currentModelId === inp.targetModelId) return 'none';
  return 'switch';
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

/**
 * The tier's coarse response-speed word for the download Dialog's speedometer
 * caption. Bigger/smarter models decode slower, so the capability tier maps
 * inversely to felt speed: fast → "fast", balanced → "balanced", intelligent →
 * "slow". Pure — driven off the authoritative `pendingDownload.tier`.
 */
export function tierSpeed(tier: ModelTier): 'fast' | 'balanced' | 'slow' {
  switch (tier) {
    case 'fast':
      return 'fast';
    case 'balanced':
      return 'balanced';
    default:
      return 'slow';
  }
}

// --- Impure orchestration (reads the live stores, drives the restart) -------

/** The tier picks resolved for this machine (undefined before catalog load). */
function tierModels(): Record<ModelTier, LlmTierPick> | undefined {
  return useLlmStore.getState().recommendation?.tierModels;
}

/**
 * The harness's authoritative classification for the CURRENT task, read live from
 * its published status. `activeClass` is fed back into our own tier-1 as the
 * continuity prior (so a terse follow-up inherits the same class the harness
 * keeps), and `activeTier` — which the harness may have tier-2-corrected — anchors
 * the hysteresis's notion of "where we are" instead of the raw running-model→tier
 * mapping. Together they keep the app router and the harness in agreement on the
 * model for a task. Both null before the harness has classified (a fresh task's
 * first turn), where the app's own tier-1 bootstraps the pick.
 */
function harnessTaskContext(): {
  priorClass: TaskClass | undefined;
  activeTier: ModelTier | null;
} {
  const status = parseHarnessStatus(usePiStore.getState().extensionStatus.harness);
  return {
    priorClass: status?.activeClass ?? undefined,
    activeTier: status?.activeTier ?? null,
  };
}

/** Prior user turns in the thread (0-based turn index for the classifier's
 * continuation branch). `sendPrompt` appends this turn's user echo BEFORE routing,
 * so the current message is already counted — subtract it to get the prior count.
 * >0 (with a `priorClass`) is what lets a bare "continue" inherit the task class. */
function priorUserTurns(): number {
  const users = usePiStore.getState().messages.filter((m) => m.kind === 'user').length;
  return Math.max(0, users - 1);
}

/** The last effort level auto-pushed to the harness — so `effort:'auto'` only
 * fires a `/harness effort` when the tier (hence the level) actually changes,
 * not on every send. */
let lastAutoEffort: EffortLevel | null = null;

/**
 * When effort is in 'auto' mode, the effort level FOLLOWS the active tier
 * (fast→low, balanced→medium, intelligent→high — max is explicit-drag only).
 * Push it to the harness only on a real change. No-op when effort is pinned.
 *
 * Callers must gate this behind the in-flight check: it is only invoked at a clean
 * IDLE boundary (see {@link maybeRouteAuto}), so effort never silently re-derives
 * mid-task/mid-stream. Combined with the harness-continuity tier resolution, the
 * level only moves when the TASK's tier actually changes at a boundary.
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
 *
 * The model is chosen ONCE at a clean IDLE boundary (a fresh task's first send)
 * and then HELD for the task:
 *   - a turn in flight (streaming / a queued follow-up) is a hard NO-OP here — the
 *     running model is locked, so a second/queued send can't hard-restart llama
 *     mid-stream (the in-flight guard in {@link decideRoute}). An explicit user
 *     model change is the only thing that switches mid-task, and it doesn't route.
 *   - the tier is reconciled with the harness: our own tier-1 uses the harness's
 *     published `activeClass` as its continuity prior, and the hysteresis anchors
 *     on the harness's (possibly tier-2-corrected) `activeTier` — so the app router
 *     and the harness agree on the model for the task.
 *   - Auto-effort is pushed only here, at the same idle boundary, so it never
 *     silently re-derives mid-task.
 */
export async function maybeRouteAuto(
  prompt: string,
  opts: { hasImages?: boolean; forcedClass?: TaskClass } = {},
): Promise<void> {
  try {
    if (useSettingsStore.getState().settings.modelSelection.mode !== 'auto') return;
    const models = tierModels();
    if (models === undefined) return; // catalog not loaded → nothing to route to

    // The model is LOCKED once a turn is in flight — Auto only (re)picks a model
    // and re-derives effort at a clean idle boundary. A restart already in flight
    // (a live "switching…" banner) is treated the same, so overlapping sends never
    // stack two llama restarts.
    const inFlight = agentInFlight() || useModelSelectionStore.getState().switching !== null;

    const currentModelId = useLlmStore.getState().status.model?.id ?? null;

    // Agree with the harness (see {@link harnessTaskContext}): feed its authoritative
    // `activeClass` into our tier-1 as the continuity prior, and anchor the
    // hysteresis on its published `activeTier`.
    const { priorClass, activeTier } = harnessTaskContext();
    const desiredTier = tierForPrompt(prompt, {
      hasImages: opts.hasImages,
      forcedClass: opts.forcedClass,
      priorClass,
      turnIndex: priorUserTurns(),
    });

    // Auto effort follows the task tier, but ONLY at an idle boundary — never
    // silently mid-stream/mid-task. Skipped entirely while a turn is in flight.
    if (!inFlight) pushAutoEffort(desiredTier);

    const pick = models[desiredTier];
    // Prefer the harness's authoritative tier for "where we are"; fall back to the
    // running model's tier before the harness has classified.
    const currentTier = activeTier ?? tierForModelId(models, currentModelId);

    const sel = useModelSelectionStore.getState();
    const decision = decideRoute(
      { pendingDowngrade: sel.pendingDowngrade, lastSwitchAt: sel.lastSwitchAt },
      {
        currentTier,
        desiredTier,
        targetModelId: pick.modelId,
        currentModelId,
        downloaded: pick.downloaded,
        now: Date.now(),
        inFlight,
      },
    );

    // Commit the cross-turn memory regardless of the action. (In flight,
    // decideRoute returns the memory unchanged.)
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

// --- Startup auto-preload (a model is ALWAYS loaded) -----------------------

/**
 * Startup auto-preload (round-A #4): keep a model ALWAYS loaded. On app startup /
 * first chat, immediately bring the FASTEST already-downloaded model online so
 * quick requests have the lowest possible TTFT — no waiting on a large model to
 * load. The Auto router then keeps using this fast model for the fast tier and
 * only hard-restarts to a bigger model when the classifier routes up (existing
 * hysteresis/debounce), so the footer chip's "Auto · <loaded model>" reflects
 * whatever is currently resident.
 *
 * No-op unless the selection is Auto (a pinned tier/model owns its own load), when
 * a model is already resident, or when nothing is downloaded yet. Refreshes the
 * catalog + status first so the tier picks + downloaded set are current.
 * Best-effort — never throws (a failed preload just means the first send loads a
 * model on demand).
 */
export async function preloadFastestModel(): Promise<void> {
  try {
    // E2E (mock-pi) runs against the REAL inference supervisor + the machine's
    // real model cache; a probe must never auto-launch a real llama-server at
    // boot. Same `?piE2E=1` opt-in the store hooks / native-surfaces guard use.
    if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('piE2E'))
      return;
    if (useSettingsStore.getState().settings.modelSelection.mode !== 'auto') return;
    const llm = useLlmStore.getState();
    // Make the tier picks + downloaded set + running-server state current.
    await Promise.all([llm.refreshCatalog(), llm.refreshStatus()]);
    const fresh = useLlmStore.getState();
    const target = pickPreloadModel({
      tierModels: fresh.recommendation?.tierModels,
      downloadedModelIds: fresh.status.downloadedModelIds,
      serverRunning: fresh.status.serverRunning,
      currentModelId: fresh.status.model?.id ?? null,
    });
    if (target === null) return;
    await activateLocalModel(target.modelId, target.quant);
  } catch {
    // Preload is best-effort; the first send will load a model on demand.
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
 * immediately when the model is downloaded.
 *
 * jedd #4: a tier whose model ISN'T on disk can't become the active selection —
 * picking it opens the friendly download flow WITHOUT pinning a model that isn't
 * present (so the chip never claims a non-downloaded tier is active, and the
 * checkmark never lies). The tier only becomes active after the download lands.
 */
export async function selectTier(tier: ModelTier): Promise<void> {
  const models = tierModels();
  const pick = models?.[tier];
  const currentModelId = useLlmStore.getState().status.model?.id ?? null;
  // Explicit user pick: no hysteresis, no debounce, and — deliberately — no
  // in-flight gate. {@link explicitSwitchAction} is the pure decision.
  const action =
    pick !== undefined
      ? explicitSwitchAction({
          downloaded: pick.downloaded,
          targetModelId: pick.modelId,
          currentModelId,
        })
      : null;

  // Not downloaded → open the download prompt; do NOT pin it as active (#4).
  if (action === 'download-prompt' && pick !== undefined) {
    useModelSelectionStore.getState().setPendingDownload({ tier, pick });
    return;
  }

  await setModelSelection({ mode: 'tier', tier });
  // A pinned tier is fixed, so push its auto effort once (if effort is 'auto').
  pushAutoEffort(tier);
  if (pick === undefined) return; // catalog not loaded — pin persisted, nothing to launch

  useModelSelectionStore.getState().setPendingDownload(null);
  useModelSelectionStore.getState().markSwitched(Date.now());
  if (action !== 'switch') return; // already on it — no restart
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
