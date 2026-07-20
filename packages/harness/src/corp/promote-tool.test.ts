import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import type { EffortLevel } from '../effort/effort.js';
import {
  corpToolEnabled,
  PROMOTE_STATUS_KEY,
  registerCreateHierarchyTool,
} from './promote-tool.js';
import { CREATE_PRODUCTION_HIERARCHY, HIERARCHY_CREATED_ACK } from './promotion.js';

// biome-ignore lint/suspicious/noExplicitAny: minimal structural tool capture for tests
type CapturedTool = any;

/** Register the tool at a given effort and return the captured tool spec. */
function register(effort: EffortLevel): CapturedTool {
  const tools: CapturedTool[] = [];
  const pi = { registerTool: (t: CapturedTool) => tools.push(t) } as unknown as ExtensionAPI;
  registerCreateHierarchyTool(pi, { getEffort: () => effort, nextId: () => 'fixed-id' });
  return tools[0];
}

/** A fake per-turn ctx that captures setStatus publishes. */
function fakeCtx(): { ctx: never; statuses: Record<string, string> } {
  const statuses: Record<string, string> = {};
  const ctx = {
    hasUI: true,
    ui: {
      setStatus: (k: string, v: string) => {
        statuses[k] = v;
      },
    },
  } as never;
  return { ctx, statuses };
}

function text(res: { content: Array<{ type: string; text?: string }> }): string {
  return res.content.map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('\n');
}

describe('corpToolEnabled', () => {
  it('is true ONLY at high/max (jedd)', () => {
    expect(corpToolEnabled('low')).toBe(false);
    expect(corpToolEnabled('medium')).toBe(false);
    expect(corpToolEnabled('high')).toBe(true);
    expect(corpToolEnabled('max')).toBe(true);
  });
});

describe('create_production_hierarchy — normal-chat tool', () => {
  it('registers under the corp tool name', () => {
    expect(register('max').name).toBe(CREATE_PRODUCTION_HIERARCHY);
  });

  it('at high/max: publishes the promote signal + returns the TERMINAL ack', async () => {
    const tool = register('high');
    const { ctx, statuses } = fakeCtx();
    const res = await tool.execute(
      'c',
      { reason: 'a large multi-part build', divisions: [{ name: 'Frontend', purpose: 'the UI' }] },
      undefined,
      undefined,
      ctx,
    );
    expect(res.isError).not.toBe(true);
    expect(text(res)).toBe(HIERARCHY_CREATED_ACK);
    const signal = JSON.parse(statuses[PROMOTE_STATUS_KEY] ?? '{}');
    expect(signal).toMatchObject({ id: 'fixed-id', reason: 'a large multi-part build' });
    expect(signal.divisions).toHaveLength(1);
  });

  it('at low/medium: rejects and publishes NOTHING (not offered below high)', async () => {
    const tool = register('low');
    const { ctx, statuses } = fakeCtx();
    const res = await tool.execute(
      'c',
      { reason: 'x', divisions: [{ name: 'A', purpose: 'b' }] },
      undefined,
      undefined,
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(statuses[PROMOTE_STATUS_KEY]).toBeUndefined();
  });

  it('rejects unusable args (no valid division) without publishing', async () => {
    const tool = register('max');
    const { ctx, statuses } = fakeCtx();
    const res = await tool.execute(
      'c',
      { reason: 'x', divisions: [] },
      undefined,
      undefined,
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(statuses[PROMOTE_STATUS_KEY]).toBeUndefined();
  });
});
