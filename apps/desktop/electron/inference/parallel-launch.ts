/**
 * Fast-text multi-slot launch scaling for llama-server.
 *
 * CRITICAL llama.cpp semantic: `--parallel K` splits the `-c` context budget
 * ACROSS the K slots, so each slot sees `-c / K` tokens. The corp engineer turns
 * each need the FULL per-slot context (CONTEXT_CAP = 16384). Therefore, to launch
 * K slots that EACH get the full context, the server must be started with
 * `-c = perSlotContext × K` (not a fixed 16384).
 *
 * This is the pure seam supervisor-entry.ts uses to translate an OOM-safe
 * concurrency K (see corp/concurrency.ts) into the `{ parallel, contextSize }`
 * pair it hands the supervisor. Kept electron-free so it unit-tests directly.
 */

/** The `--parallel` count + total `-c` for a K-slot fast-text launch. */
export interface FastTextSlotLaunch {
  /** `--parallel` value (K), floored to ≥ 1. */
  readonly parallel: number;
  /** Total `-c` to pass the server: `perSlotContext × parallel`, so each of the
   * K slots gets the full `perSlotContext`. */
  readonly contextSize: number;
}

/**
 * Resolve the `{ parallel, contextSize }` for a K-slot fast-text launch so every
 * slot gets `perSlotContext` tokens. `parallel` defaults to 1 (single slot,
 * `contextSize === perSlotContext` — byte-for-byte the original launch); values
 * below 1 (or non-finite) are clamped up to 1.
 */
export function fastTextSlotLaunch(
  perSlotContext: number,
  parallel: number | undefined,
): FastTextSlotLaunch {
  const k = Number.isFinite(parallel) ? Math.max(1, Math.floor(parallel as number)) : 1;
  return { parallel: k, contextSize: perSlotContext * k };
}
