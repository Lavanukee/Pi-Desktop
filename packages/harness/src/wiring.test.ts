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
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HARNESS_CONFIG_ENTRY,
  HARNESS_REVIEW_ENTRY,
  type StoredEntryLike,
  SUBAGENT_DEPTH_ENV,
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
  return { pi, entries, ctx, handle, fire, sentUserMessages, abort, notify, confirm };
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

describe('reviewPasses knob is real (round-9): passes scale with effort', () => {
  // A reviewer that always approves → the loop never breaks early, so the number
  // of reviewOutput calls equals reviewPasses (+ one adversarialCheck when on).
  const okModel = () => vi.fn(async () => '{"ok":true,"issues":[]}');

  it('medium runs exactly 1 reviewer pass; high runs more; max more still', async () => {
    const m = okModel();
    const rigM = makeRig({ effort: 'medium', callModel: m });
    await startSession(rigM);
    await rigM.handle.reviewTurn('result', rigM.ctx);
    expect(m.mock.calls.length).toBe(1); // reviewPasses 1 + adversarial off

    const h = okModel();
    const rigH = makeRig({ effort: 'high', callModel: h });
    await startSession(rigH);
    await rigH.handle.reviewTurn('result', rigH.ctx);
    expect(h.mock.calls.length).toBe(3); // reviewPasses 2 + adversarial on
    expect(h.mock.calls.length).toBeGreaterThan(m.mock.calls.length);

    const x = okModel();
    const rigX = makeRig({ effort: 'max', callModel: x });
    await startSession(rigX);
    await rigX.handle.reviewTurn('result', rigX.ctx);
    expect(x.mock.calls.length).toBe(4); // reviewPasses 3 + adversarial on
    expect(x.mock.calls.length).toBeGreaterThan(h.mock.calls.length);
  });
});

describe('SB-3 — a headless subagent context resolves deterministically (never blocks on a dialog)', () => {
  afterEach(() => {
    delete process.env[SUBAGENT_DEPTH_ENV];
  });

  it('confirmRelax auto-resolves inside a subagent instead of awaiting ctx.ui.confirm', async () => {
    // A spawned child pi speaks the same rpc protocol → ctx.hasUI === true even
    // with no human. Depth > 0 must short-circuit the relax gate so it can't hang.
    process.env[SUBAGENT_DEPTH_ENV] = '1';
    const rig = makeRig({ effort: 'medium' }); // no callModel → no rung-2 fixer
    await startSession(rig);
    const deps = rig.handle.buildRepairDeps();

    // Parseable-but-schema-invalid args reach rung 4 with usable `current`.
    const result = await repairToolCallArguments('{"wrong":1}', {
      toolName: 'read',
      schema: SCHEMA,
      extraRungs: deps.extraRungs,
    });

    // The (human-less) subagent was NOT prompted, and the relax resolved.
    expect(rig.confirm).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.rung).toBe(4);
  });
});
