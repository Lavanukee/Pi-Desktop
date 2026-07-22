/**
 * Pure RAM/OOM reasoning for the chat SEND path — the renderer-side companion to
 * the corp KV-slot estimator (apps/desktop/electron/corp/concurrency.ts).
 *
 * There is exactly ONE local llama-server holding ONE model at a time (see the
 * concurrency map: switching models disposes + reloads the server and respawns
 * pi). So for a message about to be sent this module answers two things:
 *   1. Can the selected model even run on THIS machine? (weights + one full KV
 *      slot must fit in usable RAM.)
 *   2. If a turn is already in flight, does sending now just mean waiting for the
 *      reply (SAME model) or a full model swap (DIFFERENT model)?
 *
 * No electron, no `os` — the caller injects `totalRamGB` (from
 * `useLlmStore().hardware`) so this unit-tests in plain node. The RAM constants
 * MIRROR the corp estimator (0.75 usable fraction, 2 GB reserve, ~0.8 GB per
 * full-context KV slot); `send-feasibility.test.ts` pins them to the corp module
 * so the two can never silently drift.
 *
 * Deliberately CONSERVATIVE and honest: an unknown weight size is treated as
 * unknown (never as "free"), and we never fabricate an OOM warning we can't
 * justify from real numbers.
 */

const GiB = 1024 ** 3;

/** Fraction of total RAM we consider usable at all (mirrors CORP_USABLE_FRACTION). */
export const USABLE_FRACTION = 0.75;
/** Headroom held back for the OS + other apps + llama overhead (mirrors CORP_RESERVE_BYTES). */
export const RESERVE_BYTES = 2 * GiB;
/** RAM cost of one full-context (16384) KV slot (mirrors QWEN_CORP_PER_SLOT_KV_BYTES). */
export const PER_SLOT_KV_BYTES = Math.round(0.8 * GiB);

/** A model resolved enough to reason about its RAM cost. */
export interface ModelFit {
  readonly modelId: string;
  readonly displayName: string;
  /** Resident weight bytes (0 = unknown → treated as unknown, not free). */
  readonly weightsBytes: number;
  /** The catalog's coarse min-RAM gate in GB (0/undefined = unknown). */
  readonly minRamGB?: number;
}

/**
 * Why a send is (or isn't) able to run right now.
 *  - `ready`             — nothing blocking; it dispatches immediately.
 *  - `busy-same-model`   — a turn is running on the SAME model this message needs;
 *                          it sends automatically when that reply finishes.
 *  - `busy-switch-model` — a turn is running but this message needs a DIFFERENT
 *                          model; it waits for the reply AND a server swap (evict
 *                          + reload). Pausing/stopping the running chat sends it now.
 *  - `insufficient-ram`  — the selected model likely won't fit this machine at all.
 */
export type QueueReasonKind =
  | 'ready'
  | 'busy-same-model'
  | 'busy-switch-model'
  | 'insufficient-ram';

export interface SendFeasibility {
  readonly kind: QueueReasonKind;
  /** True when the machine can likely hold the target model + one KV slot. */
  readonly targetFits: boolean;
  readonly target: ModelFit | null;
  /** The model resident in the server right now (what a switch would evict). */
  readonly loadedModelId: string | null;
  readonly loadedModelName: string | null;
  /** RAM basis (GB), for logging + the modal's detail copy. */
  readonly totalRamGB: number;
  readonly usableGB: number;
  /** usable − target weights − reserve (GB); negative ⇒ won't fit. */
  readonly availableGB: number;
}

export interface AssessSendInput {
  readonly totalRamGB: number;
  readonly target: ModelFit | null;
  readonly loadedModelId: string | null;
  readonly loadedModelName: string | null;
  /** Whether a turn is currently in flight (streaming OR dispatching). */
  readonly turnInFlight: boolean;
}

/**
 * The queue-reason snapshot stashed on a {@link QueuedSend} at enqueue time and
 * read by the faded queued line + the "Why isn't my message sending?" modal. A
 * plain data bag (no live store refs) so it survives being held in the queue.
 */
export interface QueueReason {
  readonly kind: QueueReasonKind;
  readonly targetModelName?: string;
  readonly loadedModelName?: string;
}

/** Reduce a full feasibility assessment to the {@link QueueReason} we persist. */
export function feasibilityToReason(f: SendFeasibility): QueueReason {
  return {
    kind: f.kind,
    ...(f.target?.displayName !== undefined ? { targetModelName: f.target.displayName } : {}),
    ...(f.loadedModelName !== null ? { loadedModelName: f.loadedModelName } : {}),
  };
}

const bytesToGB = (b: number): number => b / GiB;

/**
 * Does the target model + one full-context KV slot fit in usable RAM? Prefers the
 * real weight bytes; falls back to the catalog `minRamGB` gate; with neither known
 * it assumes it fits (we never invent an OOM warning without a number behind it).
 */
export function targetFits(totalRamGB: number, target: ModelFit | null): boolean {
  if (target === null) return true;
  if (!Number.isFinite(totalRamGB) || totalRamGB <= 0) return true;
  const usableBytes = totalRamGB * GiB * USABLE_FRACTION;
  if (target.weightsBytes > 0) {
    const available = usableBytes - target.weightsBytes - RESERVE_BYTES;
    return available >= PER_SLOT_KV_BYTES;
  }
  if (target.minRamGB !== undefined && target.minRamGB > 0) {
    return target.minRamGB <= totalRamGB;
  }
  return true;
}

/**
 * Classify a pending send. Pure — see the module header. The order matters: a
 * model that can't fit at all is the strongest signal and is surfaced even while
 * a turn is busy (it explains why even waiting won't help).
 */
export function assessSendFeasibility(inp: AssessSendInput): SendFeasibility {
  const usableGB = Number.isFinite(inp.totalRamGB) ? inp.totalRamGB * USABLE_FRACTION : 0;
  const targetWeightsGB =
    inp.target !== null && inp.target.weightsBytes > 0 ? bytesToGB(inp.target.weightsBytes) : 0;
  const availableGB = usableGB - targetWeightsGB - bytesToGB(RESERVE_BYTES);
  const fits = targetFits(inp.totalRamGB, inp.target);

  const base = {
    target: inp.target,
    targetFits: fits,
    loadedModelId: inp.loadedModelId,
    loadedModelName: inp.loadedModelName,
    totalRamGB: inp.totalRamGB,
    usableGB,
    availableGB,
  } as const;

  if (!fits) return { ...base, kind: 'insufficient-ram' };
  if (!inp.turnInFlight) return { ...base, kind: 'ready' };

  // A turn is running. If the target is unknown (Auto, pre-classify) or matches
  // the loaded model, it just waits; a known DIFFERENT target means a server swap.
  const targetKnown = inp.target !== null && inp.loadedModelId !== null;
  const sameModel = targetKnown && inp.target?.modelId === inp.loadedModelId;
  if (!targetKnown || sameModel) return { ...base, kind: 'busy-same-model' };
  return { ...base, kind: 'busy-switch-model' };
}

// ---------------------------------------------------------------------------
// Target-model resolution (selection → ModelFit)
// ---------------------------------------------------------------------------

/** The subset of `ModelSelection` this module needs (mirrors settings-contract). */
export type ModelSelectionLike =
  | { mode: 'auto' }
  | { mode: 'tier'; tier: 'fast' | 'balanced' | 'intelligent' }
  | { mode: 'model'; modelId: string };

/** The subset of an `LlmTierPick` this module needs. */
export interface TierPickLike {
  readonly modelId: string;
  readonly displayName: string;
  readonly bytes: number;
}

/** The subset of an `LlmCatalogEntry` this module needs. */
export interface CatalogEntryLike {
  readonly id: string;
  readonly displayName: string;
  readonly minRamGB: number;
  readonly quants: ReadonlyArray<{ readonly quant: string; readonly bytes: number }>;
}

/** The subset of the loaded `LlmModelInfo` this module needs. */
export interface LoadedModelLike {
  readonly id: string;
  readonly displayName: string;
  readonly quant: string;
}

/** Largest known quant size for a catalog entry (the safe upper bound on weights). */
function maxQuantBytes(entry: CatalogEntryLike | undefined): number {
  if (entry === undefined) return 0;
  return entry.quants.reduce((max, q) => (q.bytes > max ? q.bytes : max), 0);
}

/** A catalog entry → ModelFit, optionally pinned to a specific quant's bytes. */
function fitFromCatalog(entry: CatalogEntryLike | undefined, quant?: string): ModelFit | null {
  if (entry === undefined) return null;
  const pinned =
    quant !== undefined ? entry.quants.find((q) => q.quant === quant)?.bytes : undefined;
  return {
    modelId: entry.id,
    displayName: entry.displayName,
    weightsBytes: pinned !== undefined && pinned > 0 ? pinned : maxQuantBytes(entry),
    minRamGB: entry.minRamGB,
  };
}

/**
 * Resolve the model a send WILL use, given the current selection. Pure.
 *
 *  - `auto`  → the router classifies per-prompt and usually keeps the loaded
 *              model, so we treat the loaded model as the target (best guess). A
 *              null loaded model (nothing running yet) yields null → "unknown".
 *  - `tier`  → the machine's resolved pick for that tier (`tierModels[tier]`),
 *              enriched with the catalog's minRamGB.
 *  - `model` → the explicit catalog entry (its largest quant as the RAM upper bound).
 */
export function resolveTargetModel(inp: {
  selection: ModelSelectionLike;
  tierModels?: Partial<Record<'fast' | 'balanced' | 'intelligent', TierPickLike>>;
  catalog: readonly CatalogEntryLike[];
  loaded: LoadedModelLike | null;
}): ModelFit | null {
  const byId = (id: string): CatalogEntryLike | undefined => inp.catalog.find((c) => c.id === id);
  if (inp.selection.mode === 'auto') {
    if (inp.loaded === null) return null;
    return (
      fitFromCatalog(byId(inp.loaded.id), inp.loaded.quant) ?? {
        modelId: inp.loaded.id,
        displayName: inp.loaded.displayName,
        weightsBytes: 0,
      }
    );
  }
  if (inp.selection.mode === 'tier') {
    const pick = inp.tierModels?.[inp.selection.tier];
    if (pick === undefined) return null;
    return {
      modelId: pick.modelId,
      displayName: pick.displayName,
      weightsBytes: pick.bytes,
      minRamGB: byId(pick.modelId)?.minRamGB,
    };
  }
  // Explicit model pick.
  return fitFromCatalog(byId(inp.selection.modelId));
}
