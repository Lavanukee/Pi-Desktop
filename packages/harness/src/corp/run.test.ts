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
