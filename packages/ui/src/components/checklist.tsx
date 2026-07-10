import { clsx } from 'clsx';
import type { HTMLAttributes, ReactNode } from 'react';
import { forwardRef, useState } from 'react';
import { IconCheck, IconChevronDown } from './icons.tsx';
import { Spinner } from './spinner.tsx';

/*
 * Animated task-progress checklist (jedd round-1 feedback #3, Aside "Task
 * progress" panel). Steps carry a state: done (green check that pops in),
 * in-progress (spinning ring + shimmering label), pending (dim hollow ring),
 * roadmap (dimmer dashed ring). An optional collapsible "Subagents / Completed
 * N" subsection sits below. Non-intrusive and reduced-motion safe.
 */

export type TaskState = 'done' | 'in-progress' | 'pending' | 'roadmap';

export interface TaskChecklistItem {
  label: ReactNode;
  state: TaskState;
}

export interface TaskChecklistSubagents {
  /** Section heading; defaults to "Subagents". */
  title?: ReactNode;
  items: TaskChecklistItem[];
  defaultOpen?: boolean;
}

export interface TaskChecklistProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  items: TaskChecklistItem[];
  title?: ReactNode;
  /** Optional collapsible subsection of nested/subagent steps. */
  subagents?: TaskChecklistSubagents;
}

function TaskMarker({ state }: { state: TaskState }) {
  if (state === 'in-progress') {
    return (
      <span className="pd-task-marker pd-task-marker--running">
        <Spinner size={14} />
      </span>
    );
  }
  return (
    <span className={clsx('pd-task-marker', `pd-task-marker--${state}`)} aria-hidden="true">
      {state === 'done' ? <IconCheck size={11} /> : null}
    </span>
  );
}

const STATE_A11Y: Record<TaskState, string> = {
  done: 'done',
  'in-progress': 'in progress',
  pending: 'pending',
  roadmap: 'planned',
};

function TaskItem({ item }: { item: TaskChecklistItem }) {
  return (
    <li className={clsx('pd-task-item', `pd-task-item--${item.state}`)}>
      <TaskMarker state={item.state} />
      <span className="pd-task-label">{item.label}</span>
      <span className="pd-visually-hidden"> — {STATE_A11Y[item.state]}</span>
    </li>
  );
}

function TaskList({ items }: { items: TaskChecklistItem[] }) {
  return (
    <ul className="pd-task-list">
      {items.map((item, index) => (
        // Steps are an ordered, positionally-stable list; index is the key.
        // biome-ignore lint/suspicious/noArrayIndexKey: positional step list
        <TaskItem key={index} item={item} />
      ))}
    </ul>
  );
}

function TaskSubagents({
  title = 'Subagents',
  items,
  defaultOpen = false,
}: TaskChecklistSubagents) {
  const [open, setOpen] = useState(defaultOpen);
  const done = items.filter((item) => item.state === 'done').length;
  return (
    <div className="pd-task-subagents">
      <button
        type="button"
        className="pd-task-subagents-toggle pd-focusable"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span className="pd-task-subagents-chevron" data-open={open || undefined}>
          <IconChevronDown size={12} />
        </span>
        <span>{title}</span>
        <span className="pd-task-subagents-count">
          Completed {done}/{items.length}
        </span>
      </button>
      {open ? <TaskList items={items} /> : null}
    </div>
  );
}

export const TaskChecklist = forwardRef<HTMLDivElement, TaskChecklistProps>(function TaskChecklist(
  { items, title, subagents, className, ...rest },
  ref,
) {
  return (
    <div ref={ref} className={clsx('pd-task-panel', className)} {...rest}>
      {title !== undefined ? <div className="pd-task-title">{title}</div> : null}
      <TaskList items={items} />
      {subagents !== undefined ? <TaskSubagents {...subagents} /> : null}
    </div>
  );
});
