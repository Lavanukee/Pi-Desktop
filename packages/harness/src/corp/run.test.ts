import { describe, expect, it } from 'vitest';
import { newRunBudget } from './budget.js';
import { CREATE_PRODUCTION_HIERARCHY } from './promotion.js';
import type { RoleAgentRunInput, RunRoleAgentFn } from './role-agent-seam.js';
import { type CorpChatFn, type CorpChatResult, type CorpTurnPurpose, runCorp } from './run.js';
import { type WorkspaceFs, type WorkspaceReadFs, writeSlot } from './workspace.js';

// --- In-memory workspace (no node:fs) ----------------------------------------

function memWorkspace(): { fs: WorkspaceFs; readFs: WorkspaceReadFs } {
  const files = new Map<string, string>();
  return {
    fs: { writeFile: (path, content) => void files.set(path, content) },
    readFs: {
      readFile: (path) => files.get(path),
      listFiles: (root) => [...files.keys()].filter((p) => p === root || p.startsWith(`${root}/`)),
    },
  };
}

// --- A configurable, purpose-aware misbehaving mock model --------------------

type Misbehavior = 'valid' | 'empty' | 'error';

interface MockConfig {
  readonly worker?: Misbehavior;
  readonly architect?: Misbehavior;
  readonly manager?: Misbehavior;
  readonly engineer?: Misbehavior;
  readonly rescope?: Misbehavior;
  readonly ceo?: Misbehavior;
  /** When the CEO behaves `valid`, which verdict it returns. */
  readonly ceoVerdict?: 'approve' | 'revise';
}

const PROMOTION = {
  reason: 'multi-part build beyond one pass',
  divisions: [
    { name: 'Frontend', purpose: 'the UI' },
    { name: 'Backend', purpose: 'the API' },
  ],
};
const ENGINEER_FILE = 'export const value = 1;\nexport function ok() {\n  return value;\n}\n';
const CEO_APPROVE = 'APPROVE — the product meets the vision.';
const CEO_REVISE = 'REVISE\nThe data layer is missing; wire it up before shipping.';

interface Mock {
  readonly chat: CorpChatFn;
  readonly callsByPurpose: Record<CorpTurnPurpose, number>;
}

function makeMock(config: MockConfig = {}): Mock {
  const callsByPurpose: Record<CorpTurnPurpose, number> = {
    worker: 0,
    architect: 0,
    manager: 0,
    engineer: 0,
    ceo: 0,
    rescope: 0,
    revise: 0,
    consult: 0,
  };
  let contractCounter = 0;

  const validContracts = (count = 2): string => {
    const arr = [];
    for (let i = 0; i < count; i++) {
      contractCounter += 1;
      const n = contractCounter;
      arr.push({
        id: `c${n}`,
        title: `Contract ${n}`,
        ownerNodeId: `eng-${n}`,
        input: `input ${n}`,
        output: `output ${n}`,
        slot: `src/c${n}.ts`,
        available: { tools: ['write'], imports: [] },
        reviewRubric: `rubric ${n}`,
        dependsOn: [],
        status: 'queued',
      });
    }
    return JSON.stringify(arr);
  };

  const behaviorFor = (purpose: CorpTurnPurpose): Misbehavior => {
    switch (purpose) {
      case 'worker':
        return config.worker ?? 'valid';
      case 'architect':
        return config.architect ?? 'valid';
      case 'manager':
        return config.manager ?? 'valid';
      case 'engineer':
        return config.engineer ?? 'valid';
      case 'rescope':
        return config.rescope ?? 'valid';
      default:
        return config.ceo ?? 'valid'; // ceo + revise re-review
    }
  };

  const validFor = (purpose: CorpTurnPurpose): CorpChatResult => {
    switch (purpose) {
      case 'worker':
        return {
          content: '',
          toolCalls: [{ name: CREATE_PRODUCTION_HIERARCHY, arguments: JSON.stringify(PROMOTION) }],
        };
      case 'architect':
        return { content: JSON.stringify({ moduleMap: [], interfaces: [] }) };
      case 'manager':
        return { content: validContracts() };
      case 'engineer':
        return { content: ENGINEER_FILE };
      case 'rescope':
        return { content: 'RE-CONTRACT: a narrower, concrete contract.' };
      default:
        return {
          content: (config.ceoVerdict ?? 'approve') === 'approve' ? CEO_APPROVE : CEO_REVISE,
        };
    }
  };

  const chat: CorpChatFn = (request) => {
    callsByPurpose[request.purpose] += 1;
    const behavior = behaviorFor(request.purpose);
    if (behavior === 'error') throw new Error(`mock ${request.purpose} failure`);
    if (behavior === 'empty') return { content: '' };
    return validFor(request.purpose);
  };

  return { chat, callsByPurpose };
}

function totalCalls(byPurpose: Record<CorpTurnPurpose, number>): number {
  return Object.values(byPurpose).reduce((a, b) => a + b, 0);
}

// --- Happy path (a well-behaved model completes and approves) ----------------

describe('runCorp — well-behaved model completes', () => {
  it('promotes, dispatches every contract, verifies, and approves', async () => {
    const { fs, readFs } = memWorkspace();
    const mock = makeMock();
    const result = await runCorp({
      task: 'Build a thing',
      chat: mock.chat,
      fs,
      readFs,
      workspace: '/ws',
    });

    expect(result.promoted).toBe(true);
    expect(result.terminatedReason).toBe('completed');
    expect(result.divisions).toEqual(['Frontend', 'Backend']);
    expect(result.totalContracts).toBe(4); // 2 divisions × 2 contracts
    expect(result.manifest?.fileCount).toBe(4);
    expect(result.verify?.ok).toBe(true);
    expect(result.ceoDecision?.decision).toBe('approve');
    expect(result.revise?.revisionsRun).toBe(0);
    expect(result.budget.exceeded).toBe(false);

    // The interceptor fires EXACTLY once per contract (draft + review = 2 turns
    // each), retry does NOT fire, and no revise/rescope turns run — every loop is
    // bounded to its expected count (no unbounded recursion).
    expect(mock.callsByPurpose.worker).toBe(1);
    expect(mock.callsByPurpose.manager).toBe(2); // no retry
    expect(mock.callsByPurpose.engineer).toBe(8); // 2 per contract × 4
    expect(mock.callsByPurpose.ceo).toBe(1);
    expect(mock.callsByPurpose.revise).toBe(0);
    expect(totalCalls(mock.callsByPurpose)).toBeLessThanOrEqual(result.budget.maxTurns);
  });
});

// --- The headline: a misbehaving model ALWAYS terminates within budget -------

describe('runCorp — misbehaving models always terminate (the endless-loop catch)', () => {
  it('variant A — always EMPTY downstream: terminates with a recorded terminal state', async () => {
    const { fs, readFs } = memWorkspace();
    const mock = makeMock({
      architect: 'empty',
      manager: 'empty',
      engineer: 'empty',
      ceo: 'empty',
    });
    const result = await runCorp({
      task: 'Build a thing',
      chat: mock.chat,
      fs,
      readFs,
      workspace: '/ws',
    });

    expect(result.terminatedReason).toBe('completed'); // the flow ran to an honest end
    expect(result.promoted).toBe(true);
    expect(result.totalContracts).toBe(0); // managers produced nothing
    // Retry-on-empty fired ONCE per division (2), never more — bounded.
    expect(result.emptyAfterRetryDivisions).toHaveLength(2);
    expect(mock.callsByPurpose.manager).toBe(4); // 2 divisions × (1 + 1 retry)
    // The CEO's empty reply defaults to revise (never rubber-stamp), bounded to the cap.
    expect(result.ceoDecision?.decision).toBe('revise');
    expect(result.revise?.hitCap).toBe(true);
    expect(result.revise?.revisionsRun).toBe(1);
    expect(result.budget.exceeded).toBe(false);
  });

  it('variant B — CEO ALWAYS REVISES: terminates at the revision cap with the honest verdict', async () => {
    const { fs, readFs } = memWorkspace();
    const mock = makeMock({ ceoVerdict: 'revise' });
    const result = await runCorp({
      task: 'Build a thing',
      chat: mock.chat,
      fs,
      readFs,
      workspace: '/ws',
      maxRevisions: 1,
    });

    expect(result.terminatedReason).toBe('completed');
    expect(result.manifest?.fileCount).toBe(4); // real work was produced
    expect(result.initialCeoDecision?.decision).toBe('revise');
    expect(result.ceoDecision?.decision).toBe('revise'); // the honest final state stands
    expect(result.revise?.revisionsRun).toBe(1); // exactly maxRevisions
    expect(result.revise?.hitCap).toBe(true);
    expect(result.revise?.approved).toBe(false);
    // One initial review + one bounded re-review — the loop did not churn.
    expect(mock.callsByPurpose.ceo).toBe(1);
    expect(mock.callsByPurpose.revise).toBe(1);
    expect(result.budget.exceeded).toBe(false);
  });

  it('variant C — always ERRORS downstream: never throws, terminates, records the errors', async () => {
    const { fs, readFs } = memWorkspace();
    const mock = makeMock({
      architect: 'error',
      manager: 'error',
      engineer: 'error',
      rescope: 'error',
      ceo: 'error',
    });
    // Must not reject/hang — a run over an all-erroring model still terminates.
    const result = await runCorp({
      task: 'Build a thing',
      chat: mock.chat,
      fs,
      readFs,
      workspace: '/ws',
    });

    expect(result.terminatedReason).toBe('completed');
    expect(result.promoted).toBe(true);
    expect(result.errors.length).toBeGreaterThan(0); // errors recorded, not dropped
    expect(result.ceoDecision?.decision).toBe('revise'); // errored CEO ⇒ honest revise
    expect(result.budget.exceeded).toBe(false);
  });

  it('a truly blanket empty/error model (worker included) terminates as solo', async () => {
    const wsA = memWorkspace();
    const empty = makeMock({
      worker: 'empty',
      architect: 'empty',
      manager: 'empty',
      engineer: 'empty',
      ceo: 'empty',
    });
    const emptyResult = await runCorp({
      task: 't',
      chat: empty.chat,
      fs: wsA.fs,
      readFs: wsA.readFs,
      workspace: '/ws',
    });
    expect(emptyResult.promoted).toBe(false);
    expect(emptyResult.terminatedReason).toBe('solo');

    const wsB = memWorkspace();
    const erroring = makeMock({
      worker: 'error',
      architect: 'error',
      manager: 'error',
      engineer: 'error',
      ceo: 'error',
    });
    const errResult = await runCorp({
      task: 't',
      chat: erroring.chat,
      fs: wsB.fs,
      readFs: wsB.readFs,
      workspace: '/ws',
    });
    expect(errResult.promoted).toBe(false);
    expect(errResult.terminatedReason).toBe('solo');
    expect(errResult.errors.length).toBeGreaterThan(0);
  });
});

// --- Every role runs HARNESSED through the injected role-agent seam ----------

/** A purpose-aware mock role-agent seam: the worker calls the promotion tool, the
 * architect + managers emit their structured JSON as finalText, each engineer
 * WRITES its slot file (so dispatch reads it back), and the CEO approves. Records
 * every {@link RoleAgentRunInput} so a test can assert the per-role framing. */
function makeAgentMock(
  fs: WorkspaceFs,
  workspace: string,
): { runRoleAgent: RunRoleAgentFn; calls: RoleAgentRunInput[] } {
  const calls: RoleAgentRunInput[] = [];
  let contractCounter = 0;
  const contractsFor = (division: string): string => {
    const slug = division.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const arr = [0, 1].map(() => {
      contractCounter += 1;
      const n = contractCounter;
      return {
        id: `c${n}`,
        title: `Contract ${n}`,
        ownerNodeId: `${slug}-eng-${n}`,
        input: `input ${n}`,
        output: `output ${n}`,
        slot: `src/${slug}/c${n}.ts`,
        available: { tools: ['write'], imports: [] },
        reviewRubric: `rubric ${n}`,
        dependsOn: [],
        status: 'queued',
      };
    });
    return JSON.stringify(arr);
  };
  const runRoleAgent: RunRoleAgentFn = (input) => {
    calls.push(input);
    const base = { filesWritten: [], toolCalls: [], terminatedReason: 'stop' } as const;
    switch (input.purpose) {
      case 'worker':
        return Promise.resolve({
          ...base,
          finalText: '',
          toolCalls: [{ name: CREATE_PRODUCTION_HIERARCHY, arguments: JSON.stringify(PROMOTION) }],
        });
      case 'architect':
        return Promise.resolve({
          ...base,
          finalText: JSON.stringify({ moduleMap: [], interfaces: [] }),
        });
      case 'manager': {
        const division = /Division:\s*(.+)/.exec(input.userPrompt)?.[1]?.trim() ?? 'X';
        return Promise.resolve({ ...base, finalText: contractsFor(division) });
      }
      case 'engineer': {
        const slot = /THIS exact path\):\s*(\S+)/.exec(input.userPrompt)?.[1] ?? 'src/x.ts';
        const path = writeSlot(workspace, slot, ENGINEER_FILE, fs);
        return Promise.resolve({
          ...base,
          finalText: '',
          filesWritten: [{ path, bytes: ENGINEER_FILE.length }],
        });
      }
      default: // ceo + revise
        return Promise.resolve({ ...base, finalText: CEO_APPROVE });
    }
  };
  return { runRoleAgent, calls };
}

describe('runCorp — every role runs harnessed through the role-agent seam', () => {
  it('routes worker/architect/managers/engineers/CEO through the agent, and completes', async () => {
    const { fs, readFs } = memWorkspace();
    const mock = makeAgentMock(fs, '/ws');
    // A chat seam is present but must NEVER be called when the role-agent is injected.
    let chatCalls = 0;
    const chat: CorpChatFn = () => {
      chatCalls += 1;
      return { content: '' };
    };
    const result = await runCorp({
      task: 'Build a thing',
      chat,
      runRoleAgent: mock.runRoleAgent,
      fs,
      readFs,
      workspace: '/ws',
    });

    expect(result.promoted).toBe(true);
    expect(result.terminatedReason).toBe('completed');
    expect(result.divisions).toEqual(['Frontend', 'Backend']);
    expect(result.totalContracts).toBe(4);
    expect(result.manifest?.fileCount).toBe(4); // engineers WROTE via the seam
    expect(result.ceoDecision?.decision).toBe('approve');
    expect(chatCalls).toBe(0); // no role ran bare on the chat seam

    // Each role ran through the seam exactly as expected (agent engineer path runs
    // ONE dispatch turn per contract — the §164 self-review bounce lives INSIDE that
    // one agent run, in the submit_contract tool, not as a second dispatch turn).
    const purposes = mock.calls.map((c) => c.purpose);
    expect(purposes.filter((p) => p === 'worker')).toHaveLength(1);
    expect(purposes.filter((p) => p === 'architect')).toHaveLength(1);
    expect(purposes.filter((p) => p === 'manager')).toHaveLength(2);
    expect(purposes.filter((p) => p === 'engineer')).toHaveLength(4);
    expect(purposes.filter((p) => p === 'ceo')).toHaveLength(1);

    // Worker: promotion tool as a custom tool, thinking ON, thinking-general sampling.
    // The promotion tool name MUST also be in the allowlist (`tools`) — the SDK gates
    // custom tools against it, so an empty allowlist would silently hide the tool.
    const worker = mock.calls.find((c) => c.purpose === 'worker');
    expect(worker?.customTools?.map((t) => t.name)).toContain(CREATE_PRODUCTION_HIERARCHY);
    expect(worker?.tools).toContain(CREATE_PRODUCTION_HIERARCHY);
    expect(worker?.thinking).toBe(true);
    expect(worker?.samplingMode).toBe('thinking-general');

    // Architect + manager: thinking OFF, instruct-general (structured JSON).
    const architect = mock.calls.find((c) => c.purpose === 'architect');
    expect(architect?.thinking).toBe(false);
    expect(architect?.samplingMode).toBe('instruct-general');
    const manager = mock.calls.find((c) => c.purpose === 'manager');
    expect(manager?.thinking).toBe(false);
    expect(manager?.samplingMode).toBe('instruct-general');

    // CEO: thinking ON, read + bash tools, thinking-general — and the FALSE-COMPLETION
    // cure preserved: the user turn is vision-only, never the engineer file body.
    const ceo = mock.calls.find((c) => c.purpose === 'ceo');
    expect(ceo?.thinking).toBe(true);
    expect(ceo?.tools).toEqual(expect.arrayContaining(['read', 'bash']));
    expect(ceo?.samplingMode).toBe('thinking-general');
    expect(ceo?.userPrompt).toContain('Build a thing'); // the original task (the standard)
    expect(ceo?.userPrompt).not.toContain('export const value'); // NOT the build/file body

    // Engineer system prompt is SELF-CONTAINED (spec §91): a module-builder framing
    // with the division PURPOSE as neutral domain flavor — and NO corporation lore.
    const engineer = mock.calls.find((c) => c.purpose === 'engineer');
    expect(engineer?.systemPrompt).toContain('ONE self-contained module'); // module-builder base
    expect(engineer?.systemPrompt).toContain("This module's domain: the UI"); // domain flavor
    for (const lore of ['CEO', 'manager', 'division', 'corporation'])
      expect(engineer?.systemPrompt).not.toContain(lore);

    // WRITE-RELIABILITY: every engineer runs in an ISOLATED workspace (spec §91,
    // isolated is the default) and gets `submit_contract` as a custom tool whose
    // name is ALSO in the allowlist (the gotcha) — the §164 submission interceptor,
    // carrying its slot + self-review prompt — plus the file tools to write.
    expect(engineer?.isolation).toBeDefined(); // isolated per engineer (default)
    expect(engineer?.tools).toContain('submit_contract');
    expect(engineer?.tools).toEqual(expect.arrayContaining(['read', 'write', 'bash']));
    const submit = engineer?.customTools?.find((t) => t.name === 'submit_contract');
    expect(submit).toBeDefined();
    expect(submit?.submitReview?.slot).toBe(
      engineer?.userPrompt.match(/THIS exact path\):\s*(\S+)/)?.[1],
    );
    expect(submit?.submitReview?.reviewPrompt).toBeTruthy();

    // CONSULTS (spec §7, advice-only): the engineer ALSO gets call_peer +
    // call_specialist, with their names in the allowlist (the gate) — the stuck
    // engineer's first stop before returning unfulfillable.
    expect(engineer?.tools).toEqual(expect.arrayContaining(['call_peer', 'call_specialist']));
    const peer = engineer?.customTools?.find((t) => t.name === 'call_peer');
    const specialist = engineer?.customTools?.find((t) => t.name === 'call_specialist');
    expect(peer?.consult?.kind).toBe('peer');
    expect(specialist?.consult?.kind).toBe('specialist');
    expect(Object.keys(specialist?.consult?.lensPrompts ?? {})).toEqual(
      expect.arrayContaining(['correctness', 'security', 'performance']),
    );
    // BUMP-TO-CONTINUE (completeness backstop): the engineer run carries the bounded
    // bump policy (2 max) + the continue prompt — NOT a per-agent work cap.
    expect(engineer?.bump?.maxBumps).toBe(2);
    expect(engineer?.bump?.continuePrompt).toContain('without submitting');
    // NO per-agent caps: the seam carries neither a step cap nor a per-agent
    // timeout — the field for each was removed. The engineer runs until it submits
    // / the global RunBudget; only a per-CALL network abort lives in the app runtime.
    expect('maxSteps' in (engineer ?? {})).toBe(false);
    expect('timeoutMs' in (engineer ?? {})).toBe(false);
    // The prompt drives to a WRITE + submit, and forbids aimless exploration.
    expect(engineer?.userPrompt).toContain('submit_contract');
    expect(engineer?.userPrompt.toLowerCase()).toContain('do not explore');
  });

  it('falls back to the chat seam for every role when no role-agent is injected', async () => {
    const { fs, readFs } = memWorkspace();
    const mock = makeMock();
    const result = await runCorp({
      task: 'Build a thing',
      chat: mock.chat,
      fs,
      readFs,
      workspace: '/ws',
    });
    // The pre-existing chat pipeline is byte-for-byte unchanged (the slice4 driver
    // chat-fallback contract): promoted, dispatched, verified, approved.
    expect(result.promoted).toBe(true);
    expect(result.terminatedReason).toBe('completed');
    expect(result.ceoDecision?.decision).toBe('approve');
    expect(mock.callsByPurpose.worker).toBe(1);
    expect(mock.callsByPurpose.engineer).toBe(8); // draft + review per contract × 4
  });
});

// --- Escalation RE-DISPATCHES a re-scoped contract (spec §9, §205) ------------

const PROMOTION_ONE = {
  reason: 'one hard module beyond a solo pass',
  divisions: [{ name: 'Core', purpose: 'the core module' }],
};

/** A JSON contract array with one contract at `slot`. */
function oneContractJson(slot: string): string {
  return JSON.stringify([
    {
      id: 'c1',
      title: 'The hard module',
      ownerNodeId: 'eng-1',
      input: 'a spec',
      output: 'the module',
      slot,
      available: { tools: ['write'], imports: [] },
      reviewRubric: 'meets the slot',
      dependsOn: [],
      status: 'queued',
    },
  ]);
}

/** A re-scoped (narrower) contract the manager emits on the rescope turn. */
const RESCOPED_JSON = JSON.stringify([
  {
    id: 'r1',
    title: 'Narrowed hard module',
    ownerNodeId: 'eng-1',
    input: 'a narrower spec',
    output: 'a smaller module',
    slot: 'src/hard.ts',
    available: { tools: ['write'], imports: [] },
    reviewRubric: 'meets the narrowed slot',
    dependsOn: [],
    status: 'queued',
  },
]);

/**
 * A chat mock for the escalation path: promotes to one division, plans one contract
 * whose ENGINEER fails on first dispatch (empty draft + empty retry) and SUCCEEDS
 * once re-dispatched, approves at the CEO, and — critically — answers the RESCOPE
 * turn with either a re-scoped contract (`recover`) or an empty array (`gap`).
 */
function makeEscalationMock(mode: 'recover' | 'gap'): Mock {
  const callsByPurpose: Record<CorpTurnPurpose, number> = {
    worker: 0,
    architect: 0,
    manager: 0,
    engineer: 0,
    ceo: 0,
    rescope: 0,
    revise: 0,
    consult: 0,
  };
  const chat: CorpChatFn = (request) => {
    callsByPurpose[request.purpose] += 1;
    switch (request.purpose) {
      case 'worker':
        return {
          content: '',
          toolCalls: [
            { name: CREATE_PRODUCTION_HIERARCHY, arguments: JSON.stringify(PROMOTION_ONE) },
          ],
        };
      case 'architect':
        return { content: JSON.stringify({ moduleMap: [], interfaces: [] }) };
      case 'manager':
        return { content: oneContractJson('src/hard.ts') };
      case 'engineer':
        // First dispatch (draft + retry = 2 calls) fails empty; the re-dispatch
        // (draft + self-review = calls 3,4) produces a real file → recovered.
        return callsByPurpose.engineer > 2
          ? { content: '```\nexport const hard = 1;\n```' }
          : { content: '' };
      case 'rescope':
        return { content: mode === 'recover' ? RESCOPED_JSON : '[]' };
      default:
        return { content: CEO_APPROVE };
    }
  };
  return { chat, callsByPurpose };
}

describe('runCorp — escalation re-scopes AND re-dispatches (recovery, not a silent gap)', () => {
  it('a failed contract is re-scoped by the manager and RE-DISPATCHED, recovering the gap', async () => {
    const { fs, readFs } = memWorkspace();
    const mock = makeEscalationMock('recover');
    const result = await runCorp({
      task: 'Build one hard thing',
      chat: mock.chat,
      fs,
      readFs,
      workspace: '/ws',
    });

    expect(result.promoted).toBe(true);
    expect(result.escalations).toHaveLength(1);
    const esc = result.escalations[0];
    // The escalation ran the re-scope turn, produced a contract, RE-DISPATCHED it,
    // and recovered — NOT a silently accepted gap (the old NO-OP behavior).
    expect(esc?.rescoped).toBe(true);
    expect(esc?.redispatched).toBe(true);
    expect(esc?.recovered).toBe(true);
    expect(esc?.acceptedGap).toBe(false);
    // Exactly ONE re-scope turn (bounded); the re-dispatch produced the slot file.
    expect(mock.callsByPurpose.rescope).toBe(1);
    expect(result.manifest?.fileCount).toBe(1); // the recovered file exists
    // The recovered contract is no longer reported as a failure.
    expect(result.failures.map((f) => f.contractId)).not.toContain('c1');
    expect(result.budget.exceeded).toBe(false);
  });

  it('when the manager accepts the gap (empty re-scope), it is a bounded accepted gap — never a deadlock', async () => {
    const { fs, readFs } = memWorkspace();
    const mock = makeEscalationMock('gap');
    const result = await runCorp({
      task: 'Build one hard thing',
      chat: mock.chat,
      fs,
      readFs,
      workspace: '/ws',
    });

    expect(result.escalations).toHaveLength(1);
    const esc = result.escalations[0];
    expect(esc?.rescoped).toBe(false); // the manager returned [] (accept the gap)
    expect(esc?.redispatched).toBe(false);
    expect(esc?.recovered).toBe(false);
    expect(esc?.acceptedGap).toBe(true); // bounded — accepted, not retried forever
    expect(mock.callsByPurpose.rescope).toBe(1); // exactly one attempt
    expect(result.terminatedReason).toBe('completed'); // still an honest end
    expect(result.budget.exceeded).toBe(false);
  });
});

// --- The RunBudget catches a genuine infinite loop ---------------------------

describe('runCorp — the RunBudget is the ultimate net', () => {
  it('an always-revising CEO with the revision cap effectively disabled is caught by the budget', async () => {
    const { fs, readFs } = memWorkspace();
    const mock = makeMock({ ceoVerdict: 'revise' });
    // Disable the revision cap so the revise loop WOULD run forever — only the
    // RunBudget can stop it. A small budget makes the catch fast and deterministic.
    const budget = newRunBudget({ maxTurns: 20 });
    const result = await runCorp({
      task: 'Build a thing',
      chat: mock.chat,
      fs,
      readFs,
      workspace: '/ws',
      maxRevisions: 1_000_000,
      budget,
    });

    // The run TERMINATED — the endless loop was caught.
    expect(result.terminatedReason).toBe('budget-exceeded');
    expect(result.budget.exceeded).toBe(true);
    expect(result.revise?.stoppedForBudget).toBe(true);
    // It looped PAST the default single revision (proving the loop was entered)…
    expect(result.revise?.revisionsRun ?? 0).toBeGreaterThan(1);
    // …but stayed hard-bounded — never unbounded, and never over the turn cap.
    expect(result.revise?.revisionsRun ?? 0).toBeLessThan(1000);
    expect(result.budget.turnsUsed).toBeLessThanOrEqual(result.budget.maxTurns);
  });
});
