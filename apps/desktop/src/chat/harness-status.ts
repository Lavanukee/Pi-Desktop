/**
 * Renderer-side reader for the harness status the pi extension publishes via
 * `ctx.ui.setStatus('harness', <json>)` and `setStatus('harness-task', '⏱ Xs')`.
 * Those land in the pi-slice `extensionStatus` map (via the event-router); this
 * module parses the JSON blob into the typed {@link HarnessStatus} so the footer
 * status cluster, the checklist panel, and the Agent settings can read the live
 * active-class, running timer, repair counts, and plan.
 *
 * Type-only import from the harness package (erased at build — no runtime pull).
 */
import type { HarnessStage, HarnessStatus, PlanItem } from '@pi-desktop/harness';
import { useMemo } from 'react';
import { usePiStore } from '../state/pi-slice';

export type { HarnessStage, HarnessStatus, PlanItem };

/** Parse the published harness status JSON, tolerating absence/garbage. */
export function parseHarnessStatus(raw: string | undefined): HarnessStatus | null {
  if (raw === undefined || raw.length === 0) return null;
  try {
    return JSON.parse(raw) as HarnessStatus;
  } catch {
    return null;
  }
}

/** Live parsed harness status, or null when the harness hasn't published yet. */
export function useHarnessStatus(): HarnessStatus | null {
  const raw = usePiStore((s) => s.extensionStatus.harness);
  return useMemo(() => parseHarnessStatus(raw), [raw]);
}

/** Human label for a task class (falls back to the raw id, dashes → spaces). */
export function classLabel(cls: string | null | undefined): string | null {
  if (cls === null || cls === undefined) return null;
  return cls.replace(/-/g, ' ');
}

/** Presentational view of the harness lifecycle {@link HarnessStage}. */
export interface StageDisplay {
  /** Short verb label the footer renders, e.g. "Classifying". */
  readonly label: string;
  /**
   * Whether the stage is still in flight (`Classifying…`, subtle live tone) vs a
   * terminal one (`Done`). Drives the trailing ellipsis and the success tint.
   */
  readonly live: boolean;
}

/**
 * The user-facing verb for each stage the harness publishes. `idle` maps to
 * `null` (nothing to surface — hide the label). The keys are exhaustive over
 * {@link HarnessStage} so a newly added stage is a compile error until it gets a
 * label here — we never render a raw enum value, and never invent a stage the
 * harness doesn't publish.
 */
const STAGE_LABELS: Record<HarnessStage, string | null> = {
  idle: null,
  classifying: 'Classifying',
  working: 'Working',
  repairing: 'Repairing',
  reviewing: 'Reviewing',
  revising: 'Revising',
  verifying: 'Verifying',
  done: 'Done',
};

/**
 * Map a published harness {@link HarnessStage} to its footer display, or `null`
 * when there's nothing to show (idle, absent, or an unknown value from an older /
 * garbled status payload — the lookup tolerates keys outside the enum). Pure, so
 * the mapping is unit-tested without rendering.
 */
export function stageDisplay(stage: HarnessStage | null | undefined): StageDisplay | null {
  if (stage === null || stage === undefined) return null;
  const label = STAGE_LABELS[stage];
  if (label === null || label === undefined) return null;
  return { label, live: stage !== 'done' };
}

/**
 * Stages during which the model is ACTING (touching tools / running an
 * effort/repair pass) rather than reasoning — so the ONE live indicator reads
 * "Working" instead of "Thinking" even when no tool call is momentarily in flight.
 */
const ACTING_STAGES: ReadonlySet<HarnessStage> = new Set<HarnessStage>([
  'working',
  'repairing',
  'reviewing',
  'revising',
  'verifying',
]);

/**
 * The refinement word folded in beside the primary label for the stages that add
 * information the "Thinking/Working" word doesn't already carry. `classifying` is
 * gated to Auto mode (see {@link threadStatusView}); `working`/`done`/`idle` add
 * nothing over the primary word, so they carry no detail.
 */
const STAGE_DETAIL: Partial<Record<HarnessStage, string>> = {
  classifying: 'Classifying',
  repairing: 'Repairing',
  reviewing: 'Reviewing',
  revising: 'Revising',
  verifying: 'Verifying',
};

/** Inputs to {@link threadStatusView} (mirrors the live pi/settings/switching state). */
export interface ThreadStatusInputs {
  /** Whether a turn is actively streaming (pi-slice `agent.isStreaming`). */
  readonly isStreaming: boolean;
  /** The retry banner state, or null. */
  readonly retry: { attempt: number; maxAttempts: number } | null;
  /** Whether any tool call is currently executing (`runningToolCalls.length > 0`). */
  readonly toolRunning: boolean;
  /** The harness lifecycle stage, or null when the harness hasn't published. */
  readonly stage: HarnessStage | null | undefined;
  /** Whether the model selection is Auto (gates the "Classifying" detail — #5). */
  readonly isAuto: boolean;
  /**
   * The friendly tier label of an in-flight model switch (pre-stream llama
   * restart), or null. Surfaced ONLY when not yet streaming, so the single
   * indicator also covers the seconds-long model swap the footer no longer shows.
   */
  readonly switchingToTier: string | null;
}

/** The single consolidated thread indicator's rendered view, or null when idle. */
export interface ThreadStatusView {
  /** The primary status word ("Thinking" / "Working" / "Retrying (n/m)…" / "Switching…"). */
  readonly label: string;
  /** A subtle, static folded stage word, or undefined. */
  readonly detail?: string;
  /** Whether to render the elapsed "· Ns" counter (off during a pre-stream switch). */
  readonly showElapsed: boolean;
}

/**
 * The ONE live status indicator (jedd blind-test #1). Reduces the whole
 * status surface — the duplicate thinking/working labels, the footer stage
 * cluster, the switching pill — to a single thread-rendered view that reads
 * "Thinking" while the model reasons and "Working" while it acts (a running tool
 * OR an acting harness stage), with the harness lifecycle stage FOLDED IN subtly
 * as a muted detail word. Classification is only surfaced in Auto mode (#5). A
 * pre-stream model switch borrows the same indicator so the swap isn't silent.
 * Returns null when there is nothing to show. Pure + unit-tested.
 */
export function threadStatusView(inp: ThreadStatusInputs): ThreadStatusView | null {
  // Pre-stream model swap (Auto routing / explicit tier pick): the ONE indicator
  // covers it so the footer/bar can stay clean. Only while NOT yet streaming.
  if (!inp.isStreaming) {
    if (inp.switchingToTier !== null) {
      return { label: `Switching to ${inp.switchingToTier}…`, showElapsed: false };
    }
    return null;
  }

  if (inp.retry !== null) {
    return {
      label: `Retrying (${inp.retry.attempt}/${inp.retry.maxAttempts})…`,
      showElapsed: true,
    };
  }

  const stage = inp.stage ?? null;
  const acting = inp.toolRunning || (stage !== null && ACTING_STAGES.has(stage));
  const label = acting ? 'Working' : 'Thinking';

  // Fold the stage in subtly. "Classifying" only in Auto — a pinned tier never
  // classifies for routing, so surfacing it there would be wrong (#5).
  let detail = stage !== null ? STAGE_DETAIL[stage] : undefined;
  if (stage === 'classifying' && !inp.isAuto) detail = undefined;

  return { label, detail, showElapsed: true };
}
