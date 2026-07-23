/**
 * Per-hardware llama-server performance launch args.
 *
 * This module is the "aggressive adaptation per hardware" seam (jedd, roadmap.md
 * line 1). Its central, measured finding is deliberately conservative:
 *
 *   On Apple Silicon (Metal) with the pinned llama.cpp (b9934), the server's OWN
 *   `auto` defaults are already optimal — so with RAM headroom we add NOTHING and
 *   let the auto-tuner win. Forcing the "obvious" perf flags does not help:
 *
 *   Measured on an M5 Pro / 24GB / Qwen3.5-4B-Q8_0 (see scratch/prefill-bench.mjs,
 *   scratch/bench2.mjs), vs the current baseline launch args:
 *     · `-fa on`                → within ±2% (auto already enables flash-attn)
 *     · `-ngl 999`              → no-op (auto already offloads all layers)
 *     · `-ub 1024/2048`, `-b`   → no gain (Metal is saturated at the 512 default;
 *                                 larger physical batch was marginally SLOWER)
 *     · `--mlock`, `-t 5`       → within noise (GPU-bound; weights already resident)
 *     · `--cache-reuse 256`     → no measurable effect; did NOT heal an early-prefix
 *                                 churn (that is a prefix-stability problem, handled
 *                                 in the harness, not a server-flag one)
 *     · `--cache-type q8_0`     → 6-8% SLOWER prefill AND decode than the f16 default
 *
 *   KV prefix reuse across turns already works by default (a follow-up reused
 *   972/1000 prompt tokens; only the appended delta was re-prefilled), so the
 *   turn-to-turn "instant follow-up" path needs no flag help.
 *
 * The ONE adaptive intervention on Apple Silicon is therefore a memory-pressure
 * fallback: when the estimated footprint (weights + KV + overhead) would exceed a
 * safe fraction of unified RAM, switch the KV cache to q8_0 (which requires
 * flash-attn). That roughly halves KV memory so a big model / long context fits in
 * RAM instead of swapping — trading the measured ~7% throughput for avoiding
 * page-fault stalls that cost far more than 7% (multi-second hitches). It fires
 * only under real pressure; on a machine with headroom it never triggers.
 *
 * Non-Apple-Silicon (CUDA / ROCm / Intel-Vulkan) is NOT testable on this Metal
 * machine, so those branches encode conservative, community-standard defaults and
 * a clear extension TODO (real per-GPU tuning needs a VRAM probe that hardware.ts
 * does not have yet — it reads system RAM only). See {@link chooseServerPerfArgs}.
 *
 * Pure + dependency-light so it unit-tests without spawning anything.
 */
import { estimateRamGB } from './hf-search.js';

/** Inputs to the per-hardware arg chooser. All fields are cheap to obtain at the
 * launch site (HardwareInfo + the resolved catalog file + resolved context). */
export interface PerfArgsInput {
  /** From HardwareInfo.isAppleSilicon — the measured-optimal Metal path. */
  readonly isAppleSilicon: boolean;
  /** Total unified/system RAM in GB (HardwareInfo.totalRamGB). */
  readonly totalRamGB: number;
  /** GGUF weight bytes of the model being launched (CatalogFile.bytes). */
  readonly modelBytes: number;
  /** Resolved server context size (`-c`). Drives the KV footprint estimate. */
  readonly contextSize: number;
  /** Logical CPU count if known (HardwareInfo.cpuCount). Currently informational. */
  readonly cpuCount?: number;
}

export interface PerfArgsResult {
  /** Extra llama-server args to append (may be empty — the common Metal case). */
  readonly args: string[];
  /** Human-readable reasons, for the launch log and diagnostics. */
  readonly rationale: string[];
}

/**
 * Fraction of RAM above which we consider the launch memory-pressured and apply
 * the q8_0-KV fallback. 0.8 leaves ~20% for the OS, other apps, and compute
 * buffers so we degrade gracefully rather than swap. Matches the spirit of the
 * recommender's headroom step-down.
 */
export const MEMORY_PRESSURE_FRACTION = 0.8;

/**
 * Choose per-hardware llama-server performance args.
 *
 * Returns `{ args: [] }` for the overwhelmingly common Apple-Silicon-with-headroom
 * case — by design, because the server's auto defaults are measured-optimal there
 * (see the module header). The returned `rationale` explains every decision so the
 * launch is self-documenting.
 */
export function chooseServerPerfArgs(input: PerfArgsInput): PerfArgsResult {
  const args: string[] = [];
  const rationale: string[] = [];

  const footprintGB = estimateRamGB(input.modelBytes, input.contextSize);
  const pressure =
    input.totalRamGB > 0 && footprintGB > input.totalRamGB * MEMORY_PRESSURE_FRACTION;

  if (input.isAppleSilicon) {
    if (pressure) {
      // Halve KV memory to fit weights+cache in unified RAM instead of swapping.
      // q8_0 KV requires flash-attn to be on. Measured cost ~6-8%; the benefit is
      // avoiding multi-second page-fault stalls, so it is net-positive under
      // pressure only (never applied when there is headroom).
      args.push('-fa', 'on', '--cache-type-k', 'q8_0', '--cache-type-v', 'q8_0');
      rationale.push(
        `apple-silicon memory pressure: est ~${footprintGB}GB > ${Math.round(
          input.totalRamGB * MEMORY_PRESSURE_FRACTION,
        )}GB (80% of ${input.totalRamGB}GB) → q8_0 KV + flash-attn to avoid swap`,
      );
    } else {
      rationale.push(
        'apple-silicon with headroom: no extra args — llama.cpp auto (-ngl/-fa/-ub/threads) is measured-optimal',
      );
    }
    return { args, rationale };
  }

  // -------- Non-Apple-Silicon: CUDA / ROCm / Intel-Vulkan (UNTESTED here) --------
  // Conservative, community-standard defaults. NOT validated on this Metal machine
  // — flagged so jedd can confirm on real AMD/Intel/NVIDIA hardware.
  //
  //  · `-fa on`: flash-attn is a clear prefill + KV-memory win on CUDA and is
  //    supported on modern ROCm/Vulkan builds; where unsupported the server falls
  //    back safely. (On Metal we do NOT force it — auto already enables it.)
  //  · `-ngl`: LEFT TO AUTO on purpose. Forcing a large value risks OOM on a
  //    small-VRAM discrete card; auto offloads as many layers as VRAM allows, which
  //    is the correct cross-hardware default.
  //
  // TODO(vram-probe): real per-GPU adaptation (partial-offload sizing, KV type by
  // VRAM) needs VRAM detection — hardware.ts only reads system RAM via sysctl
  // (macOS-only). Add nvidia-smi / rocm-smi / DXGI probing, then gate the q8-KV
  // fallback on VRAM here instead of the system-RAM proxy below.
  args.push('-fa', 'on');
  rationale.push(
    'discrete GPU (untested on this machine): flash-attn on, layer offload auto; VRAM-aware tuning is a TODO (needs nvidia-smi/rocm-smi probe)',
  );
  if (pressure) {
    args.push('--cache-type-k', 'q8_0', '--cache-type-v', 'q8_0');
    rationale.push(
      `system-RAM pressure proxy: est ~${footprintGB}GB > 80% of ${input.totalRamGB}GB → q8_0 KV`,
    );
  }
  return { args, rationale };
}
