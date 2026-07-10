/**
 * Always-visible harness surfacing (round-9 W3):
 *
 *  - {@link HarnessStatusCluster} — the active task-class, the live running timer,
 *    and a subtle repair-activity indicator. Rendered in the composer footer next
 *    to the model chip / TPS / context ring so all four status elements live in
 *    ONE always-visible cluster (the timer was previously siloed in ChatThread,
 *    visible only mid-stream).
 *  - {@link HarnessChecklistPanel} — the live task checklist the model maintains
 *    via the `update_plan` tool, pinned above the thread so the user watches items
 *    flip pending → in_progress → done with the TaskChecklist animation.
 */
import {
  IconClock,
  IconRefresh,
  TaskChecklist,
  type TaskChecklistItem,
  type TaskState,
  Tooltip,
} from '@pi-desktop/ui';
import {
  type PlanItem,
  repairTotal,
  useHarnessStatus,
  useHarnessTaskTimer,
} from './harness-status';

/** Map a plan item's status (+ roadmap flag) to a TaskChecklist state. */
function toTaskState(item: PlanItem): TaskState {
  if (item.roadmap === true && item.status !== 'done') return 'roadmap';
  if (item.status === 'in_progress') return 'in-progress';
  if (item.status === 'done') return 'done';
  return 'pending';
}

/**
 * The consolidated harness status cluster for the composer footer: running timer
 * + repair-activity count. Renders nothing until the harness publishes its
 * status. (Round-12 W3: the active task-class / tier chip moved to the composer
 * bar, so it no longer duplicates here — the footer keeps only the timer and the
 * repair indicator alongside the model chip.)
 */
export function HarnessStatusCluster() {
  const status = useHarnessStatus();
  const timer = useHarnessTaskTimer();
  const repairs = repairTotal(status);

  if (status === null) return null;
  const hasAny = timer !== null || repairs > 0;
  if (!hasAny) return null;

  const repairTools = Object.entries(status.repairFailures ?? {})
    .filter(([, n]) => n > 0)
    .map(([name, n]) => `${name}: ${n}`);

  return (
    <span className="flex items-center gap-2" data-testid="harness-status">
      {timer !== null ? (
        <span
          className="flex items-center gap-1 text-footnote text-text-muted tabular-nums"
          data-testid="harness-timer"
        >
          <IconClock size={12} />
          {timer.replace(/^⏱\s*/, '')}
        </span>
      ) : null}

      {repairs > 0 ? (
        <Tooltip
          side="top"
          label={
            <span className="flex flex-col gap-0.5 text-footnote">
              <span className="font-medium text-text-primary">Auto-repair fired</span>
              {repairTools.map((t) => (
                <span key={t} className="text-text-muted">
                  {t}
                </span>
              ))}
            </span>
          }
        >
          <span
            className="flex items-center gap-1 text-footnote text-text-muted"
            data-testid="harness-repairs"
          >
            <IconRefresh size={12} />
            {repairs}
          </span>
        </Tooltip>
      ) : null}
    </span>
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
      />
    </div>
  );
}
