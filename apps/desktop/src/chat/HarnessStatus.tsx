/**
 * Harness surfacing:
 *
 *  - {@link ThreadStatusIndicator} — the ONE live status indicator (jedd
 *    blind-test #1). Rendered in the thread only, it reads "Thinking" while the
 *    model reasons and "Working" while it acts, with the harness lifecycle stage
 *    (classifying/reviewing/verifying/…) folded in subtly as a muted detail word.
 *    It replaces the old trio — the duplicate thread working-label, the composer
 *    footer HarnessStatusCluster, and the "switching…" pill — with a single
 *    element, so there is exactly one place that shows run status.
 *  - {@link HarnessChecklistPanel} — the live task checklist the model maintains
 *    via the `update_plan` tool, pinned above the thread so the user watches items
 *    flip pending → in_progress → done with the TaskChecklist animation.
 */
import {
  TaskChecklist,
  type TaskChecklistItem,
  type TaskState,
  WorkingIndicator,
} from '@pi-desktop/ui';
import { useEffect, useState } from 'react';
// Harness SOURCE import (not the barrel) — keeps the renderer bundle clean; see
// auto-router.ts. tier.ts is pure + browser-safe.
import { TIER_LABEL } from '../../../../packages/harness/src/classify/tier.ts';
import { useModelSwitching } from '../state/model-selection-store';
import { usePiStore } from '../state/pi-slice';
import { useModelSelection } from '../state/settings-store';
import {
  type PlanItem,
  PREFILL_STATUS_KEY,
  parsePrefillPercent,
  threadStatusView,
  useHarnessStatus,
} from './harness-status';

/** A plan longer than this starts collapsed so it doesn't crowd the thread. */
const LONG_PLAN_THRESHOLD = 6;

/** Map a plan item's status (+ roadmap flag) to a TaskChecklist state. */
function toTaskState(item: PlanItem): TaskState {
  if (item.roadmap === true && item.status !== 'done') return 'roadmap';
  if (item.status === 'in_progress') return 'in-progress';
  if (item.status === 'done') return 'done';
  return 'pending';
}

/** Live elapsed seconds since `startedAt` (ticks each second; 0 when idle). */
function useElapsed(startedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  return startedAt === null ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000));
}

/**
 * The ONE live status indicator (jedd blind-test #1). Renders a single
 * {@link WorkingIndicator} in the thread that reads "Thinking" while the model
 * reasons and "Working" while it acts, with the harness lifecycle stage folded in
 * subtly (classify only in Auto — #5). Also borrows the same indicator for the
 * pre-stream model switch so the swap isn't silent. Renders nothing when idle.
 */
export function ThreadStatusIndicator() {
  const isStreaming = usePiStore((s) => s.agent.isStreaming);
  const retry = usePiStore((s) => s.agent.retry);
  const agentStartedAt = usePiStore((s) => s.agent.agentStartedAt);
  const toolRunning = usePiStore((s) => s.runningToolCalls.length > 0);
  // Prefill progress rides the generic extensionStatus channel (published by the
  // inference lane from provider-llamacpp's `prompt_progress` frames), so no
  // engine/store plumbing is needed — the indicator just reads and parses it.
  const prefillRaw = usePiStore((s) => s.extensionStatus[PREFILL_STATUS_KEY]);
  const status = useHarnessStatus();
  const selection = useModelSelection();
  const switching = useModelSwitching();
  const elapsed = useElapsed(isStreaming ? agentStartedAt : null);

  const view = threadStatusView({
    isStreaming,
    retry,
    toolRunning,
    stage: status?.stage ?? null,
    isAuto: selection.mode === 'auto',
    switchingToTier: switching !== null ? TIER_LABEL[switching.toTier] : null,
    promptProgress: parsePrefillPercent(prefillRaw),
  });
  if (view === null) return null;

  return (
    <WorkingIndicator
      className="py-2"
      data-testid="thread-status"
      label={view.label}
      detail={view.detail}
      elapsedSeconds={view.showElapsed ? elapsed : undefined}
    />
  );
}

/**
 * The live task checklist, pinned above the thread. Renders nothing until the
 * model publishes a plan via `update_plan`.
 */
export function HarnessChecklistPanel() {
  const status = useHarnessStatus();
  const plan = status?.plan;
  if (plan === undefined || plan === null || plan.length === 0) return null;

  const items: TaskChecklistItem[] = plan.map((p) => ({ label: p.text, state: toTaskState(p) }));

  return (
    <div className="mx-auto w-full max-w-[700px] px-4 pt-2" data-testid="harness-checklist">
      <TaskChecklist
        className="border border-border-subtle bg-surface-raised"
        title={status?.planTitle ?? 'Plan'}
        items={items}
        // Round-14 #6: the pinned panel collapses to just its title header so a
        // long plan can tuck up out of the way. Long plans start collapsed.
        collapsible
        defaultCollapsed={items.length > LONG_PLAN_THRESHOLD}
      />
    </div>
  );
}
