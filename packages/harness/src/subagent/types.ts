/**
 * Shared types + wire contract for the subagent feature.
 *
 * The harness spawns child pi agents ("subagents"); only a concise summary of
 * each child returns to the parent context. Live progress is streamed to the
 * desktop over the SAME setStatus channel the plan/checklist uses, under a
 * distinct status key ({@link HARNESS_SUBAGENTS_STATUS_KEY}). The renderer
 * decodes {@link HarnessSubagentsStatus} and maps it onto the canvas
 * SubagentSurface (structurally the canvas `SubagentItem`).
 */

/** setStatus key the harness publishes live subagent progress under. Mirror of
 * the `'harness'` key used for the config/plan status. The desktop reads it via
 * `usePiStore(s => s.extensionStatus['harness-subagents'])`. */
export const HARNESS_SUBAGENTS_STATUS_KEY = 'harness-subagents';

/** Name of the subagent-spawning tool. Declared in this pure module so both the
 * tool registration AND the preset always-active list can reference it without a
 * heavy (pi ExtensionAPI) import. */
export const SPAWN_SUBAGENT_TOOL_NAME = 'spawn_subagent';

/**
 * Env var carrying the subagent nesting depth. A freshly-spawned desktop pi has
 * it unset (depth 0). A child pi the harness spawns inherits `depth+1`; the
 * harness in that child sees `>= 1` and does NOT register the spawn tool, so
 * subagents can't recursively spawn subagents (nested subagents are deferred —
 * flip {@link maxSubagentDepth} to allow them).
 */
export const SUBAGENT_DEPTH_ENV = 'PI_DESKTOP_SUBAGENT_DEPTH';

/** Max nesting depth at which the spawn tool is registered. v1 = 1 (top level
 * only). Raising this enables nested subagents. */
export const MAX_SUBAGENT_DEPTH = 1;

/** Lifecycle of one subagent, mirroring the canvas `SubagentItem['status']`. */
export type SubagentStatus = 'queued' | 'running' | 'done' | 'error';

/** One subagent row streamed to the renderer. Structurally compatible with the
 * canvas `SubagentItem` (id/name/step/status) so the desktop maps it 1:1. */
export interface SubagentStatusItem {
  readonly id: string;
  readonly name: string;
  /** Current step ("Reading files…"); shimmered while running. */
  readonly step?: string;
  readonly status: SubagentStatus;
  /** The ordered tool/step labels the subagent ran — its activity timeline, for
   * the "view work" detail (the child's full transcript never crosses back, but
   * the sequence of tools it used does). */
  readonly activity?: readonly string[];
  /** The subagent's full final output (its summary), or the error message — set
   * once it finishes. This is the same summary that returns to the parent chat;
   * carried here so the panel can show the child's work on click. */
  readonly output?: string;
}

/** The JSON payload published under {@link HARNESS_SUBAGENTS_STATUS_KEY}. */
export interface HarnessSubagentsStatus {
  readonly subagents: readonly SubagentStatusItem[];
  /** The memory/concurrency budget in force, for the panel's footer/tooltip. */
  readonly budget?: {
    readonly maxConcurrency: number;
    readonly running: number;
    readonly queued: number;
    readonly reason: string;
  };
}

/** Read the current subagent depth from an env map (0 when unset/invalid). */
export function readSubagentDepth(env: Record<string, string | undefined>): number {
  const raw = env[SUBAGENT_DEPTH_ENV];
  const n = raw === undefined ? 0 : Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
