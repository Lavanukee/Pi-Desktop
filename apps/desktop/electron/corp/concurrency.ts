/**
 * OOM-safe concurrency selection for the coordination harness (corp).
 *
 * The corp dispatches engineer jobs SEQUENTIALLY by default; it only fans out to
 * K concurrent jobs when there is provable RAM headroom for K full-context KV
 * slots on top of the model weights. This module is the pure arithmetic that
 * decides K — no electron, no llama-server — so it unit-tests in plain Node.
 *
 * CRITICAL llama.cpp coupling (see supervisor-entry.ts / parallel-launch.ts):
 * `llama-server --parallel K` splits its `-c` budget ACROSS the K slots, so to
 * give every engineer turn the full CONTEXT_CAP (16384) we launch with
 * `-c = 16384 * K`. That means K live slots cost **K × per-slot-KV(16384)** of
 * RAM — exactly the quantity this budget divides the available headroom by.
 *
 * Design stance: TIGHT ⇒ SEQUENTIAL. Every degenerate input (non-finite, ≤ 0,
 * or too little headroom for even one extra slot) resolves to K = 1. K is always
 * an integer in [1, maxK]; it is never 0 and never exceeds maxK.
 */
import os from 'node:os';

const GiB = 1024 ** 3;

/**
 * Weights of the corp worker (qwen3.5-4b-mtp `Q8_0`) resident in RAM.
 * Sourced from the catalog file size (`packages/inference/src/catalog.ts`):
 * `Qwen3.5-4B-Q8_0.gguf` = 4_610_580_800 bytes (~4.29 GiB / ~4.6 GB). The GGUF
 * is mmap'd resident, so its on-disk size is a good RAM proxy for the weights.
 */
export const QWEN_CORP_MODEL_WEIGHTS_BYTES = 4_610_580_800;

/**
 * Per-slot KV-cache budget for one 16384-token context.
 *
 * Justification (~0.8 GB/slot): qwen3.5-4b-mtp is a HYBRID model — roughly ~75%
 * of its layers are Gated-DeltaNet linear-attention, which carry a FIXED-size
 * recurrent state (independent of sequence length) rather than a KV cache that
 * grows with every token. Only the remaining ~25% of layers hold a real,
 * length-scaling KV cache. A dense 4B at 16k would sit around ~3 GB of KV; with
 * only ~1/4 of layers contributing growing KV that is ~4× less, i.e. ~0.75 GB —
 * rounded up to 0.8 GB/slot for headroom. This is deliberately CONSERVATIVE
 * (over-budgeting KV can only make us LESS parallel, never OOM).
 */
export const QWEN_CORP_PER_SLOT_KV_BYTES = Math.round(0.8 * GiB);

/** Headroom held back for the OS, other apps, and llama-server's own overhead. */
export const CORP_RESERVE_BYTES = 2 * GiB;

/** Fraction of total RAM we consider usable for this workload at all. */
export const CORP_USABLE_FRACTION = 0.75;

/** Hard ceiling on fan-out — past 3 concurrent engineers the wall-clock win is
 * marginal and the OOM risk is not worth it for a local single-GPU box. */
export const CORP_MAX_CONCURRENCY = 3;

export interface PickCorpConcurrencyInput {
  /** Total physical RAM (bytes) — normally `os.totalmem()`. */
  readonly totalRamBytes: number;
  /** Resident model weights (bytes). */
  readonly modelWeightsBytes: number;
  /** RAM cost (bytes) of ONE full-context (16384) KV slot. */
  readonly perSlotKvBytes: number;
  /** Held-back headroom (bytes); default {@link CORP_RESERVE_BYTES} (2 GB). */
  readonly reserveBytes?: number;
  /** Fraction of RAM treated as usable; default {@link CORP_USABLE_FRACTION}. */
  readonly usableFraction?: number;
  /** Upper bound on K; default {@link CORP_MAX_CONCURRENCY} (3). */
  readonly maxK?: number;
}

/** The chosen K plus the RAM basis it was derived from — handy for logging. */
export interface CorpConcurrencyBasis {
  readonly concurrency: number;
  readonly totalRamBytes: number;
  readonly modelWeightsBytes: number;
  readonly perSlotKvBytes: number;
  readonly usableBytes: number;
  readonly availableBytes: number;
  readonly maxK: number;
}

/** A finite, positive number → itself; anything else → `fallback`. */
function finitePositive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Compute K AND the RAM basis it came from.
 *
 *   usable    = totalRam × usableFraction
 *   available = usable − weights − reserve
 *   K         = clamp(floor(available / perSlotKv), 1, maxK)
 *
 * Sequential-by-default: any degenerate/tight case (non-finite inputs, a
 * non-positive per-slot budget, or `available < perSlotKv`) collapses to K = 1.
 */
export function corpConcurrencyBasis(input: PickCorpConcurrencyInput): CorpConcurrencyBasis {
  const usableFraction = finitePositive(
    input.usableFraction ?? CORP_USABLE_FRACTION,
    CORP_USABLE_FRACTION,
  );
  const reserveBytes = Number.isFinite(input.reserveBytes)
    ? (input.reserveBytes as number)
    : CORP_RESERVE_BYTES;
  // maxK: floor a finite value ≥ 1, else fall back to the default ceiling.
  const maxK =
    Number.isFinite(input.maxK) && (input.maxK as number) >= 1
      ? Math.floor(input.maxK as number)
      : CORP_MAX_CONCURRENCY;

  const totalRamBytes = input.totalRamBytes;
  const modelWeightsBytes = input.modelWeightsBytes;
  const perSlotKvBytes = input.perSlotKvBytes;

  const usableBytes = totalRamBytes * usableFraction;
  const availableBytes = usableBytes - modelWeightsBytes - reserveBytes;

  const basis = {
    totalRamBytes,
    modelWeightsBytes,
    perSlotKvBytes,
    usableBytes,
    availableBytes,
    maxK,
  };

  // A meaningless per-slot budget (≤ 0 or non-finite) or non-finite headroom
  // gives us nothing to reason about → stay sequential.
  if (!Number.isFinite(perSlotKvBytes) || perSlotKvBytes <= 0 || !Number.isFinite(availableBytes)) {
    return { ...basis, concurrency: 1 };
  }

  const raw = Math.floor(availableBytes / perSlotKvBytes);
  // clamp to [1, maxK]: a floor of ≤ 0 (no room for even one extra slot) → 1.
  const concurrency = Math.max(1, Math.min(maxK, raw));
  return { ...basis, concurrency };
}

/**
 * OOM-safe concurrency K for the corp: an integer in [1, maxK]. Sequential (1)
 * by default and on every degenerate/tight input. See {@link corpConcurrencyBasis}.
 */
export function pickCorpConcurrency(input: PickCorpConcurrencyInput): number {
  return corpConcurrencyBasis(input).concurrency;
}

/**
 * Convenience caller for THIS machine: reads `os.totalmem()` and applies the
 * qwen3.5-4b-mtp Q8 constants, returning the chosen K and its RAM basis (for a
 * log line). `totalRamBytes` is injectable so the wiring stays unit-testable.
 */
export function corpConcurrencyForHost(
  totalRamBytes: number = os.totalmem(),
): CorpConcurrencyBasis {
  return corpConcurrencyBasis({
    totalRamBytes,
    modelWeightsBytes: QWEN_CORP_MODEL_WEIGHTS_BYTES,
    perSlotKvBytes: QWEN_CORP_PER_SLOT_KV_BYTES,
    reserveBytes: CORP_RESERVE_BYTES,
    usableFraction: CORP_USABLE_FRACTION,
    maxK: CORP_MAX_CONCURRENCY,
  });
}
