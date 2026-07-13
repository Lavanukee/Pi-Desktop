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
  HARNESS_LOOP_ENTRY,
  HARNESS_REVIEW_ENTRY,
  HARNESS_VERIFY_ENTRY,
  type HarnessStage,
  type ProjectCheck,
  type StoredEntryLike,
  SUBAGENT_DEPTH_ENV,
  type VerifyBashRunner,
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

function makeRig(
  opts: {
    effort?: string;
    mode?: string;
    preset?: string;
    callModel?: CallModel;
    verify?: {
      runBash?: VerifyBashRunner;
      detectCheck?: (cwd: string) => ProjectCheck | null;
    };
    cwd?: string;
  } = {},
) {
  const handlers = new Map<string, AnyHandler[]>();
  const entries: StoredEntryLike[] = [];
  if (opts.effort !== undefined || opts.mode !== undefined || opts.preset !== undefined) {
    entries.push({
      type: 'custom',
      customType: HARNESS_CONFIG_ENTRY,
      data: {
        ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
        ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
        ...(opts.preset !== undefined ? { preset: opts.preset } : {}),
      },
    });
  }
  let activeTools: string[] = [];
  const sentUserMessages: string[] = [];
  const steerMessages: string[] = [];

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
    sendUserMessage: (content: string, options?: { deliverAs?: string }) => {
      const text = typeof content === 'string' ? content : JSON.stringify(content);
      sentUserMessages.push(text);
      if (options?.deliverAs === 'steer') steerMessages.push(text);
    },
  } as unknown as ExtensionAPI;

  const abort = vi.fn();
  const notify = vi.fn();
  const confirm = vi.fn(async () => true);
  const setStatus = vi.fn();
  const ctx = {
    hasUI: true,
    cwd: opts.cwd ?? '/workdir',
    ui: { notify, confirm, setStatus },
    getContextUsage: () => ({ tokens: 1, contextWindow: 100, percent: 1 }),
    sessionManager: { getEntries: () => entries },
    abort,
  } as unknown as ExtensionContext & ExtensionCommandContext;

  /** Every `stage` value published on the 'harness' status channel, in order. */
  const publishedStages = (): HarnessStage[] => {
    const out: HarnessStage[] = [];
    for (const call of setStatus.mock.calls) {
      if (call[0] !== 'harness' || typeof call[1] !== 'string') continue;
      try {
        const s = (JSON.parse(call[1]) as { stage?: HarnessStage }).stage;
        if (s !== undefined) out.push(s);
      } catch {
        /* ignore */
      }
    }
    return out;
  };

  const handle = wireHarness(pi, {
    ...(opts.callModel !== undefined ? { callModel: opts.callModel } : {}),
    ...(opts.verify !== undefined ? { verify: opts.verify } : {}),
  });
  const fire = (event: string, e: unknown) =>
    Promise.all((handlers.get(event) ?? []).map((h) => h(e, ctx)));
  return {
    pi,
    entries,
    ctx,
    handle,
    fire,
    sentUserMessages,
    steerMessages,
    publishedStages,
    setStatus,
    abort,
    notify,
    confirm,
  };
}

/** Fire a full classify turn so the loop detector + activeClass are initialized. */
async function startTurn(rig: ReturnType<typeof makeRig>, prompt = 'do a thing') {
  await rig.fire('before_agent_start', {
    type: 'before_agent_start',
    prompt,
    systemPrompt: 'sys',
    images: [],
  });
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
    const steer = (rig.sentUserMessages[0] ?? '').toLowerCase();
    // The steer carries the concrete issue to fix…
    expect(steer).toContain('missing edge case');
    // …and tells the model to keep it private (item 5)…
    expect(steer).toContain('internal');
    // …with NONE of the harness-internal vocabulary the model was parroting.
    expect(steer).not.toContain('reviewer');
    expect(steer).not.toContain('harness');
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

// --- Fix #3: loop / no-progress breaking -----------------------------------

const TOOL_CALL = (input: unknown) => ({
  type: 'tool_call' as const,
  toolName: 'bash',
  toolCallId: 'tc',
  input,
});
const TOOL_END = (isError: boolean) => ({
  type: 'tool_execution_end' as const,
  toolCallId: 'tc',
  toolName: 'bash',
  result: {},
  isError,
});

describe('loop detector — live wiring through tool_call / tool_execution_end', () => {
  const loopEntries = (rig: ReturnType<typeof makeRig>) =>
    rig.entries
      .filter((e) => e.customType === HARNESS_LOOP_ENTRY)
      .map((e) => e.data as { action?: string; cause?: string });

  it('steers once at the 3rd identical call, then aborts the turn at the 5th', async () => {
    const rig = makeRig({ effort: 'medium' }); // steerAfter 3 / abortAfter 5
    await startSession(rig);
    await startTurn(rig);
    const call = () => rig.fire('tool_call', TOOL_CALL({ command: 'ls' }));

    await call();
    await call();
    await call(); // 3rd → steer
    expect(rig.steerMessages).toHaveLength(1);
    expect(loopEntries(rig)).toContainEqual({
      action: 'steer',
      cause: 'identical',
      reason: expect.any(String),
    });
    expect(rig.abort).not.toHaveBeenCalled();

    await call(); // 4th → nothing (already steered)
    expect(rig.steerMessages).toHaveLength(1);
    await call(); // 5th → abort
    expect(rig.abort).toHaveBeenCalledOnce();
    expect(loopEntries(rig)).toContainEqual({
      action: 'abort',
      cause: 'identical',
      reason: expect.any(String),
    });
  });

  it('steers then aborts on a consecutive tool-execution-error streak', async () => {
    const rig = makeRig({ effort: 'medium' });
    await startSession(rig);
    await startTurn(rig);
    const err = () => rig.fire('tool_execution_end', TOOL_END(true));

    await err();
    await err();
    await err(); // 3rd error → steer
    expect(rig.steerMessages).toHaveLength(1);
    expect(loopEntries(rig)).toContainEqual({
      action: 'steer',
      cause: 'error',
      reason: expect.any(String),
    });
    await err();
    await err(); // 5th error → abort
    expect(rig.abort).toHaveBeenCalledOnce();
    expect(loopEntries(rig)).toContainEqual({
      action: 'abort',
      cause: 'error',
      reason: expect.any(String),
    });
  });

  it('resets per turn — a fresh before_agent_start re-arms the detector', async () => {
    const rig = makeRig({ effort: 'medium' });
    await startSession(rig);
    await startTurn(rig);
    const call = () => rig.fire('tool_call', TOOL_CALL({ command: 'ls' }));
    await call();
    await call();
    await call(); // steer #1
    expect(rig.steerMessages).toHaveLength(1);

    await startTurn(rig); // new turn → detector rebuilt, streak + steer cleared
    await call();
    await call();
    await call(); // steer #2 (proves the reset)
    expect(rig.steerMessages).toHaveLength(2);
    expect(rig.abort).not.toHaveBeenCalled();
  });
});

// --- Fix #4: effort-gated REAL verify + bounded fix loop -------------------

const TEST_CHECK: ProjectCheck = { command: 'npm run test', kind: 'test', label: 'npm run test' };
const failingBash = (): VerifyBashRunner =>
  vi.fn(async () => ({ exitCode: 1, stdout: '', stderr: 'FAIL: 2 tests' }));
const passingBash = (): VerifyBashRunner =>
  vi.fn(async () => ({ exitCode: 0, stdout: 'all good', stderr: '' }));

describe('effort-gated REAL verify (bounded fix loop)', () => {
  it('high effort + coding: steers ONE fix on a failing check, then stops (budget 1)', async () => {
    const runBash = failingBash();
    const rig = makeRig({ effort: 'high', verify: { runBash, detectCheck: () => TEST_CHECK } });
    await startSession(rig);
    rig.handle.applyPreset('coding', rig.ctx);

    expect(await rig.handle.verifyTurn(rig.ctx)).toBe(true); // fix #1
    expect(rig.sentUserMessages.some((m) => m.includes('npm run test'))).toBe(true);
    expect(await rig.handle.verifyTurn(rig.ctx)).toBe(false); // budget exhausted → give up
    expect(runBash).toHaveBeenCalledTimes(2);

    const verifyData = rig.entries
      .filter((e) => e.customType === HARNESS_VERIFY_ENTRY)
      .map((e) => e.data as Record<string, unknown>);
    expect(verifyData.some((d) => d.fix === true)).toBe(true);
    expect(verifyData.some((d) => d.gaveUp === true)).toBe(true);
  });

  it('max effort raises the fix budget to 2', async () => {
    const runBash = failingBash();
    const rig = makeRig({ effort: 'max', verify: { runBash, detectCheck: () => TEST_CHECK } });
    await startSession(rig);
    rig.handle.applyPreset('file-ops', rig.ctx);
    expect(await rig.handle.verifyTurn(rig.ctx)).toBe(true); // fix #1
    expect(await rig.handle.verifyTurn(rig.ctx)).toBe(true); // fix #2
    expect(await rig.handle.verifyTurn(rig.ctx)).toBe(false); // budget exhausted
    expect(runBash).toHaveBeenCalledTimes(3);
  });

  it('a passing check triggers no fix', async () => {
    const runBash = passingBash();
    const rig = makeRig({ effort: 'high', verify: { runBash, detectCheck: () => TEST_CHECK } });
    await startSession(rig);
    rig.handle.applyPreset('coding', rig.ctx);
    expect(await rig.handle.verifyTurn(rig.ctx)).toBe(false);
    expect(rig.sentUserMessages).toHaveLength(0);
    expect(runBash).toHaveBeenCalledOnce();
  });

  it('does NOT run below high effort', async () => {
    const runBash = failingBash();
    const rig = makeRig({ effort: 'medium', verify: { runBash, detectCheck: () => TEST_CHECK } });
    await startSession(rig);
    rig.handle.applyPreset('coding', rig.ctx);
    expect(await rig.handle.verifyTurn(rig.ctx)).toBe(false);
    expect(runBash).not.toHaveBeenCalled();
  });

  it('does NOT run for non-coding/file-ops classes', async () => {
    const runBash = failingBash();
    const rig = makeRig({ effort: 'high', verify: { runBash, detectCheck: () => TEST_CHECK } });
    await startSession(rig);
    rig.handle.applyPreset('simple-QA', rig.ctx);
    expect(await rig.handle.verifyTurn(rig.ctx)).toBe(false);
    expect(runBash).not.toHaveBeenCalled();
  });

  it('is permission-mode aware — skipped in review-all', async () => {
    const runBash = failingBash();
    const rig = makeRig({
      effort: 'high',
      mode: 'review-all',
      verify: { runBash, detectCheck: () => TEST_CHECK },
    });
    await startSession(rig);
    rig.handle.applyPreset('coding', rig.ctx);
    expect(await rig.handle.verifyTurn(rig.ctx)).toBe(false);
    expect(runBash).not.toHaveBeenCalled();
  });

  it('falls back to a syntax check over touched files when no infra is detected', async () => {
    const runBash = failingBash();
    const rig = makeRig({ effort: 'high', verify: { runBash, detectCheck: () => null } });
    await startSession(rig);
    await startTurn(rig);
    rig.handle.applyPreset('coding', rig.ctx);
    // A write tool call records the touched file the syntax fallback checks.
    await rig.fire('tool_call', {
      type: 'tool_call',
      toolName: 'write',
      toolCallId: 'w1',
      input: { path: 'mod.py', content: 'x=1' },
    });
    expect(await rig.handle.verifyTurn(rig.ctx)).toBe(true);
    expect(runBash).toHaveBeenCalledWith(expect.stringContaining('py_compile'), expect.anything());
  });
});

// --- Fix #5: HarnessStatus.stage transitions -------------------------------

describe('HarnessStatus.stage transitions publish at the seams', () => {
  it('idle → classifying → working → done across a plain turn', async () => {
    const rig = makeRig({ effort: 'medium' });
    await startSession(rig);
    expect(rig.handle.getStatus(rig.ctx).stage).toBe('idle');

    await startTurn(rig);
    expect(rig.handle.getStatus(rig.ctx).stage).toBe('classifying');

    await rig.fire('agent_start', { type: 'agent_start' });
    expect(rig.handle.getStatus(rig.ctx).stage).toBe('working');

    await rig.fire('agent_end', {
      type: 'agent_end',
      messages: [{ role: 'assistant', content: 'here you go' }],
    });
    expect(rig.handle.getStatus(rig.ctx).stage).toBe('done');

    expect(rig.publishedStages()).toEqual(
      expect.arrayContaining(['idle', 'classifying', 'working', 'done']),
    );
  });

  it('reviewer flag → reviewing then revising are both published', async () => {
    const bad = vi.fn(async () => '{"ok":false,"issues":["x"]}');
    const rig = makeRig({ effort: 'high', callModel: bad });
    await startSession(rig);
    await startTurn(rig);
    expect(await rig.handle.reviewTurn('result', rig.ctx)).toBe(true);
    const stages = rig.publishedStages();
    expect(stages).toContain('reviewing');
    expect(stages).toContain('revising');
    expect(rig.handle.getStatus(rig.ctx).stage).toBe('revising');
  });

  it("the real verify publishes 'verifying'", async () => {
    const rig = makeRig({
      effort: 'high',
      verify: { runBash: passingBash(), detectCheck: () => TEST_CHECK },
    });
    await startSession(rig);
    rig.handle.applyPreset('coding', rig.ctx);
    await rig.handle.verifyTurn(rig.ctx);
    expect(rig.publishedStages()).toContain('verifying');
  });

  it("a repair rung publishes 'repairing', cleared to 'working' on the next tool result", async () => {
    const rig = makeRig({ effort: 'low' }); // no callModel → ladder falls to rungs 3–5
    await startSession(rig);
    await startTurn(rig);
    const deps = rig.handle.buildRepairDeps();
    await repairToolCallArguments('garbage {{{', {
      toolName: 'bash',
      schema: SCHEMA,
      extraRungs: deps.extraRungs,
    });
    expect(rig.publishedStages()).toContain('repairing');
    expect(rig.handle.getStatus(rig.ctx).stage).toBe('repairing');

    await rig.fire('tool_execution_end', TOOL_END(false));
    expect(rig.handle.getStatus(rig.ctx).stage).toBe('working');
  });
});
