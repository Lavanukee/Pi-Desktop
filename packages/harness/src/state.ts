/**
 * Harness state: the config the app reads/writes and the status object the app
 * renders. Config is persisted with `pi.appendEntry` (survives reload, shared
 * with CLI pi) and restored on `session_start`.
 */

import type { TaskClass } from './classify/classify.js';
import { type EffortLevel, isEffortLevel } from './effort/effort.js';
import { isPermissionMode, type PermissionMode } from './permissions/modes.js';

/** Custom session-entry types used for persistence (not sent to the LLM). */
export const HARNESS_CONFIG_ENTRY = 'harness/config';
export const HARNESS_CLASSIFY_ENTRY = 'harness/classify';
export const HARNESS_REPAIR_ENTRY = 'harness/repair';
/** Reviewer/adversarial pass outcome (effort high/max). */
export const HARNESS_REVIEW_ENTRY = 'harness/review';

/** Preset selection: a fixed class, or `auto` to let the classifier decide. */
export type PresetSelection = TaskClass | 'auto';

/** The user-tunable harness configuration the app reads. */
export interface HarnessConfig {
  readonly mode: PermissionMode;
  readonly effort: EffortLevel;
  readonly preset: PresetSelection;
}

export const DEFAULT_CONFIG: HarnessConfig = {
  mode: 'reviewer',
  effort: 'medium',
  preset: 'auto',
};

/** The full status object published via `ctx.ui.setStatus('harness', json)`. */
export interface HarnessStatus extends HarnessConfig {
  /** The class chosen for the current/last task (null before first classify). */
  readonly activeClass: TaskClass | null;
  /** Tools currently active after applying the preset. */
  readonly activeTools: readonly string[];
  /** Current model id, if any. */
  readonly model: string | null;
  /** Inferred model parameter count (billions), or null. */
  readonly modelParams: number | null;
  /** Context-window usage percentage, or null if unknown. */
  readonly contextPercent: number | null;
  /** Elapsed time of the in-flight task in ms, or null when idle. */
  readonly runningTaskMs: number | null;
  /** Per-tool repair failure counts this session. */
  readonly repairFailures: Readonly<Record<string, number>>;
}

/** Minimal structural view of a persisted session entry. */
export interface StoredEntryLike {
  readonly type: string;
  readonly customType?: string;
  readonly data?: unknown;
}

function isPresetSelection(v: unknown): v is PresetSelection {
  return typeof v === 'string';
}

/**
 * Reconstruct the harness config from session entries (last write wins),
 * validating each field and falling back to {@link DEFAULT_CONFIG}. Pure.
 */
export function restoreConfig(entries: readonly StoredEntryLike[]): HarnessConfig {
  let config: HarnessConfig = DEFAULT_CONFIG;
  for (const entry of entries) {
    if (entry.type !== 'custom' || entry.customType !== HARNESS_CONFIG_ENTRY) continue;
    const data = entry.data;
    if (data === null || typeof data !== 'object') continue;
    const d = data as Record<string, unknown>;
    config = {
      mode: typeof d.mode === 'string' && isPermissionMode(d.mode) ? d.mode : config.mode,
      effort: typeof d.effort === 'string' && isEffortLevel(d.effort) ? d.effort : config.effort,
      preset: isPresetSelection(d.preset) ? d.preset : config.preset,
    };
  }
  return config;
}

/** Apply a partial update, keeping only valid fields, and return a new config. */
export function updateConfig(current: HarnessConfig, patch: Partial<HarnessConfig>): HarnessConfig {
  return {
    mode: patch.mode !== undefined && isPermissionMode(patch.mode) ? patch.mode : current.mode,
    effort:
      patch.effort !== undefined && isEffortLevel(patch.effort) ? patch.effort : current.effort,
    preset: patch.preset !== undefined ? patch.preset : current.preset,
  };
}
