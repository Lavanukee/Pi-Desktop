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
import type { HarnessStatus, PlanItem } from '@pi-desktop/harness';
import { useMemo } from 'react';
import { usePiStore } from '../state/pi-slice';

export type { HarnessStatus, PlanItem };

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

/** The short running-task timer string (`⏱ 3.2s`), or null when idle. */
export function useHarnessTaskTimer(): string | null {
  const raw = usePiStore((s) => s.extensionStatus['harness-task']);
  return raw !== undefined && raw.length > 0 ? raw : null;
}

/** Total repair failures across all tools this session. */
export function repairTotal(status: HarnessStatus | null): number {
  if (status === null) return 0;
  return Object.values(status.repairFailures ?? {}).reduce((a, b) => a + b, 0);
}

/** Human label for a task class (falls back to the raw id, dashes → spaces). */
export function classLabel(cls: string | null | undefined): string | null {
  if (cls === null || cls === undefined) return null;
  return cls.replace(/-/g, ' ');
}
