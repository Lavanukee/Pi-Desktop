/**
 * The plan as a live checklist — the DAG made visible (spec §11). Division
 * dropdowns hold their contracts in dependency order; checks appear as
 * contracts complete, driven DIRECTLY from contract state (no fake progress).
 * Rows that wait on another division carry a visible cross-division chip until
 * the dependency clears. Group bodies collapse with the app's signature
 * grid-rows 0fr↔1fr roll.
 */

import type { ChecklistItem } from '@pi-desktop/coordination';
import { IconCheck, IconChevronDown } from '@pi-desktop/ui';
import { useState } from 'react';
import { type ChecklistGroup, crossGroupWaits, groupChecklist } from './situation-model.ts';

export interface PlanPanelProps {
  items: readonly ChecklistItem[];
}

export function PlanPanel({ items }: PlanPanelProps) {
  const groups = groupChecklist(items);
  if (groups.length === 0) {
    return (
      <div className="pd-sitroom-plan" data-empty>
        <span className="pd-sitroom-plan-empty">The plan is being written…</span>
      </div>
    );
  }
  return (
    <div className="pd-sitroom-plan pd-scroll">
      {groups.map((group) => (
        <PlanGroup key={group.name} group={group} all={items} />
      ))}
    </div>
  );
}

function PlanGroup({ group, all }: { group: ChecklistGroup; all: readonly ChecklistItem[] }) {
  const [open, setOpen] = useState(true);
  const total = group.items.length;
  return (
    <section className="pd-sitroom-plangroup" data-complete={group.done === total || undefined}>
      <button
        type="button"
        className="pd-sitroom-plangroup-head pd-focusable"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="pd-sitroom-plangroup-chevron" data-open={open || undefined}>
          <IconChevronDown size={12} />
        </span>
        <span className="pd-sitroom-plangroup-name">{group.name}</span>
        <span className="pd-sitroom-plangroup-count">
          {group.done}/{total}
        </span>
        <span
          className="pd-sitroom-plangroup-track"
          role="progressbar"
          aria-valuenow={group.done}
          aria-valuemin={0}
          aria-valuemax={total}
        >
          <span
            className="pd-sitroom-plangroup-fill"
            style={{ width: total > 0 ? `${(group.done / total) * 100}%` : '0%' }}
          />
        </span>
      </button>
      <div className="pd-sitroom-plangroup-body" data-collapsed={!open || undefined}>
        <div className="pd-sitroom-plangroup-inner">
          <ul className="pd-sitroom-tasklist">
            {group.items.map((item) => (
              <PlanRow key={item.id} item={item} all={all} />
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

function PlanRow({ item, all }: { item: ChecklistItem; all: readonly ChecklistItem[] }) {
  const waits = crossGroupWaits(item, all);
  return (
    <li className="pd-sitroom-task" data-state={item.state}>
      <span className="pd-sitroom-task-marker" data-state={item.state} aria-hidden="true">
        {item.state === 'done' ? (
          <IconCheck size={10} />
        ) : item.state === 'in-progress' ? (
          // A thin animated ring (the premium working tell), not a solid dot.
          <span className="pd-sitroom-task-ring" />
        ) : null}
      </span>
      <span className="pd-sitroom-task-label">{item.label}</span>
      {item.state === 'in-review' ? (
        <span className="pd-sitroom-task-tag" data-tone="review">
          review
        </span>
      ) : null}
      {waits.map((division) => (
        <span
          className="pd-sitroom-task-tag"
          data-tone="waits"
          key={division}
          title={`Waits on ${division}`}
        >
          ↳ {division}
        </span>
      ))}
    </li>
  );
}
