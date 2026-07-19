import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bumpDecision,
  type ConsultRunner,
  createSubmitReviewGate,
  newSubmitReviewCapture,
  seedIsolatedWorkspace,
  selectExtensionFactories,
  toToolDefinition,
} from './role-agent-seam-impl';

describe('createSubmitReviewGate — the §164 submission interceptor', () => {
  const REVIEW = 'Re-read your contract and improve the file, then submit again.';

  it('BOUNCES on the first call (returns the self-review prompt, does not finalize)', () => {
    const capture = newSubmitReviewCapture();
    const gate = createSubmitReviewGate({
      slot: 'src/game/physics.ts',
      reviewPrompt: REVIEW,
      readSlot: () => 'draft-contents',
      capture,
    });
    expect(gate()).toBe(REVIEW);
    expect(capture.bounced).toBe(true);
    expect(capture.finalized).toBe(false);
    expect(capture.draftBytes).toBe('draft-contents'.length);
  });

  it('FINALIZES on the second call and records whether the file CHANGED', () => {
    const capture = newSubmitReviewCapture();
    let content = 'draft';
    const gate = createSubmitReviewGate({
      slot: 'src/game/physics.ts',
      reviewPrompt: REVIEW,
      readSlot: () => content,
      capture,
    });
    gate(); // bounce (draft snapshot)
    content = 'improved and longer'; // the engineer improved it after the bounce
    const ack = gate();
    expect(ack.toLowerCase()).toContain('submitted');
    expect(capture.finalized).toBe(true);
    expect(capture.changed).toBe(true);
    expect(capture.finalBytes).toBe('improved and longer'.length);
  });

  it('records no change when the second submit finds the same draft', () => {
    const capture = newSubmitReviewCapture();
    const gate = createSubmitReviewGate({
      slot: 's.ts',
      reviewPrompt: REVIEW,
      readSlot: () => 'same',
      capture,
    });
    gate();
    gate();
    expect(capture.changed).toBe(false);
  });

  it('THROWS the actionable error on finalize when the slot file is missing', () => {
    const gate = createSubmitReviewGate({
      slot: 'src/missing.ts',
      reviewPrompt: REVIEW,
      readSlot: () => undefined, // never written
    });
    gate(); // first call bounces regardless
    expect(() => gate()).toThrow(
      'Your slot file src/missing.ts does not exist yet — write it before submitting.',
    );
  });

  it('the finalize ack is firmly TERMINAL (turn over — stop, do not submit again)', () => {
    const gate = createSubmitReviewGate({
      slot: 's.ts',
      reviewPrompt: REVIEW,
      readSlot: () => 'x',
    });
    gate(); // bounce
    const ack = gate().toLowerCase();
    expect(ack).toContain('finalized');
    expect(ack).toContain('turn is over');
    expect(ack).toContain('stop');
  });

  it('F1 — a THIRD+ submit after finalize is IDEMPOTENT (no loop, no re-read, no re-record)', () => {
    const capture = newSubmitReviewCapture();
    let content = 'draft';
    let reads = 0;
    const gate = createSubmitReviewGate({
      slot: 's.ts',
      reviewPrompt: REVIEW,
      readSlot: () => {
        reads += 1;
        return content;
      },
      capture,
    });
    gate(); // bounce (read #1)
    content = 'final';
    const finalized = gate(); // finalize (read #2)
    expect(capture.finalized).toBe(true);
    expect(capture.finalBytes).toBe('final'.length);
    const readsAfterFinalize = reads;

    // The model keeps calling submit — the gate is a firm terminal dead-end and
    // never re-reads the slot or re-records, so it cannot spin an endless loop.
    content = 'a-later-mutation-that-must-NOT-be-recorded';
    const again = gate();
    const andAgain = gate();
    expect(again).toBe(finalized); // same terminal ack, verbatim
    expect(andAgain).toBe(finalized);
    expect(reads).toBe(readsAfterFinalize); // no further slot reads
    expect(capture.finalBytes).toBe('final'.length); // capture frozen at finalize
    expect(capture.changed).toBe(true);
  });
});

describe('seedIsolatedWorkspace — isolated engineer workspace (spec §91)', () => {
  let ws: ReturnType<typeof seedIsolatedWorkspace> | undefined;
  let shared: string;

  beforeEach(() => {
    shared = mkdtempSync(path.join(os.tmpdir(), 'corp-shared-'));
  });
  afterEach(() => {
    ws?.dispose();
    rmSync(shared, { recursive: true, force: true });
  });

  it('seeds the deps read-only and HARVESTS only the engineer-written files', () => {
    ws = seedIsolatedWorkspace([
      { path: 'src/engine/vec2.ts', content: 'export interface Vec2 { x: number; y: number }' },
    ]);
    // The dep is present in the isolated dir for the engineer to read.
    expect(readFileSync(path.join(ws.dir, 'src/engine/vec2.ts'), 'utf8')).toContain('Vec2');

    // The engineer writes its OWN slot file (+ a supporting file) into the dir.
    writeFileSync(path.join(ws.dir, 'src/engine/physics.ts'), 'import { Vec2 } from "./vec2";');
    writeFileSync(path.join(ws.dir, 'src/engine/helpers.ts'), 'export const eps = 1e-6;');

    const harvested = ws.harvest(shared);
    const paths = harvested.map((f) => f.path).sort();
    // Slot + supporting file harvested; the read-only dep is NOT harvested back.
    expect(paths).toEqual(['src/engine/helpers.ts', 'src/engine/physics.ts']);
    expect(readFileSync(path.join(shared, 'src/engine/physics.ts'), 'utf8')).toContain('Vec2');
    // The dep was never copied into the shared tree by the harvest.
    expect(harvested.some((f) => f.path === 'src/engine/vec2.ts')).toBe(false);
  });

  it('does NOT harvest an edit the engineer made to a read-only dep (deps are read-only)', () => {
    ws = seedIsolatedWorkspace([{ path: 'dep.ts', content: 'original' }]);
    writeFileSync(path.join(ws.dir, 'dep.ts'), 'MUTATED'); // engineer overwrote a dep
    const harvested = ws.harvest(shared);
    expect(harvested).toHaveLength(0); // nothing new produced → nothing harvested
  });
});

describe('toToolDefinition — submit tool wires the §164 gate against a real cwd', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'corp-tool-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('bounces, then finalizes once the slot file exists in cwd', async () => {
    const capture = newSubmitReviewCapture();
    const def = toToolDefinition(
      {
        name: 'submit_contract',
        description: 'submit',
        parameters: { type: 'object', properties: {}, required: [] },
        submitReview: { slot: 'out.ts', reviewPrompt: 'review-me' },
      },
      dir,
      capture,
    );
    const call = (id: string): Promise<{ content: { text?: string }[] }> =>
      def.execute(id, {} as never, undefined, undefined, {} as never) as Promise<{
        content: { text?: string }[];
      }>;

    const first = await call('c1');
    expect(first.content[0]).toMatchObject({ text: 'review-me' });
    expect(capture.bounced).toBe(true);

    // Missing slot → finalize throws (the model is pushed to write first).
    await expect(call('c2')).rejects.toThrow('does not exist yet');

    // Now the engineer writes the slot → finalize acks.
    writeFileSync(path.join(dir, 'out.ts'), 'export const x = 1;');
    const done = await call('c3');
    expect(done.content[0]?.text?.toLowerCase()).toContain('submitted');
    expect(capture.finalized).toBe(true);
  });

  it('a tool with no submitReview is a plain no-op ack (the promotion tool)', async () => {
    const def = toToolDefinition(
      {
        name: 'create_production_hierarchy',
        description: 'promote',
        parameters: { type: 'object', properties: {}, required: [] },
      },
      dir,
    );
    const res = (await def.execute('c1', {} as never, undefined, undefined, {} as never)) as {
      content: { text?: string }[];
    };
    expect(res.content[0]?.text).toContain('recorded');
  });
});

describe('bumpDecision — the completeness backstop condition (pure)', () => {
  const CONTINUE = 'You ended without submitting. Write the file and submit_contract.';
  const base = { finalText: '', continuePrompt: CONTINUE };

  it('STOPS (no bump) when the submit finalized', () => {
    expect(bumpDecision({ ...base, finalized: true, slotExists: false })).toBeUndefined();
  });

  it('STOPS (no bump) when the slot file exists (deliverable present)', () => {
    expect(bumpDecision({ ...base, finalized: false, slotExists: true })).toBeUndefined();
  });

  it('STOPS (no bump) on an explicit "unfulfillable, because …" terminal decision', () => {
    expect(
      bumpDecision({
        finalized: false,
        slotExists: false,
        finalText: 'unfulfillable, because the codec spec is unavailable',
        continuePrompt: CONTINUE,
      }),
    ).toBeUndefined();
  });

  it('BUMPS (returns the continue prompt) on a premature stop — no file, no decision', () => {
    expect(bumpDecision({ ...base, finalized: false, slotExists: false })).toBe(CONTINUE);
  });

  // The CEO vision turn: no slot/submit-gate — its deliverable is the terminal
  // submit_vision call OR its final assistant text.
  it('STOPS (no bump) when a TERMINAL tool was called (submit_vision)', () => {
    expect(
      bumpDecision({ ...base, finalized: false, slotExists: false, terminalCalled: true }),
    ).toBeUndefined();
  });

  it('STOPS (no bump) when text IS the deliverable and it is non-empty (vision brief stated)', () => {
    expect(
      bumpDecision({
        finalized: false,
        slotExists: false,
        textIsDeliverable: true,
        finalText: 'VISION: a calm pomodoro timer …',
        continuePrompt: CONTINUE,
      }),
    ).toBeUndefined();
  });

  it('BUMPS a vision turn that stopped with no submit and no text', () => {
    expect(
      bumpDecision({
        ...base,
        finalized: false,
        slotExists: false,
        terminalCalled: false,
        textIsDeliverable: true,
      }),
    ).toBe(CONTINUE);
  });
});

describe('selectExtensionFactories — research surfaces gated by the tool allowlist', () => {
  // Distinct sentinel factories so the returned list's IDENTITY + ORDER is checkable.
  const web = ((_pi: ExtensionAPI) => undefined) as unknown as Parameters<
    typeof selectExtensionFactories
  >[1]['webResearchFactory'];
  const browser = ((_pi: ExtensionAPI) => undefined) as unknown as Parameters<
    typeof selectExtensionFactories
  >[1]['browserToolsFactory'];

  it('installs the web factory when a web tool is in the allowlist', () => {
    expect(
      selectExtensionFactories(['read', 'web_search', 'submit_vision'], {
        webResearchFactory: web,
      }),
    ).toEqual([web]);
  });

  it('installs the browser factory when a browser tool is in the allowlist', () => {
    expect(
      selectExtensionFactories(['read', 'browser_navigate', 'submit_vision'], {
        browserToolsFactory: browser,
      }),
    ).toEqual([browser]);
  });

  it('installs BOTH (web before browser) for the CEO vision allowlist — browser + web tools', () => {
    // The real vision allowlist requests both surfaces; the seam installs both, in a
    // deterministic order (web first).
    expect(
      selectExtensionFactories(
        ['read', 'write', 'bash', 'browser_navigate', 'browser_read', 'web_search', 'web_fetch'],
        { webResearchFactory: web, browserToolsFactory: browser },
      ),
    ).toEqual([web, browser]);
  });

  it('installs NOTHING when the allowlist requests neither surface (an engineer)', () => {
    expect(
      selectExtensionFactories(['read', 'write', 'edit', 'bash'], {
        webResearchFactory: web,
        browserToolsFactory: browser,
      }),
    ).toEqual([]);
  });

  it('skips a surface whose factory was not injected even when its tools are listed', () => {
    // Browser tool listed but no browser factory → only the injected web factory installs.
    expect(
      selectExtensionFactories(['browser_navigate', 'web_search'], { webResearchFactory: web }),
    ).toEqual([web]);
  });
});

describe('toToolDefinition — consult tools spawn a clean-context advisor (advice-only)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'corp-consult-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function consultTool(kind: 'peer' | 'specialist') {
    return {
      name: kind === 'peer' ? 'call_peer' : 'call_specialist',
      description: 'consult',
      parameters: { type: 'object', properties: {}, required: [] },
      consult:
        kind === 'peer'
          ? {
              kind,
              context: 'the stuck module',
              systemPrompt: 'PEER-PROMPT',
              samplingMode: 'thinking-general' as const,
            }
          : {
              kind,
              context: 'the stuck module',
              lensPrompts: { correctness: 'CORRECTNESS-PROMPT', security: 'SECURITY-PROMPT' },
              samplingMode: 'thinking-general' as const,
            },
    };
  }

  function recordingRunner(overrides: Partial<ConsultRunner> = {}): {
    runner: ConsultRunner;
    calls: { systemPrompt: string; question: string; kind: string }[];
  } {
    const calls: { systemPrompt: string; question: string; kind: string }[] = [];
    const runner: ConsultRunner = {
      spawnAdvisor: async (req) => {
        calls.push({ systemPrompt: req.systemPrompt, question: req.question, kind: req.kind });
        return `advice for: ${req.question}`;
      },
      ...overrides,
    };
    return { runner, calls };
  }

  const call = (def: ReturnType<typeof toToolDefinition>, params: unknown) =>
    def.execute('c1', params as never, undefined, undefined, {} as never) as Promise<{
      content: { text?: string }[];
    }>;

  it('call_peer spawns the peer advisor with its prompt + the question, returns prose', async () => {
    const { runner, calls } = recordingRunner();
    const def = toToolDefinition(consultTool('peer'), dir, undefined, runner);
    const res = await call(def, { question: 'How do I integrate physics?' });
    expect(res.content[0]?.text).toBe('advice for: How do I integrate physics?');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.systemPrompt).toBe('PEER-PROMPT');
    expect(calls[0]?.kind).toBe('peer');
  });

  it('call_specialist resolves the chosen lens prompt (and falls back to the first)', async () => {
    const { runner, calls } = recordingRunner();
    const def = toToolDefinition(consultTool('specialist'), dir, undefined, runner);
    await call(def, { lens: 'security', question: 'is this safe?' });
    expect(calls[0]?.systemPrompt).toBe('SECURITY-PROMPT');
    // An unknown/absent lens falls back to the first entry.
    await call(def, { lens: 'nonsense', question: 'check it' });
    expect(calls[1]?.systemPrompt).toBe('CORRECTNESS-PROMPT');
  });

  it('DECLINES without spawning when the consult budget is spent (charged like any turn)', async () => {
    const { runner, calls } = recordingRunner({ onConsult: () => false });
    const def = toToolDefinition(consultTool('peer'), dir, undefined, runner);
    const res = await call(def, { question: 'help' });
    expect(res.content[0]?.text?.toLowerCase()).toContain('budget is spent');
    expect(calls).toHaveLength(0); // no advisor spawned
  });

  it('charges exactly once per consult when the budget allows', async () => {
    let charges = 0;
    const { runner } = recordingRunner({
      onConsult: () => {
        charges += 1;
        return true;
      },
    });
    const def = toToolDefinition(consultTool('peer'), dir, undefined, runner);
    await call(def, { question: 'help' });
    expect(charges).toBe(1);
  });
});
