/**
 * Per-turn loop / no-progress detector (harness fix #3).
 *
 * Rung-5 abort (repair/rungs.ts) only fires on ARG-repair failures — malformed
 * tool-call JSON. A model that emits WELL-FORMED tool calls but keeps calling the
 * SAME thing, or keeps hitting tool-execution ERRORS, was never caught, and there
 * was no max-iteration cap anywhere. This detector closes both gaps:
 *
 *   - identical-call streak: N consecutive tool calls with the same name + args
 *     (a stable signature) → one corrective steer, then abort past a 2nd threshold.
 *   - consecutive-error streak: N consecutive tool executions that ERROR → same
 *     escalation (steer once, then abort).
 *   - unproductive-wandering cap: N consecutive READ-ONLY / exploration calls
 *     (read/ls/find/grep/tool_search/update_plan) with NO concrete action in
 *     between — the failure the signature streak MISSES, because reading ten
 *     DIFFERENT files is ten different signatures. One "you've explored enough,
 *     act now" steer, then abort past a higher, effort-scaled threshold.
 *   - hard step cap: a generous, effort-scaled per-turn tool-call backstop that
 *     aborts even if none of the streaks trip (a slow, wandering non-loop).
 *
 * It is a pure state machine: the wiring (index.ts) feeds it the `tool_call` and
 * `tool_execution_end` events and acts on the returned {@link LoopSignal} (send a
 * steer / call ctx.abort). Reset per user turn. Fully unit-testable without a live
 * session — see loop-detector.test.ts.
 */

import type { EffortKnobs } from '../effort/effort.js';

/** Why the detector escalated. */
export type LoopCause = 'identical' | 'error' | 'cap' | 'wander';

/** The action the wiring should take after feeding an event. */
export type LoopSignal =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'steer';
      readonly cause: LoopCause;
      readonly reason: string;
      readonly message: string;
    }
  | { readonly kind: 'abort'; readonly cause: LoopCause; readonly reason: string };

const NONE: LoopSignal = { kind: 'none' };

/** Thresholds driving the detector. `abortAfter` must be > `steerAfter`. */
export interface LoopDetectorConfig {
  /** Consecutive identical calls / errors that fire the single corrective steer. */
  readonly steerAfter: number;
  /** Consecutive ERRORS that fire the abort. (The identical-call abort is now
   * WALL-CLOCK — see {@link repeatWallMs} — not this count, per jedd: a genuine
   * loop is "the same call still repeating minutes later", and a fast burst of a
   * few identical calls is not yet a loop.) */
  readonly abortAfter: number;
  /**
   * Wall-clock window (ms) for the identical-call abort: the SAME tool call
   * (name + args) must keep repeating for at least this long before it aborts.
   * Reading DIFFERENT files never trips this (each is a distinct signature that
   * restarts the streak + its clock). Omitted → {@link DEFAULT_REPEAT_WALL_MS}.
   */
  readonly repeatWallMs?: number;
  /** Clock source (injectable for tests). Omitted → {@link Date.now}. */
  readonly now?: () => number;
  /** Hard per-turn tool-call cap (a generous backstop) that aborts. */
  readonly maxSteps: number;
  /**
   * Consecutive read-only/exploration calls (no concrete action between them)
   * that fire the single "act now" steer. Omitted → {@link DEFAULT_WANDER_STEER_AFTER}.
   */
  readonly wanderSteerAfter?: number;
  /**
   * Consecutive read-only/exploration calls that abort the turn. Must be >
   * `wanderSteerAfter`. Omitted → {@link DEFAULT_WANDER_ABORT_AFTER}.
   */
  readonly wanderAbortAfter?: number;
  /** Rolling recent-signature window kept for telemetry/introspection. Default 8. */
  readonly windowSize?: number;
}

/** Default streak thresholds (kept constant across effort — a loop is a loop). */
export const DEFAULT_LOOP_STEER_AFTER = 3;
export const DEFAULT_LOOP_ABORT_AFTER = 5;
/** Wall-clock window for the identical-call abort (jedd): the SAME call must keep
 * repeating for 3 minutes before it's treated as a stuck loop and aborted. */
export const DEFAULT_REPEAT_WALL_MS = 3 * 60 * 1000;

/**
 * Default unproductive-wandering thresholds, used when a {@link LoopDetectorConfig}
 * omits them. The live harness always supplies effort-scaled values via
 * {@link loopDetectorConfig}; these are the fallback for hand-built configs/tests.
 */
export const DEFAULT_WANDER_STEER_AFTER = 6;
export const DEFAULT_WANDER_ABORT_AFTER = 10;

/**
 * Read-only / exploration tools that, on their own, make NO durable progress:
 * reading a file, listing/finding/grepping the filesystem, searching for a tool,
 * or (re)writing the plan. A run built ONLY from these — however many DIFFERENT
 * files it reads — is wandering, not working, and the signature streak can't see
 * it (each read is a distinct signature). Every tool NOT in this set counts as a
 * concrete ACTION (write/edit/bash/answer/a real connector or generation call)
 * that resets the unproductive streak. Kept deliberately narrow: only tools that
 * are unambiguously read-only local exploration. `web_search`/`web_fetch` are
 * intentionally EXCLUDED — for a research task they ARE the work.
 */
export const EXPLORATION_TOOLS: ReadonlySet<string> = new Set<string>([
  'read',
  'read_file',
  'ls',
  'list',
  'list_dir',
  'list_directory',
  'find',
  'glob',
  'grep',
  'tool_search',
  'update_plan',
]);

/** True when a tool call is pure read-only exploration (see {@link EXPLORATION_TOOLS}). */
export function isExplorationTool(toolName: string): boolean {
  return EXPLORATION_TOOLS.has(toolName);
}

/**
 * Build a detector config from the effort knobs: the identical/error streak
 * thresholds are fixed (a 3-in-a-row repeat is a loop regardless of effort),
 * while the hard step cap AND the unproductive-wandering thresholds scale with
 * effort (a "max" run may gather more context / grind far longer than a "low" one).
 */
export function loopDetectorConfig(knobs: EffortKnobs): LoopDetectorConfig {
  return {
    steerAfter: DEFAULT_LOOP_STEER_AFTER,
    abortAfter: DEFAULT_LOOP_ABORT_AFTER,
    maxSteps: knobs.maxTurnSteps,
    wanderSteerAfter: knobs.wanderSteerAfter,
    wanderAbortAfter: knobs.wanderAbortAfter,
  };
}

/** A live, per-turn snapshot for telemetry / tests. */
export interface LoopSnapshot {
  readonly steps: number;
  readonly identicalStreak: number;
  readonly errorStreak: number;
  /** Consecutive read-only/exploration calls since the last concrete action. */
  readonly unproductiveStreak: number;
  readonly steered: boolean;
  readonly lastSignature: string | null;
  readonly recent: readonly string[];
}

/** Deterministic stringify: sorts object keys so key order can't change the hash. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** FNV-1a 32-bit hash → short hex. Keeps signatures compact for large args. */
function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Stable signature of a tool call: name + a hash of its (key-order-independent) args. */
export function toolCallSignature(toolName: string, args: unknown): string {
  return `${toolName}#${hashString(stableStringify(args ?? null))}`;
}

const STEER_IDENTICAL =
  "You've called the same tool with the same arguments several times in a row without making progress. Stop repeating that call — try a different approach, different arguments, or a different tool. If you're stuck, say so or ask the user.";
const STEER_ERROR =
  'Your last several tool calls all failed with errors. Stop and reconsider before trying again — a different approach or a different tool is likely needed, or you may need to ask the user for help.';
const STEER_WANDER =
  "You've spent several tool calls only reading, listing, and searching — you haven't taken any concrete action yet. You've explored enough. Do the task NOW: if it asks you to write or create something, write the file with your write tool; if it needs a specific capability (calendar, mail, etc.), call that tool directly. Stop reading more files and act.";

/**
 * The per-turn loop detector. Create one per user turn (or call {@link reset}).
 * Feed it every tool call and every tool-execution outcome; act on the signal.
 */
export interface LoopDetector {
  /**
   * Record a tool call BEFORE it executes (hook `tool_call`). Counts a step
   * against the hard cap and tracks the identical-call streak.
   */
  onToolCall(toolName: string, args: unknown): LoopSignal;
  /**
   * Record a tool-execution outcome AFTER it runs (hook `tool_execution_end`).
   * Tracks the consecutive-error streak.
   */
  onToolResult(isError: boolean): LoopSignal;
  /** Clear all per-turn state (call at the start of each user turn). */
  reset(): void;
  /** Introspection for telemetry / tests. */
  snapshot(): LoopSnapshot;
}

/** Human-readable escalation reason per cause (differs slightly steer vs abort). */
function reasonFor(cause: LoopCause, streak: number, aborting: boolean): string {
  switch (cause) {
    case 'identical':
      return aborting
        ? `stuck repeating the same tool call for minutes without progress (${streak}×)`
        : `same tool call repeated ${streak}×`;
    case 'error':
      return aborting
        ? `${streak} consecutive tool executions failed`
        : `${streak} consecutive tool errors`;
    case 'wander':
      return aborting
        ? `explored ${streak} read-only calls in a row without taking a concrete action`
        : `${streak} read-only/exploration calls with no concrete action yet`;
    case 'cap':
      return `exceeded the per-turn tool-call cap`;
  }
}

export function createLoopDetector(config: LoopDetectorConfig): LoopDetector {
  const windowSize = Math.max(1, config.windowSize ?? 8);
  const wanderSteerAfter = config.wanderSteerAfter ?? DEFAULT_WANDER_STEER_AFTER;
  const repeatWallMs = config.repeatWallMs ?? DEFAULT_REPEAT_WALL_MS;
  const now = config.now ?? Date.now;
  let steps = 0;
  let identicalStreak = 0;
  // Wall-clock start of the CURRENT identical-call streak (reset whenever the
  // signature changes — a different tool OR different args, e.g. reading a
  // different file, starts a fresh streak + clock).
  let identicalStreakStart = now();
  let errorStreak = 0;
  // Consecutive read-only/exploration calls since the last concrete action.
  let unproductiveStreak = 0;
  // Exactly ONE corrective steer per turn (across ALL streak causes), matching
  // "inject ONE corrective steer … and, if it continues, abort".
  let steered = false;
  let lastSignature: string | null = null;
  const recent: string[] = [];

  /** Escalate a streak to steer/abort, honoring the one-steer-per-turn rule. */
  function escalate(
    streak: number,
    cause: LoopCause,
    message: string,
    steerAfter: number,
    abortAfter: number,
  ): LoopSignal {
    if (streak >= abortAfter) {
      return { kind: 'abort', cause, reason: reasonFor(cause, streak, true) };
    }
    if (streak >= steerAfter && !steered) {
      steered = true;
      return { kind: 'steer', cause, reason: reasonFor(cause, streak, false), message };
    }
    return NONE;
  }

  return {
    onToolCall(toolName, args) {
      steps += 1;
      const t = now();
      const sig = toolCallSignature(toolName, args);
      if (sig === lastSignature) {
        identicalStreak += 1;
      } else {
        // A different tool OR different args (e.g. a DIFFERENT file read) starts a
        // fresh streak AND restarts its wall clock — so productive exploration
        // across many files never trips the repeat guard (jedd).
        identicalStreak = 1;
        identicalStreakStart = t;
      }
      lastSignature = sig;
      recent.push(sig);
      if (recent.length > windowSize) recent.shift();

      // Productivity tracking: a read-only/exploration call climbs the streak; any
      // concrete action (write/edit/bash/answer/connector/gen call …) resets it.
      unproductiveStreak = isExplorationTool(toolName) ? unproductiveStreak + 1 : 0;

      // Hard cap wins first: a runaway turn aborts regardless of the streaks.
      if (steps > config.maxSteps) {
        return {
          kind: 'abort',
          cause: 'cap',
          reason: `exceeded the per-turn tool-call cap (${config.maxSteps})`,
        };
      }
      // Identical-call loop (jedd): ABORT only once the SAME call (name + args) has
      // been repeating for the wall-clock window — a fast burst of a few identical
      // calls is not yet a stuck loop; a call still repeating minutes later is. One
      // early corrective steer at the count threshold nudges before the timeout.
      if (identicalStreak >= 2 && t - identicalStreakStart >= repeatWallMs) {
        return {
          kind: 'abort',
          cause: 'identical',
          reason: reasonFor('identical', identicalStreak, true),
        };
      }
      if (identicalStreak >= config.steerAfter && !steered) {
        steered = true;
        return {
          kind: 'steer',
          cause: 'identical',
          reason: reasonFor('identical', identicalStreak, false),
          message: STEER_IDENTICAL,
        };
      }
      // Unproductive wandering: many DIFFERENT exploration calls with no action.
      // jedd: reading different files must NOT abort — so this only ever STEERS
      // (one gentle nudge), never aborts (Infinity abort threshold). The hard step
      // cap above is the runaway backstop.
      return escalate(
        unproductiveStreak,
        'wander',
        STEER_WANDER,
        wanderSteerAfter,
        Number.POSITIVE_INFINITY,
      );
    },

    onToolResult(isError) {
      errorStreak = isError ? errorStreak + 1 : 0;
      if (errorStreak === 0) return NONE;
      return escalate(errorStreak, 'error', STEER_ERROR, config.steerAfter, config.abortAfter);
    },

    reset() {
      steps = 0;
      identicalStreak = 0;
      identicalStreakStart = now();
      errorStreak = 0;
      unproductiveStreak = 0;
      steered = false;
      lastSignature = null;
      recent.length = 0;
    },

    snapshot() {
      return {
        steps,
        identicalStreak,
        errorStreak,
        unproductiveStreak,
        steered,
        lastSignature,
        recent: [...recent],
      };
    },
  };
}
