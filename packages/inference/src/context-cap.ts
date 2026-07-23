/**
 * Hardware-adaptive context-window cap (jedd, roadmap latency/endless-run work).
 *
 * The launch context used to be a flat `min(model.contextWindow, 16384)` — the
 * same 16k on a 128GB Mac Studio and an 8GB Air. jedd: "increase context window
 * probably to about 64k when able, making sure to take into account kv size when
 * doing memory calculations for subagents and such."
 *
 * So this picks the LARGEST per-slot context (≤ 64k, ≤ the model's own max) whose
 * whole footprint — weights (shared) + `slots` × KV(context) + OS/runtime
 * overhead — fits inside a safe fraction of system RAM. On a roomy machine a
 * small model lands at the 64k ceiling; on a tight one, or when spinning up K
 * parallel subagent slots (each holding its own KV), it steps down a ladder until
 * it fits, never below a floor. A bigger `-c` does NOT slow TTFT (that scales with
 * the actual prompt, not the window) — it just lets a conversation run much longer
 * before pi has to compact, which is the "run effectively endlessly" half.
 *
 * Pure + electron-free so it unit-tests without spawning a server. Reuses the
 * same KV heuristic as {@link estimateRamGB} (calibrated against the catalog's
 * hand-set minRamGB) but makes the KV term SLOT-aware.
 */

/** jedd's target ceiling — ~64k when the machine can afford it. */
export const CONTEXT_CEILING = 65_536;
/** Never launch below this — even a tight machine keeps a usable window. */
export const CONTEXT_FLOOR = 8_192;
/** Fraction of system RAM the whole launch (weights + all slots' KV + overhead)
 * may occupy. 0.8 leaves ~20% for the OS, other apps, and compute buffers —
 * mirrors the perf-args memory-pressure fraction. */
export const DEFAULT_MEMORY_FRACTION = 0.8;

/** Descending ladder of candidate per-slot context sizes (powers/·1.5 of 8k up to
 * the 64k ceiling). The largest that fits wins. */
export const CONTEXT_STEPS: readonly number[] = [
  65_536, 49_152, 32_768, 24_576, 16_384, 12_288, 8_192,
];

/**
 * RAM (GiB) for a launch holding `slots` KV caches of `contextWindow` tokens
 * each, sharing one copy of the weights. Extends {@link estimateRamGB}'s heuristic
 * (weights + weights·(ctx/32768)·0.2 + 1GB overhead) by multiplying ONLY the KV
 * term by the slot count — the weights are resident once regardless of slots.
 */
export function estimateLaunchRamGB(
  sizeBytes: number,
  contextWindow: number,
  slots = 1,
): number {
  const weightsGB = sizeBytes / 1024 ** 3;
  const ctx = contextWindow > 0 ? contextWindow : CONTEXT_FLOOR;
  const k = Number.isFinite(slots) ? Math.max(1, Math.floor(slots)) : 1;
  const kvGB = weightsGB * (ctx / 32_768) * 0.2 * k; // KV + compute buffers, per slot
  const overheadGB = 1; // OS + runtime headroom
  return weightsGB + kvGB + overheadGB;
}

export interface ContextCapInput {
  /** GGUF weight bytes of the model being launched (CatalogFile.bytes). */
  readonly modelBytes: number;
  /** The model's own maximum context (model.contextWindow) — a hard ceiling. */
  readonly modelMaxContext: number;
  /** Total system/unified RAM in GB (HardwareInfo.totalRamGB). */
  readonly totalRamGB: number;
  /** Parallel slots that will EACH hold a KV cache (corp fan-out K; default 1). */
  readonly slots?: number;
  /** RAM fraction the whole launch may use (default {@link DEFAULT_MEMORY_FRACTION}). */
  readonly memoryFraction?: number;
  /** Upper bound to consider (default {@link CONTEXT_CEILING} = ~64k). */
  readonly ceiling?: number;
}

/**
 * The largest per-slot context to launch with: the biggest ladder step that is
 * ≤ ceiling, ≤ the model's max, and whose `slots`-aware footprint fits in
 * `memoryFraction` of RAM. Falls back to `min(FLOOR, modelMax)` when even the
 * floor doesn't fit the estimate (best effort — the recommender already picks a
 * model that fits, so the floor almost always does).
 */
export function chooseContextCap(input: ContextCapInput): number {
  const {
    modelBytes,
    modelMaxContext,
    totalRamGB,
    slots = 1,
    memoryFraction = DEFAULT_MEMORY_FRACTION,
    ceiling = CONTEXT_CEILING,
  } = input;
  const hardMax = Math.min(
    ceiling,
    modelMaxContext > 0 ? modelMaxContext : ceiling,
  );
  const budgetGB = totalRamGB > 0 ? totalRamGB * memoryFraction : Number.POSITIVE_INFINITY;
  for (const step of CONTEXT_STEPS) {
    if (step > hardMax) continue;
    if (estimateLaunchRamGB(modelBytes, step, slots) <= budgetGB) return step;
  }
  // Nothing on the ladder fit — give the smallest usable window the model allows.
  return Math.min(CONTEXT_FLOOR, hardMax);
}
