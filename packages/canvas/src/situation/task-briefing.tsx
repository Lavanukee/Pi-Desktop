/**
 * The stylized task-briefing bubble (spec §11 click-through): when a worker's
 * live stream is routed into the chat area, the leading "user message" slot is
 * filled by THIS — the worker's assignment, visibly a briefing (eyebrow rule,
 * distinct tint/border, structured deliverables), never a normal user input.
 * Token-driven and flavor-aware: everything rides the theme variables.
 *
 * Collapsible (the long-watch pass): the eyebrow row doubles as a toggle so
 * the briefing folds down to its headline while the LIVE feed below it keeps
 * the room. Non-collapsible unless the host opts in.
 */

import { IconChevronDown } from '@pi-desktop/ui';
import { useState } from 'react';
import type { WorkerBriefing } from './worker-streams.ts';

export interface TaskBriefingBubbleProps {
  briefing: WorkerBriefing;
  /** Let the eyebrow row collapse/expand the briefing detail. */
  collapsible?: boolean;
  /** Start collapsed (only meaningful with `collapsible`). */
  defaultCollapsed?: boolean;
}

export function TaskBriefingBubble({
  briefing,
  collapsible = false,
  defaultCollapsed = false,
}: TaskBriefingBubbleProps) {
  const [collapsed, setCollapsed] = useState(collapsible && defaultCollapsed);

  const eyebrowContent = (
    <>
      <span className="pd-taskbrief-mark" aria-hidden="true" />
      <span>Task briefing</span>
      <span className="pd-taskbrief-worker">
        {briefing.workerName} · {briefing.roleLine}
      </span>
      {collapsible ? (
        <span className="pd-taskbrief-chevron" data-collapsed={collapsed || undefined} aria-hidden>
          <IconChevronDown size={12} />
        </span>
      ) : null}
    </>
  );

  return (
    <div
      className="pd-taskbrief"
      data-testid="task-briefing"
      data-collapsed={collapsed || undefined}
    >
      {collapsible ? (
        <button
          type="button"
          className="pd-taskbrief-toggle pd-focusable"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((v) => !v)}
        >
          {eyebrowContent}
        </button>
      ) : (
        <div className="pd-taskbrief-eyebrow">{eyebrowContent}</div>
      )}
      <div className="pd-taskbrief-title">{briefing.title}</div>
      <div className="pd-taskbrief-detail" data-collapsed={collapsed || undefined}>
        <div className="pd-taskbrief-detail-inner">
          {briefing.area !== undefined ? (
            <div className="pd-taskbrief-area">{briefing.area}</div>
          ) : null}
          <p className="pd-taskbrief-goal">{briefing.goal}</p>
          <ul className="pd-taskbrief-deliverables">
            {briefing.deliverables.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
