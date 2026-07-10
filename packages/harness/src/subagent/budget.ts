/**
 * Memory-aware concurrency budget for subagents.
 *
 * Each subagent is a child `pi` process that runs its own agent loop and talks
 * to the SAME local inference server the parent uses — so its marginal cost is
 * the child process itself plus the extra concurrent inference pressure, not a
 * second copy of the model weights (those are already resident). A subagent that
 * requests a DIFFERENT model, though, forces another model to load, which is
 * genuinely expensive — callers can declare that via a per-task RAM estimate.
 *
 * The budget is derived from detected RAM + logical CPU count (mirroring how
 * {@link @pi-desktop/inference}'s recommender sizes models off `HardwareInfo`).
 * When the host is small (low RAM / single core) or there is no utility model
 * endpoint configured, the budget collapses to a conservative concurrency of 1
 * rather than spawning children blindly.
 *
 * Pure ({@link computeConcurrencyBudget}) so it unit-tests without probing the
 * host; {@link detectBudget} wires it to `node:os`.
 */

import { cpus, totalmem } from 'node:os';

/** Inputs to the pure budget computation. All RAM figures are whole GiB. */
export interface BudgetInputs {
  /** Total physical RAM (GiB). 0 when unknown → treated as low-RAM. */
  readonly totalRamGB: number;
  /** Logical CPU count. 0/undefined → treated as single-core. */
  readonly cpuCount: number;
  /** Whether a utility-model endpoint is configured (drives fixer/child agents).
   * Absent → concurrency 1 (a child agent with no model to talk to is useless). */
  readonly hasUtilityModel: boolean;
  /** Estimated RAM a single subagent costs by default (GiB). Default 1.5. */
  readonly perAgentGB?: number;
  /** RAM reserved for the OS + desktop app + the already-running parent/model
   * (GiB). Default 4. */
  readonly reserveGB?: number;
  /** Absolute ceiling regardless of a beefy host. Default 4. */
  readonly hardCap?: number;
}

/** The computed budget the scheduler enforces. */
export interface ConcurrencyBudget {
  /** Max subagents that may run at once (always >= 1). */
  readonly maxConcurrency: number;
  /** RAM (GiB) available to divide among concurrent subagents. */
  readonly ramBudgetGB: number;
  /** Default per-agent RAM estimate used when a task doesn't declare its own. */
  readonly perAgentGB: number;
  /** Human-readable explanation (shown in the panel + tool errors). */
  readonly reason: string;
}

export const DEFAULT_PER_AGENT_GB = 1.5;
export const DEFAULT_RESERVE_GB = 4;
export const DEFAULT_HARD_CAP = 4;
/** At or below this total RAM the host is "small" → concurrency 1. */
export const LOW_RAM_GB = 8;

/**
 * Compute the concurrency + RAM budget for subagents. Pure. Guarantees
 * `maxConcurrency >= 1` and `ramBudgetGB >= perAgentGB` so at least one subagent
 * can always run (it just runs alone on a constrained host).
 */
export function computeConcurrencyBudget(inputs: BudgetInputs): ConcurrencyBudget {
  const perAgentGB = inputs.perAgentGB ?? DEFAULT_PER_AGENT_GB;
  const reserveGB = inputs.reserveGB ?? DEFAULT_RESERVE_GB;
  const hardCap = Math.max(1, inputs.hardCap ?? DEFAULT_HARD_CAP);
  const totalRamGB = Number.isFinite(inputs.totalRamGB) ? Math.max(0, inputs.totalRamGB) : 0;
  const cpuCount = Number.isFinite(inputs.cpuCount) ? Math.max(0, inputs.cpuCount) : 0;

  // Conservative floors: no model to drive children, an unknown/small host, or a
  // single core → run one subagent at a time (never zero — one is always safe).
  if (!inputs.hasUtilityModel) {
    return {
      maxConcurrency: 1,
      ramBudgetGB: perAgentGB,
      perAgentGB,
      reason: 'No utility model endpoint configured — subagents run one at a time.',
    };
  }
  if (totalRamGB > 0 && totalRamGB <= LOW_RAM_GB) {
    return {
      maxConcurrency: 1,
      ramBudgetGB: perAgentGB,
      perAgentGB,
      reason: `Low RAM (${totalRamGB} GB) — subagents run one at a time.`,
    };
  }
  if (cpuCount <= 1) {
    return {
      maxConcurrency: 1,
      ramBudgetGB: perAgentGB,
      perAgentGB,
      reason: 'Single logical CPU — subagents run one at a time.',
    };
  }

  // RAM available for subagents after reserving headroom for the parent + OS.
  const ramBudgetGB = Math.max(perAgentGB, totalRamGB - reserveGB);
  const byRam = Math.max(1, Math.floor(ramBudgetGB / perAgentGB));
  // Leave one core for the parent pi + the inference server's own threads.
  const byCpu = Math.max(1, cpuCount - 1);
  const maxConcurrency = Math.min(hardCap, byRam, byCpu);

  return {
    maxConcurrency,
    ramBudgetGB,
    perAgentGB,
    reason:
      `${maxConcurrency} concurrent subagents ` +
      `(${totalRamGB} GB RAM, ${cpuCount} cores, ~${perAgentGB} GB each).`,
  };
}

/** Structural override seam so {@link detectBudget} unit-tests without `node:os`. */
export interface HostProbe {
  totalRamGB?: number;
  cpuCount?: number;
}

/**
 * Detect the host budget from `node:os` (sync — `totalmem`/`cpus` don't spawn),
 * folding in whether a utility model is available. Overridable for tests.
 */
export function detectBudget(
  opts: { hasUtilityModel: boolean; perAgentGB?: number; probe?: HostProbe } = {
    hasUtilityModel: false,
  },
): ConcurrencyBudget {
  const totalRamGB = opts.probe?.totalRamGB ?? Math.round(totalmem() / 1024 ** 3);
  const cpuCount = opts.probe?.cpuCount ?? cpus().length;
  return computeConcurrencyBudget({
    totalRamGB,
    cpuCount,
    hasUtilityModel: opts.hasUtilityModel,
    ...(opts.perAgentGB !== undefined ? { perAgentGB: opts.perAgentGB } : {}),
  });
}
