/**
 * The stylized task-briefing bubble (spec §11 click-through): when a worker's
 * live stream is routed into the chat area, the leading "user message" slot is
 * filled by THIS — the worker's assignment, visibly a briefing (eyebrow rule,
 * distinct tint/border, structured deliverables), never a normal user input.
 * Token-driven and flavor-aware: everything rides the theme variables.
 */

import type { WorkerBriefing } from './worker-streams.ts';

export interface TaskBriefingBubbleProps {
  briefing: WorkerBriefing;
}

export function TaskBriefingBubble({ briefing }: TaskBriefingBubbleProps) {
  return (
    <div className="pd-taskbrief" data-testid="task-briefing">
      <div className="pd-taskbrief-eyebrow">
        <span className="pd-taskbrief-mark" aria-hidden="true" />
        <span>Task briefing</span>
        <span className="pd-taskbrief-worker">
          {briefing.workerName} · {briefing.roleLine}
        </span>
      </div>
      <div className="pd-taskbrief-title">{briefing.title}</div>
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
  );
}
