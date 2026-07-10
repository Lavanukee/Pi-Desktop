/**
 * `update_plan` — a todo/plan tool the model calls to publish and update a task
 * checklist. pi has no built-in plan tool, so the harness adds one: the model
 * sets the full list of steps (each `pending` / `in_progress` / `done`), and the
 * harness surfaces it to the desktop app (via {@link HarnessStatus.plan}) which
 * renders a live TaskChecklist that flips item states with its animation.
 *
 * Set/replace semantics (like Claude's TodoWrite): each call passes the WHOLE
 * list, and the tool replaces the previous plan — so the model drives the whole
 * checklist forward by re-emitting it with updated states. The normalization is a
 * pure function ({@link normalizePlan}) so it is unit-tested without a live pi.
 */

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { type Static, Type } from '@sinclair/typebox';
import { isPlanItemStatus, type PlanItem, type PlanItemStatus } from '../state.js';

export const PLAN_TOOL_NAME = 'update_plan';

const PlanItemParam = Type.Object({
  text: Type.String({ description: 'Short imperative step label, e.g. "Add the RPC type".' }),
  status: Type.Optional(
    Type.Union([Type.Literal('pending'), Type.Literal('in_progress'), Type.Literal('done')], {
      description: 'Step state. Defaults to "pending".',
    }),
  ),
  id: Type.Optional(
    Type.String({ description: 'Stable id for this step (kept across updates). Optional.' }),
  ),
  group: Type.Optional(Type.String({ description: 'Optional section/group heading.' })),
  roadmap: Type.Optional(
    Type.Boolean({ description: 'Mark as a future/roadmap step (rendered dimmer).' }),
  ),
});

const PlanToolParams = Type.Object({
  title: Type.Optional(Type.String({ description: 'Optional heading for the checklist panel.' })),
  plan: Type.Array(PlanItemParam, {
    description:
      'The FULL ordered list of steps (replaces the previous plan). Re-send it with updated ' +
      'statuses to advance the checklist. Send an empty array to clear the plan.',
  }),
});
type PlanToolInput = Static<typeof PlanToolParams>;

/** Loosely-typed inbound item (wire boundary; the model may omit fields). */
interface RawPlanItem {
  readonly text?: unknown;
  readonly status?: unknown;
  readonly id?: unknown;
  readonly group?: unknown;
  readonly roadmap?: unknown;
}

/**
 * Validate + normalize a raw plan array into {@link PlanItem}s: coerce statuses,
 * mint stable ids for items that omit one, drop entries without text. Pure.
 */
export function normalizePlan(raw: readonly RawPlanItem[]): PlanItem[] {
  const out: PlanItem[] = [];
  let i = 0;
  for (const entry of raw) {
    const text = typeof entry.text === 'string' ? entry.text.trim() : '';
    if (text.length === 0) continue;
    const status: PlanItemStatus = isPlanItemStatus(entry.status) ? entry.status : 'pending';
    const id = typeof entry.id === 'string' && entry.id.length > 0 ? entry.id : `step-${i + 1}`;
    const item: PlanItem = {
      id,
      text,
      status,
      ...(typeof entry.group === 'string' && entry.group.length > 0 ? { group: entry.group } : {}),
      ...(entry.roadmap === true ? { roadmap: true } : {}),
    };
    out.push(item);
    i += 1;
  }
  return out;
}

/** Concise progress summary for the tool result the model reads back. */
export function planSummary(plan: readonly PlanItem[]): string {
  if (plan.length === 0) return 'Plan cleared.';
  const done = plan.filter((p) => p.status === 'done').length;
  const inProgress = plan.filter((p) => p.status === 'in_progress').length;
  const lines = plan.map((p) => {
    const mark = p.status === 'done' ? '[x]' : p.status === 'in_progress' ? '[~]' : '[ ]';
    return `${mark} ${p.text}`;
  });
  return `Plan updated (${done}/${plan.length} done${inProgress > 0 ? `, ${inProgress} in progress` : ''}):\n${lines.join('\n')}`;
}

export interface PlanToolOptions {
  /** Called with the normalized plan (+ optional title) after each update. */
  readonly onUpdate: (plan: PlanItem[], title: string | undefined) => void;
}

/**
 * Register the `update_plan` tool. The model calls it with the full step list;
 * the tool normalizes it and hands it to {@link PlanToolOptions.onUpdate} (which
 * the harness uses to publish {@link HarnessStatus.plan} to the renderer).
 */
export function registerPlanTool(pi: ExtensionAPI, opts: PlanToolOptions): void {
  pi.registerTool({
    name: PLAN_TOOL_NAME,
    label: 'Update Plan',
    description:
      'Publish or update a task checklist the user sees live. Pass the FULL ordered list of ' +
      'steps each call; mark exactly one step "in_progress" while you work it and "done" when ' +
      'finished. Use it for any multi-step task so the user can watch progress.',
    promptSnippet:
      'update_plan: maintain a visible task checklist (pending/in_progress/done) for multi-step work.',
    promptGuidelines: [
      'For any task with more than one step, call update_plan early with the whole plan.',
      'Keep exactly one step in_progress at a time; re-send the list to advance it.',
    ],
    parameters: PlanToolParams,
    async execute(_toolCallId, params: PlanToolInput, _signal, _onUpdate, _ctx) {
      const plan = normalizePlan(params.plan ?? []);
      const title =
        typeof params.title === 'string' && params.title.trim().length > 0
          ? params.title.trim()
          : undefined;
      opts.onUpdate(plan, title);
      return {
        content: [{ type: 'text', text: planSummary(plan) }],
        details: { plan, title },
      };
    },
  });
}
