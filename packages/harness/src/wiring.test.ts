/**
 * Round-9 wiring tests: the repair ladder + effort knobs actually drive runtime
 * behavior.
 *
 * These drive the harness's live repair deps through the provider's REAL
 * `repairToolCallArguments` (the same seam production uses), and exercise the
 * effort-gated reviewer pass — so they prove the bridge, not just the library.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolDefinition,
  ToolInfo,
} from '@mariozechner/pi-coding-agent';
import { repairToolCallArguments } from '@pi-desktop/provider-llamacpp';
import { describe, expect, it, vi } from 'vitest';
import {
  HARNESS_CONFIG_ENTRY,
  HARNESS_REVIEW_ENTRY,
  type StoredEntryLike,
  wireHarness,
} from './index.js';
import type { CallModel } from './model-call/call-model.js';
import type { ToolSchemaLike } from './repair/rungs.js';

const SCHEMA: ToolSchemaLike = {
  type: 'object',
  properties: { path: { type: 'string' } },
  required: ['path'],
};

// biome-ignore lint/suspicious/noExplicitAny: event handler shape varies per event.
type AnyHandler = (event: any, ctx: any) => any;

function makeRig(opts: { effort?: string; callModel?: CallModel } = {}) {
  const handlers = new Map<string, AnyHandler[]>();
  const entries: StoredEntryLike[] = [];
  if (opts.effort !== undefined) {
    entries.push({
      type: 'custom',
      customType: HARNESS_CONFIG_ENTRY,
      data: { effort: opts.effort },
    });
  }
  let activeTools: string[] = [];
  const sentUserMessages: string[] = [];

  const pi = {
    on: (event: string, h: AnyHandler) => {
      const list = handlers.get(event) ?? [];
      list.push(h);
      handlers.set(event, list);
    },
    registerTool: (_def: ToolDefinition) => {},
    registerCommand: () => {},
    getAllTools: (): ToolInfo[] =>
      ['read', 'bash', 'tool_search'].map((name) => ({
        name,
        description: `${name} tool`,
        // biome-ignore lint/suspicious/noExplicitAny: stub schema.
        parameters: {} as any,
        sourceInfo: {
          path: `<t:${name}>`,
          source: 'builtin',
          scope: 'temporary',
          origin: 'top-level',
        },
      })),
    getActiveTools: () => activeTools,
    setActiveTools: (names: string[]) => {
      activeTools = names;
    },
    appendEntry: (customType: string, data: unknown) => {
      entries.push({ type: 'custom', customType, data });
    },
    sendUserMessage: (content: string) => {
      sentUserMessages.push(typeof content === 'string' ? content : JSON.stringify(content));
    },
  } as unknown as ExtensionAPI;

  const abort = vi.fn();
  const notify = vi.fn();
  const confirm = vi.fn(async () => true);
  const ctx = {
    hasUI: true,
    ui: { notify, confirm, setStatus: vi.fn() },
    getContextUsage: () => ({ tokens: 1, contextWindow: 100, percent: 1 }),
    sessionManager: { getEntries: () => entries },
    abort,
  } as unknown as ExtensionContext & ExtensionCommandContext;

  const handle = wireHarness(pi, { callModel: opts.callModel });
  const fire = (event: string, e: unknown) =>
    Promise.all((handlers.get(event) ?? []).map((h) => h(e, ctx)));
  return { pi, entries, ctx, handle, fire, sentUserMessages, abort, notify };
}

async function startSession(rig: ReturnType<typeof makeRig>) {
  await rig.fire('session_start', { type: 'session_start', reason: 'startup' });
}

describe('repair ladder — live wiring through the provider', () => {
  it('rung 2 fixer runs (via callModel) on a schema-valid-but-wrong tool call', async () => {
    const callModel: CallModel = vi.fn(async () => '{"path":"/fixed-by-model"}');
    const rig = makeRig({ effort: 'medium', callModel });
    await startSession(rig);

    const deps = rig.handle.buildRepairDeps();
    const result = await repairToolCallArguments('{"wrong":1}', {
      toolName: 'read',
      schema: SCHEMA,
      fixer: deps.fixer,
      extraRungs: deps.extraRungs,
    });

    // Parseable but schema-invalid → entered the ladder → rung 2 fixer fixed it.
    expect(callModel).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
    expect(result.rung).toBe(2);
    expect(result.value).toEqual({ path: '/fixed-by-model' });
  });

  it('rung 5 aborts at the effort abortThreshold and onRepair populates repairFailures', async () => {
    // effort low → abortThreshold 2. No callModel → no fixer → ladder falls to 3–5.
    const rig = makeRig({ effort: 'low' });
    await startSession(rig);
    const deps = rig.handle.buildRepairDeps();

    const run = () =>
      repairToolCallArguments('total garbage {{{', {
        toolName: 'bash',
        schema: SCHEMA,
        extraRungs: deps.extraRungs,
      }).then((r) => deps.onRepair?.({ toolName: 'bash', rung: r.rung, ok: r.ok }));

    await run(); // failure count → 1 (< 2): no abort
    expect(rig.abort).not.toHaveBeenCalled();
    await run(); // failure count → 2 (== threshold): abort fires
    expect(rig.abort).toHaveBeenCalledOnce();

    // onRepair appended ok:false entries → repairFailures is populated.
    const status = rig.handle.getStatus(rig.ctx);
    expect(status.repairFailures.bash).toBe(2);
  });

  it('higher effort raises the abort threshold (does not abort where low would)', async () => {
    const rig = makeRig({ effort: 'high' }); // abortThreshold 4
    await startSession(rig);
    const deps = rig.handle.buildRepairDeps();
    for (let i = 0; i < 2; i++) {
      await repairToolCallArguments('garbage {{{', {
        toolName: 'bash',
        schema: SCHEMA,
        extraRungs: deps.extraRungs,
      });
    }
    expect(rig.abort).not.toHaveBeenCalled(); // 2 < 4
  });
});

describe('effort-gated reviewer pass', () => {
  const badReview: CallModel = vi.fn(async () => '{"ok":false,"issues":["missing edge case"]}');

  it('effort=low does NOT review (no model call, no revision)', async () => {
    const callModel = vi.fn(badReview);
    const rig = makeRig({ effort: 'low', callModel });
    await startSession(rig);
    const triggered = await rig.handle.reviewTurn('some result', rig.ctx);
    expect(triggered).toBe(false);
    expect(callModel).not.toHaveBeenCalled();
    expect(rig.sentUserMessages).toHaveLength(0);
  });

  it('effort=high reviews, catches the bad result, and triggers a revision', async () => {
    const callModel = vi.fn(badReview);
    const rig = makeRig({ effort: 'high', callModel });
    await startSession(rig);
    const triggered = await rig.handle.reviewTurn('some result', rig.ctx);
    expect(triggered).toBe(true);
    // reviewPasses(2)>0 + adversarialChecks(true) → both passes ran.
    expect(callModel).toHaveBeenCalled();
    expect(rig.sentUserMessages).toHaveLength(1);
    expect(rig.sentUserMessages[0]).toContain('reviewer flagged');
    const review = rig.entries.find((e) => e.customType === HARNESS_REVIEW_ENTRY);
    expect(review?.data).toMatchObject({ flagged: true });
  });

  it('does not review the revision turn it triggered (no infinite loop)', async () => {
    const callModel = vi.fn(badReview);
    const rig = makeRig({ effort: 'high', callModel });
    await startSession(rig);
    await rig.handle.reviewTurn('first result', rig.ctx); // triggers revision + suppresses next
    callModel.mockClear();
    const again = await rig.handle.reviewTurn('revision result', rig.ctx);
    expect(again).toBe(false);
    expect(callModel).not.toHaveBeenCalled();
  });
});
