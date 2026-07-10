import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@mariozechner/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import type { PlanItem } from '../state.js';
import { normalizePlan, PLAN_TOOL_NAME, planSummary, registerPlanTool } from './plan-tool.js';

function captureTool() {
  let tool: ToolDefinition | undefined;
  const pi = {
    registerTool: (def: ToolDefinition) => {
      tool = def;
    },
  } as unknown as ExtensionAPI;
  return { pi, getTool: () => tool };
}

const ctx = { hasUI: true } as unknown as ExtensionContext;

describe('normalizePlan', () => {
  it('coerces statuses, mints ids, and drops empty rows', () => {
    const plan = normalizePlan([
      { text: 'first', status: 'done' },
      { text: '  ', status: 'in_progress' }, // dropped (no text)
      { text: 'second' }, // default pending
      { text: 'third', status: 'bogus' as unknown }, // invalid → pending
      { text: 'roadmap step', roadmap: true, id: 'r1', group: 'later' },
    ]);
    expect(plan).toEqual<PlanItem[]>([
      { id: 'step-1', text: 'first', status: 'done' },
      { id: 'step-2', text: 'second', status: 'pending' },
      { id: 'step-3', text: 'third', status: 'pending' },
      { id: 'r1', text: 'roadmap step', status: 'pending', group: 'later', roadmap: true },
    ]);
  });
});

describe('planSummary', () => {
  it('reports progress counts', () => {
    const s = planSummary([
      { id: 'a', text: 'a', status: 'done' },
      { id: 'b', text: 'b', status: 'in_progress' },
      { id: 'c', text: 'c', status: 'pending' },
    ]);
    expect(s).toContain('1/3 done');
    expect(s).toContain('1 in progress');
    expect(s).toContain('[x] a');
    expect(s).toContain('[~] b');
    expect(s).toContain('[ ] c');
  });

  it('reports a cleared plan', () => {
    expect(planSummary([])).toBe('Plan cleared.');
  });
});

describe('registerPlanTool', () => {
  it('registers update_plan and forwards a normalized plan to onUpdate', async () => {
    const onUpdate = vi.fn();
    const { pi, getTool } = captureTool();
    registerPlanTool(pi, { onUpdate });
    const tool = getTool();
    expect(tool?.name).toBe(PLAN_TOOL_NAME);

    const result = await tool?.execute?.(
      'call-1',
      {
        title: 'My plan',
        plan: [{ text: 'step one', status: 'in_progress' }, { text: 'step two' }],
      },
      undefined,
      undefined,
      ctx,
    );

    expect(onUpdate).toHaveBeenCalledOnce();
    const [plan, title] = onUpdate.mock.calls[0] as [PlanItem[], string | undefined];
    expect(title).toBe('My plan');
    expect(plan.map((p) => p.status)).toEqual(['in_progress', 'pending']);
    // The result the model reads back summarizes progress.
    const text = (result?.content?.[0] as { text?: string })?.text ?? '';
    expect(text).toContain('0/2 done');
  });

  it('clears the plan when passed an empty list', async () => {
    const onUpdate = vi.fn();
    const { pi, getTool } = captureTool();
    registerPlanTool(pi, { onUpdate });
    await getTool()?.execute?.('c', { plan: [] }, undefined, undefined, ctx);
    expect(onUpdate).toHaveBeenCalledWith([], undefined);
  });
});
