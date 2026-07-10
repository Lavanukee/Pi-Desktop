import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import type { ChildAgentResult, RunChildAgentOptions } from './child-agent.js';
import { SubagentScheduler } from './scheduler.js';
import { deriveSubagentName, registerSubagentTool } from './subagent-tool.js';

// biome-ignore lint/suspicious/noExplicitAny: minimal structural tool capture for tests
type CapturedTool = any;

function harness(
  runChild: (opts: RunChildAgentOptions) => Promise<ChildAgentResult>,
  budgetOver: Partial<{ maxConcurrency: number; ramBudgetGB: number; perAgentGB: number }> = {},
): CapturedTool {
  const tools: CapturedTool[] = [];
  const pi = {
    registerTool: (t: CapturedTool) => tools.push(t),
  } as unknown as ExtensionAPI;
  const scheduler = new SubagentScheduler({
    budget: {
      maxConcurrency: 2,
      ramBudgetGB: 8,
      perAgentGB: 1.5,
      reason: 'test',
      ...budgetOver,
    },
  });
  registerSubagentTool(pi, { scheduler, runChild });
  return tools[0];
}

function text(res: { content: Array<{ type: string; text?: string }> }): string {
  return res.content.map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('\n');
}

const CTX = {} as never;

describe('deriveSubagentName', () => {
  it('takes the first few words', () => {
    expect(deriveSubagentName('research the pricing page for competitors and summarize')).toBe(
      'research the pricing page for competitors',
    );
  });
});

describe('spawn_subagent tool', () => {
  it('returns ONLY the child summary (never the transcript) and reports steps', async () => {
    const runChild = vi.fn(
      async (_opts: RunChildAgentOptions): Promise<ChildAgentResult> => ({
        ok: true,
        summary: 'Found 3 broken links on the pricing page.',
        steps: 4,
        timedOut: false,
      }),
    );
    const tool = harness(runChild);
    const res = await tool.execute(
      'call-1',
      { goal: 'audit the pricing page' },
      undefined,
      undefined,
      CTX,
    );

    expect(res.isError).toBeFalsy();
    const out = text(res);
    expect(out).toContain('Found 3 broken links on the pricing page.');
    expect(out).toContain('4 step');
    // The goal was passed through to the child runner.
    expect(runChild.mock.calls[0]?.[0]?.goal).toBe('audit the pricing page');
    expect(res.details).toMatchObject({ ok: true, steps: 4 });
  });

  it('rejects an empty goal without spawning', async () => {
    const runChild = vi.fn(async (): Promise<ChildAgentResult> => {
      throw new Error('should not run');
    });
    const tool = harness(runChild);
    const res = await tool.execute('c', { goal: '   ' }, undefined, undefined, CTX);
    expect(res.isError).toBe(true);
    expect(runChild).not.toHaveBeenCalled();
  });

  it('declines an over-budget spawn with a clear reason and never runs the child', async () => {
    const runChild = vi.fn(async (): Promise<ChildAgentResult> => {
      throw new Error('should not run');
    });
    const tool = harness(runChild, { ramBudgetGB: 2 });
    const res = await tool.execute(
      'c',
      { goal: 'big job', est_ram_gb: 32 },
      undefined,
      undefined,
      CTX,
    );
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/not started/i);
    expect(res.details).toMatchObject({ rejected: true });
    expect(runChild).not.toHaveBeenCalled();
  });

  it('does not let est_ram_gb=0 bypass the memory budget (SB-2)', async () => {
    const runChild = vi.fn(async (): Promise<ChildAgentResult> => {
      throw new Error('should not run');
    });
    // Budget too small for even the per-agent default (1.5 > 1): a real estimate
    // is rejected. A poisoned est_ram_gb=0 must NOT be forwarded as "free" and
    // slip past — it is dropped, so the default (1.5) applies and it's rejected.
    const tool = harness(runChild, { ramBudgetGB: 1, perAgentGB: 1.5 });
    const res = await tool.execute('c', { goal: 'job', est_ram_gb: 0 }, undefined, undefined, CTX);
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/not started/i);
    expect(runChild).not.toHaveBeenCalled();
  });

  it('surfaces a child failure/timeout as an error result (summary-only, no hang)', async () => {
    const runChild = vi.fn(
      async (): Promise<ChildAgentResult> => ({
        ok: false,
        summary: '',
        steps: 1,
        timedOut: true,
        error: 'subagent timed out',
      }),
    );
    const tool = harness(runChild);
    const res = await tool.execute('c', { goal: 'slow job' }, undefined, undefined, CTX);
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/timed out/i);
    expect(res.details).toMatchObject({ ok: false, timedOut: true });
  });
});
