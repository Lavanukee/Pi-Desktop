/**
 * The leading card of a worker's live stream (spec §11 click-through): what this
 * worker was ASKED to do, rendered as a plain user-message-style card — the ask
 * reads like a normal chat message (title + goal), with the deliverables
 * EMBEDDED as a checklist styled exactly like the Plan panel's rows (the same
 * `pd-sitroom-task` markers), never a labelled "briefing" box and never org
 * jargon. A tiny byline above the bubble says who the ask is for.
 *
 * Collapsible (the long-watch pass): the title row doubles as a toggle so the
 * card folds down to its headline while the LIVE feed below keeps the room.
 */

import { IconChevronDown } from '@pi-desktop/ui';
import { useState } from 'react';
import type { WorkerBriefing } from './worker-streams.ts';

export interface TaskBriefingBubbleProps {
  briefing: WorkerBriefing;
  /** Let the title row collapse/expand the card's detail. */
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

  const titleContent = (
    <>
      <span className="pd-taskbrief-title">{briefing.title}</span>
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
      <div className="pd-taskbrief-who">
        {briefing.workerName} · {briefing.roleLine}
      </div>
      <div className="pd-taskbrief-bubble">
        {collapsible ? (
          <button
            type="button"
            className="pd-taskbrief-toggle pd-focusable"
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((v) => !v)}
          >
            {titleContent}
          </button>
        ) : (
          <div className="pd-taskbrief-head">{titleContent}</div>
        )}
        <div className="pd-taskbrief-detail" data-collapsed={collapsed || undefined}>
          <div className="pd-taskbrief-detail-inner">
            <p className="pd-taskbrief-goal">{briefing.goal}</p>
            {briefing.area !== undefined ? (
              <div className="pd-taskbrief-area">{briefing.area}</div>
            ) : null}
            {/* The deliverables, as the SAME checklist rows the Plan uses. */}
            <ul className="pd-sitroom-tasklist pd-taskbrief-list">
              {briefing.deliverables.map((d) => (
                <li className="pd-sitroom-task" data-state="queued" key={d}>
                  <span className="pd-sitroom-task-marker" data-state="queued" aria-hidden="true" />
                  <span className="pd-sitroom-task-label">{d}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
