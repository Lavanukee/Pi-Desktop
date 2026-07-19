import { describe, expect, it } from 'vitest';
import type { ProductManifest } from './assemble.js';
import { newRunBudget } from './budget.js';
import type { Contract } from './org-chart.js';
import type { PreflightResult } from './preflight.js';
import {
  buildFindingsSummary,
  buildReviewAgentInput,
  buildReviewSystemPrompt,
  buildReviewUserPrompt,
  deriveBlockingFromVerify,
  derivePreflightBlocking,
  deriveTesterGateBlocking,
  hasRenderableArtifacts,
  hasRunnableEntry,
  isBlocking,
  mapFindingsToContractIds,
  normalizeSeverity,
  parseFindings,
  type ReviewFinding,
  runReviewPhase,
  SUBMIT_FINDINGS_TOOL,
  selectReviewLenses,
} from './review.js';
import type { RoleAgentRunInput, RoleAgentRunOutput } from './role-agent-seam.js';
import type { VerifyResult } from './verify.js';

function contract(
  id: string,
  slot: string,
  dependsOn: string[] = [],
  output = `output ${id}`,
): Contract {
  return {
    id,
    title: `Contract ${id}`,
    ownerNodeId: `eng-${id}`,
    input: `input ${id}`,
    output,
    slot,
    available: { tools: ['read', 'write', 'bash'], imports: [] },
    reviewRubric: `rubric ${id}`,
    dependsOn,
    status: 'in-review',
  };
}

function manifestWith(slots: string[]): ProductManifest {
  return {
    divisions: [{ id: 'd1', name: 'Core' }],
    files: slots.map((slot) => ({ slot, path: `/ws/${slot}`, bytes: 100 })),
    interfaces: [],
    contractStatusSummary: { done: slots.length, failed: 0, skipped: 0 },
    totalBytes: slots.length * 100,
  };
}

const okVerify: VerifyResult = { ok: true, filesChecked: 3, errors: [] };
/** A passing/inapplicable preflight (the entry loads, or there is no browser entry). */
const okPreflight: PreflightResult = { ok: true, applicable: false, filesChecked: 0, defects: [] };

describe('lens selection (spec §8 — pick lenses appropriate to the product)', () => {
  it('always runs correctness/tester/security/performance for a code product', () => {
    const plan = selectReviewLenses(manifestWith(['src/a.ts', 'src/b.ts']));
    expect(plan.map((p) => p.lens)).toEqual(['correctness', 'tester', 'security', 'performance']);
    expect(plan.every((p) => !p.renderLimited)).toBe(true);
    // The tester (build/run/screenshot workability lens) always runs (spec §8).
    expect(plan.some((p) => p.lens === 'tester')).toBe(true);
  });

  it('adds visual-critic + accessibility (render-limited) when renderable artifacts exist', () => {
    const plan = selectReviewLenses(manifestWith(['src/app.tsx', 'index.html', 'styles.css']));
    expect(plan.map((p) => p.lens)).toEqual([
      'correctness',
      'tester',
      'security',
      'performance',
      'visual-critic',
      'accessibility',
    ]);
    expect(plan.find((p) => p.lens === 'visual-critic')?.renderLimited).toBe(true);
    expect(plan.find((p) => p.lens === 'accessibility')?.renderLimited).toBe(true);
  });

  it('detects renderable artifacts', () => {
    expect(hasRenderableArtifacts(manifestWith(['index.html']))).toBe(true);
    expect(hasRenderableArtifacts(manifestWith(['src/x.ts']))).toBe(false);
  });

  it('detects a runnable entry / build shell (the tester gate)', () => {
    expect(hasRunnableEntry(manifestWith(['index.html']))).toBe(true);
    expect(hasRunnableEntry(manifestWith(['package.json', 'src/app.tsx']))).toBe(true);
    expect(hasRunnableEntry(manifestWith(['vite.config.ts', 'src/app.tsx']))).toBe(true);
    expect(hasRunnableEntry(manifestWith(['src/app.tsx', 'styles.css']))).toBe(false);
  });
});

describe('reviewer prompts', () => {
  it('the system prompt carries the lens base + the measurement framing', () => {
    const sys = buildReviewSystemPrompt({ lens: 'correctness', renderLimited: false });
    expect(sys).toContain('Lens: correctness');
    expect(sys).toContain('MEASUREMENT pass');
    expect(sys).toContain('submit_findings');
    expect(sys).not.toContain('RENDER LIMITATION');
  });

  it('a render-limited lens gets the explicit no-headless-browser note', () => {
    const sys = buildReviewSystemPrompt({ lens: 'visual-critic', renderLimited: true });
    expect(sys).toContain('RENDER LIMITATION');
    expect(sys).toContain('no headless browser');
    expect(sys).toContain('STATIC STRUCTURAL');
  });

  it('the user prompt carries the standard, the manifest, and the verify evidence', () => {
    const user = buildReviewUserPrompt({
      plan: { lens: 'correctness', renderLimited: false },
      task: 'Build a calculator',
      visionBrief: 'A tiny CLI calculator',
      manifest: manifestWith(['src/calc.ts']),
      verifyResult: okVerify,
    });
    expect(user).toContain('Build a calculator');
    expect(user).toContain('A tiny CLI calculator');
    expect(user).toContain('src/calc.ts');
    expect(user).toContain('OBJECTIVE VERIFY');
  });
});

describe('severity normalization + finding parse', () => {
  it('normalizes synonyms', () => {
    expect(normalizeSeverity('critical')).toBe('blocking');
    expect(normalizeSeverity('BLOCKER')).toBe('blocking');
    expect(normalizeSeverity('major')).toBe('high');
    expect(normalizeSeverity('nit')).toBe('low');
    expect(normalizeSeverity('whatever')).toBe('medium');
  });

  it('parses findings off a submit_findings tool call (object args)', () => {
    const findings = parseFindings(
      'correctness',
      [
        {
          name: SUBMIT_FINDINGS_TOOL,
          arguments: {
            findings: [
              {
                severity: 'blocking',
                title: 'build fails',
                evidence: 'tsc: error TS2304',
                location: 'src/a.ts:12',
              },
            ],
          },
        },
      ],
      '',
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      lens: 'correctness',
      severity: 'blocking',
      location: 'src/a.ts:12',
    });
  });

  it('parses submit_findings when arguments arrive as a JSON string', () => {
    const findings = parseFindings(
      'security',
      [
        {
          name: SUBMIT_FINDINGS_TOOL,
          arguments: JSON.stringify({
            findings: [
              { severity: 'high', title: 'secret leak', evidence: 'API_KEY in config.ts' },
            ],
          }),
        },
      ],
      '',
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('high');
  });

  it('an empty submit_findings call is authoritative (measured nothing)', () => {
    const findings = parseFindings(
      'performance',
      [{ name: SUBMIT_FINDINGS_TOOL, arguments: { findings: [] } }],
      'some prose that should be ignored',
    );
    expect(findings).toEqual([]);
  });

  it('falls back to final text as a blocking finding for a correctness failure', () => {
    const findings = parseFindings('correctness', [], 'The build FAILS: SyntaxError at src/x.ts:4');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('blocking');
  });

  it('final-text fallback is a low observation for a non-failure lens', () => {
    const findings = parseFindings('security', [], 'Looks fine, no obvious issues.');
    expect(findings[0]?.severity).toBe('low');
  });
});

describe('isBlocking (spec §8 — a build/test failure or severe defect)', () => {
  const f = (over: Partial<ReviewFinding>): ReviewFinding => ({
    lens: 'correctness',
    severity: 'medium',
    title: 't',
    evidence: 'e',
    ...over,
  });

  it('blocking severity always blocks', () => {
    expect(isBlocking(f({ severity: 'blocking' }))).toBe(true);
  });

  it('a high correctness finding that reads like a failure blocks (lenient)', () => {
    expect(
      isBlocking(
        f({ lens: 'correctness', severity: 'high', title: 'tests fail', evidence: 'crash' }),
      ),
    ).toBe(true);
  });

  it('a high non-correctness finding does not block', () => {
    expect(isBlocking(f({ lens: 'security', severity: 'high' }))).toBe(false);
  });

  it('a plain medium finding does not block', () => {
    expect(isBlocking(f({ severity: 'medium' }))).toBe(false);
  });
});

describe('finding → contract mapping + verify-derived blocking', () => {
  const contracts = [contract('c1', 'src/mathutils.ts'), contract('c2', 'src/index.ts')];

  it('maps a finding to the contract whose slot it cites', () => {
    const findings: ReviewFinding[] = [
      {
        lens: 'correctness',
        severity: 'blocking',
        title: 'x',
        evidence: 'boom',
        location: 'src/index.ts:3',
      },
    ];
    expect(mapFindingsToContractIds(findings, contracts)).toEqual(['c2']);
  });

  it('matches by basename when the location is an absolute path', () => {
    const findings: ReviewFinding[] = [
      {
        lens: 'correctness',
        severity: 'blocking',
        title: 'x',
        evidence: '/tmp/ws/src/mathutils.ts fails',
      },
    ];
    expect(mapFindingsToContractIds(findings, contracts)).toEqual(['c1']);
  });

  it('derives blocking findings from objective verify errors, mapped to the owning slot', () => {
    const verify: VerifyResult = {
      ok: false,
      filesChecked: 2,
      errors: [{ file: '/ws/src/index.ts', message: 'unbalanced bracket' }],
    };
    const derived = deriveBlockingFromVerify(verify, contracts);
    expect(derived).toHaveLength(1);
    expect(derived[0]).toMatchObject({
      lens: 'correctness',
      severity: 'blocking',
      location: 'src/index.ts',
    });
  });
});

describe('buildFindingsSummary (the CEO-facing, transcript-free summary)', () => {
  it('lists findings ranked by severity + a revision note', () => {
    const summary = buildFindingsSummary({
      findings: [
        { lens: 'security', severity: 'low', title: 'minor', evidence: 'e' },
        { lens: 'correctness', severity: 'blocking', title: 'build fails', evidence: 'tsc error' },
      ],
      revisionTriggered: true,
      revisedVerifyOk: true,
    });
    // blocking is listed before low
    expect(summary.indexOf('build fails')).toBeLessThan(summary.indexOf('minor'));
    expect(summary).toContain('bounded revision');
    expect(summary).toContain('verify now passes');
  });

  it('reports the no-findings case', () => {
    const summary = buildFindingsSummary({ findings: [], revisionTriggered: false });
    expect(summary).toContain('no findings');
  });
});

describe('buildReviewAgentInput (spec §8 harnessed reviewer)', () => {
  const input = buildReviewAgentInput(
    { lens: 'correctness', renderLimited: false },
    {
      task: 't',
      visionBrief: '',
      manifest: manifestWith(['src/a.ts']),
      verifyResult: okVerify,
      workspace: '/ws',
      maxTokens: 8192,
    },
  );

  it('is a read-only, thinking-on, thinking-general reviewer with the submit_findings tool', () => {
    expect(input.purpose).toBe('review');
    expect(input.thinking).toBe(true);
    expect(input.samplingMode).toBe('thinking-general');
    expect(input.tools).toContain('bash');
    expect(input.tools).toContain(SUBMIT_FINDINGS_TOOL);
    // read-only intent — no write/edit
    expect(input.tools).not.toContain('write');
    expect(input.tools).not.toContain('edit');
    expect(input.customTools?.[0]?.name).toBe(SUBMIT_FINDINGS_TOOL);
    // NO per-agent caps, NO isolation, NO bump
    expect(input.isolation).toBeUndefined();
    expect(input.bump).toBeUndefined();
    expect(input.maxTokens).toBe(8192);
  });
});

// --- The phase orchestration (mocked seams) ----------------------------------

const CONTRACTS = [contract('c1', 'src/mathutils.ts'), contract('c2', 'src/index.ts', ['c1'])];
const MANIFEST = manifestWith(['src/mathutils.ts', 'src/index.ts']);

function findingsCall(findings: unknown[]): RoleAgentRunOutput {
  return {
    filesWritten: [],
    finalText: '',
    toolCalls: [{ name: SUBMIT_FINDINGS_TOOL, arguments: { findings } }],
    terminatedReason: 'stop',
    // record a bash call so usedBash is true
    turns: 3,
  };
}

describe('runReviewPhase (spec §8, bounded)', () => {
  it('runs one pass per lens, records lens summaries, and surfaces findings to the CEO', async () => {
    const seen: string[] = [];
    const runReviewAgent = async (input: RoleAgentRunInput): Promise<RoleAgentRunOutput> => {
      const lens = /through your (\S+) lens/.exec(input.userPrompt)?.[1] ?? '?';
      seen.push(lens);
      return {
        filesWritten: [],
        finalText: '',
        toolCalls: [
          { name: 'bash', arguments: { command: 'node --check src/index.ts' } },
          { name: SUBMIT_FINDINGS_TOOL, arguments: { findings: [] } },
        ],
        terminatedReason: 'stop',
      };
    };
    const summary = await runReviewPhase({
      lensPlan: selectReviewLenses(MANIFEST),
      task: 'Build a thing',
      visionBrief: '',
      manifest: MANIFEST,
      verifyResult: okVerify,
      contracts: CONTRACTS,
      workspace: '/ws',
      maxTokens: 8192,
      runReviewAgent,
    });
    expect(seen).toEqual(['correctness', 'tester', 'security', 'performance']);
    expect(summary.lensRuns).toHaveLength(4);
    expect(summary.lensRuns.every((r) => r.ran && r.usedBash)).toBe(true);
    expect(summary.blockingCount).toBe(0);
    expect(summary.revisionTriggered).toBe(false);
    // A pure-logic product (no renderable artifact) needs no runnable entry, and the
    // tester measured no failure → the gate PASSES (the CEO may approve).
    expect(summary.testerGatePassed).toBe(true);
    expect(summary.runnableEntryMissing).toBe(false);
    expect(summary.ceoFindingsSummary).toContain('no findings');
  });

  it('a blocking finding triggers a bounded revision; a passing re-verify clears it', async () => {
    let revisionCalls = 0;
    let revisedContractIds: readonly string[] = [];
    const runReviewAgent = async (input: RoleAgentRunInput): Promise<RoleAgentRunOutput> => {
      // Only the correctness lens finds the blocking problem.
      if (input.userPrompt.includes('correctness lens')) {
        return findingsCall([
          {
            severity: 'blocking',
            title: 'src/index.ts fails to build',
            evidence: 'node --check: SyntaxError',
            location: 'src/index.ts:2',
          },
        ]);
      }
      return findingsCall([]);
    };
    const summary = await runReviewPhase({
      lensPlan: selectReviewLenses(MANIFEST),
      task: 'Build a thing',
      visionBrief: '',
      manifest: MANIFEST,
      verifyResult: okVerify,
      contracts: CONTRACTS,
      workspace: '/ws',
      maxTokens: 8192,
      runReviewAgent,
      reviseForFindings: async ({ contractIds }) => {
        revisionCalls += 1;
        revisedContractIds = contractIds;
        // The re-dispatch fixed it — re-verify now passes.
        return { ran: true, verify: okVerify };
      },
    });
    expect(summary.blockingCount).toBeGreaterThanOrEqual(1);
    expect(summary.revisionTriggered).toBe(true);
    expect(revisionCalls).toBe(1);
    expect(revisedContractIds).toEqual(['c2']);
    expect(summary.revisionRan).toBe(true);
    expect(summary.revisedVerifyOk).toBe(true);
    expect(summary.ceoFindingsSummary).toContain('bounded revision');
  });

  it('the revision is BOUNDED — a never-fixed blocking finding stops at maxRevisions', async () => {
    let revisionCalls = 0;
    const failVerify: VerifyResult = {
      ok: false,
      filesChecked: 2,
      errors: [{ file: '/ws/src/index.ts', message: 'unbalanced bracket' }],
    };
    const summary = await runReviewPhase({
      lensPlan: [{ lens: 'correctness', renderLimited: false }],
      task: 't',
      visionBrief: '',
      manifest: MANIFEST,
      verifyResult: failVerify, // objective failure → guaranteed blocking, mapped to c2
      contracts: CONTRACTS,
      workspace: '/ws',
      maxTokens: 8192,
      maxRevisions: 1,
      runReviewAgent: async () => findingsCall([]),
      reviseForFindings: async () => {
        revisionCalls += 1;
        // Never fixes it — the re-verify keeps failing.
        return { ran: true, verify: failVerify };
      },
    });
    // maxRevisions=1 → exactly one re-dispatch cycle, then the honest state stands.
    expect(revisionCalls).toBe(1);
    expect(summary.revisionTriggered).toBe(true);
  });

  it('skips the rest gracefully when the budget is spent mid-pass', async () => {
    // A budget of exactly 1 turn: the first reviewer runs, the second is skipped.
    const budget = newRunBudget({ maxTurns: 1, maxWallClockMs: 60_000 });
    let calls = 0;
    const summary = await runReviewPhase({
      lensPlan: selectReviewLenses(MANIFEST),
      task: 't',
      visionBrief: '',
      manifest: MANIFEST,
      verifyResult: okVerify,
      contracts: CONTRACTS,
      workspace: '/ws',
      maxTokens: 8192,
      budget,
      runReviewAgent: async () => {
        // Emulate the run.ts charge: consume the budget, return undefined when spent.
        if (!budget || budget.turnsUsed >= budget.maxTurns) return undefined;
        budget.turnsUsed += 1;
        calls += 1;
        return findingsCall([]);
      },
    });
    expect(calls).toBe(1);
    expect(summary.skippedForBudget).toBe(true);
    expect(summary.lensRuns.filter((r) => !r.ran).length).toBeGreaterThanOrEqual(1);
  });
});

// --- The tester gate: build/run ground truth + the bidirectional bounce (spec §8) --

/** A tester-lens output that BUILT + RAN (a bash call) and measured no failure. */
function testerBuiltCleanly(): RoleAgentRunOutput {
  return {
    filesWritten: [],
    finalText: '',
    toolCalls: [
      { name: 'bash', arguments: { command: 'vite build && node screenshot.mjs' } },
      { name: SUBMIT_FINDINGS_TOOL, arguments: { findings: [] } },
    ],
    terminatedReason: 'stop',
  };
}

describe('deriveTesterGateBlocking (spec §8 — no runnable entry is BLOCKING)', () => {
  it('flags a renderable product with no runnable entry as a blocking tester finding', () => {
    const findings = deriveTesterGateBlocking(manifestWith(['src/app.tsx', 'styles.css']));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.lens).toBe('tester');
    expect(findings[0]?.severity).toBe('blocking');
    expect(findings[0]?.title.toLowerCase()).toContain('no runnable entry');
  });

  it('does not flag a renderable product that HAS a runnable entry', () => {
    expect(deriveTesterGateBlocking(manifestWith(['index.html', 'src/app.tsx']))).toEqual([]);
  });

  it('does not flag a pure-logic product (no renderable artifact needs no web entry)', () => {
    expect(deriveTesterGateBlocking(manifestWith(['src/lib.ts']))).toEqual([]);
  });
});

describe('runReviewPhase — the tester gate (build / run / screenshot)', () => {
  it('a renderable product with NO runnable entry FAILS the tester gate (BLOCKING)', async () => {
    const manifest = manifestWith(['src/app.tsx', 'styles.css']);
    const contracts = [contract('c1', 'src/app.tsx'), contract('c2', 'styles.css')];
    const summary = await runReviewPhase({
      lensPlan: selectReviewLenses(manifest),
      task: 'Build a UI',
      visionBrief: '',
      manifest,
      verifyResult: okVerify, // structural verify passes — but there is no home to run in
      contracts,
      workspace: '/ws',
      maxTokens: 8192,
      runReviewAgent: async () => findingsCall([]),
    });
    // The model-free tester gate blocks it regardless of what the lens agents reported.
    expect(summary.runnableEntryMissing).toBe(true);
    expect(summary.testerGatePassed).toBe(false);
    expect(summary.blockingCount).toBeGreaterThanOrEqual(1);
    const testerBlock = summary.findings.find(
      (f) => f.lens === 'tester' && f.severity === 'blocking',
    );
    expect(testerBlock?.title.toLowerCase()).toContain('no runnable entry');
  });

  it("lets visual/accessibility consume the tester's screenshot when the tester built + ran", async () => {
    const manifest = manifestWith(['index.html', 'src/app.tsx', 'styles.css']);
    const contracts = [contract('c1', 'index.html'), contract('c2', 'src/app.tsx')];
    const summary = await runReviewPhase({
      lensPlan: selectReviewLenses(manifest),
      task: 't',
      visionBrief: '',
      manifest,
      verifyResult: okVerify,
      contracts,
      workspace: '/ws',
      maxTokens: 8192,
      runReviewAgent: async () => testerBuiltCleanly(),
    });
    const visual = summary.lensRuns.find((r) => r.lens === 'visual-critic');
    const a11y = summary.lensRuns.find((r) => r.lens === 'accessibility');
    // Tester produced a real screenshot → the render lenses MEASURE it (not render-limited).
    expect(visual?.renderLimited).toBe(false);
    expect(visual?.measured).toBe(true);
    expect(a11y?.renderLimited).toBe(false);
    expect(summary.testerGatePassed).toBe(true);
    expect(summary.runnableEntryMissing).toBe(false);
  });

  it('falls the render lenses back to render-limited when the tester could not build', async () => {
    const manifest = manifestWith(['index.html', 'src/app.tsx']);
    const contracts = [contract('c1', 'index.html'), contract('c2', 'src/app.tsx')];
    const runReviewAgent = async (input: RoleAgentRunInput): Promise<RoleAgentRunOutput> => {
      if (input.userPrompt.includes('tester lens')) {
        // The tester ran the build (bash) but it FAILED → no screenshot produced.
        return {
          filesWritten: [],
          finalText: '',
          toolCalls: [
            { name: 'bash', arguments: { command: 'vite build' } },
            {
              name: SUBMIT_FINDINGS_TOOL,
              arguments: {
                findings: [
                  {
                    severity: 'blocking',
                    title: 'src/app.tsx build failed',
                    evidence: 'vite: error',
                    location: 'src/app.tsx',
                  },
                ],
              },
            },
          ],
          terminatedReason: 'stop',
        };
      }
      return findingsCall([]);
    };
    const summary = await runReviewPhase({
      lensPlan: selectReviewLenses(manifest),
      task: 't',
      visionBrief: '',
      manifest,
      verifyResult: okVerify,
      contracts,
      workspace: '/ws',
      maxTokens: 8192,
      maxRevisions: 1,
      runReviewAgent,
      reviseForFindings: async () => ({
        ran: true,
        verify: {
          ok: false,
          filesChecked: 2,
          errors: [{ file: '/ws/src/app.tsx', message: 'err' }],
        },
      }),
    });
    const visual = summary.lensRuns.find((r) => r.lens === 'visual-critic');
    expect(visual?.renderLimited).toBe(true); // no build → static structural review
    expect(summary.testerGatePassed).toBe(false);
  });

  it('bounces MULTIPLE rounds and terminates at the bound against a stays-blocking product', async () => {
    let revisionCalls = 0;
    const failVerify: VerifyResult = {
      ok: false,
      filesChecked: 2,
      errors: [{ file: '/ws/src/index.ts', message: 'unbalanced bracket' }],
    };
    const summary = await runReviewPhase({
      lensPlan: [{ lens: 'tester', renderLimited: false }],
      task: 't',
      visionBrief: '',
      manifest: MANIFEST,
      verifyResult: failVerify, // objective failure → guaranteed blocking, mapped to c2
      contracts: CONTRACTS,
      workspace: '/ws',
      maxTokens: 8192,
      maxRevisions: 3, // the generalized bounce bound
      runReviewAgent: async () => findingsCall([]),
      reviseForFindings: async () => {
        revisionCalls += 1;
        return { ran: true, verify: failVerify }; // never fixes it
      },
    });
    // Exactly 3 DOWN-and-UP rounds, then the honest state stands — bounded, no deadlock.
    expect(summary.revisionTriggered).toBe(true);
    expect(revisionCalls).toBe(3);
    expect(summary.revisionRounds).toBe(3);
    expect(summary.testerGatePassed).toBe(false); // never built/ran → gate stays failed
  });

  it('dispatches the AUDITOR when a blocking finding maps to no contract (source unknown)', async () => {
    let revisedIds: readonly string[] = [];
    const runReviewAgent = async (input: RoleAgentRunInput): Promise<RoleAgentRunOutput> => {
      if (input.userPrompt.includes('correctness lens')) {
        // A blocking SYMPTOM whose source is unknown (cites no contract slot).
        return findingsCall([
          {
            severity: 'blocking',
            title: 'the app crashes on load',
            evidence: 'a type appears to be defined twice somewhere',
            location: 'unknown',
          },
        ]);
      }
      if (input.userPrompt.includes('auditor lens')) {
        // The whole-codebase auditor traces it to a concrete file → its contract.
        return findingsCall([
          {
            severity: 'blocking',
            title: 'GameState defined twice with different shapes',
            evidence: 'two modules define GameState — reconcile them',
            location: 'src/index.ts:1',
          },
        ]);
      }
      return findingsCall([]);
    };
    const summary = await runReviewPhase({
      lensPlan: selectReviewLenses(MANIFEST),
      task: 't',
      visionBrief: '',
      manifest: MANIFEST,
      verifyResult: okVerify,
      contracts: CONTRACTS,
      workspace: '/ws',
      maxTokens: 8192,
      runReviewAgent,
      reviseForFindings: async ({ contractIds }) => {
        revisedIds = contractIds;
        return { ran: true, verify: okVerify };
      },
    });
    expect(summary.auditorDispatched).toBe(true);
    expect(summary.lensRuns.some((r) => r.lens === 'auditor')).toBe(true);
    // The auditor's cited file → its contract is what gets re-dispatched.
    expect(revisedIds).toContain('c2');
    expect(summary.revisionTriggered).toBe(true);
  });
});

/** A failing preflight: the entry exists but a broken import means it does not load. */
const failPreflight: PreflightResult = {
  ok: false,
  applicable: true,
  entry: 'index.html',
  filesChecked: 2,
  defects: [
    {
      kind: 'missing-module',
      importer: 'index.html',
      specifier: './src/engine/state.ts',
      message: "imports './src/engine/state.ts' but no such file exists in the product",
    },
  ],
};

describe('derivePreflightBlocking — the "does the entry load?" ground truth', () => {
  it('raises ONE blocking tester finding when preflight failed', () => {
    const found = derivePreflightBlocking(failPreflight);
    expect(found).toHaveLength(1);
    expect(found[0]?.lens).toBe('tester');
    expect(found[0]?.severity).toBe('blocking');
    expect(found[0]?.evidence).toContain('DOES NOT LOAD');
  });

  it('is empty when the entry loads, the check is inapplicable, or there is none', () => {
    expect(derivePreflightBlocking(okPreflight)).toEqual([]);
    expect(
      derivePreflightBlocking({
        ok: true,
        applicable: true,
        entry: 'index.html',
        filesChecked: 1,
        defects: [],
      }),
    ).toEqual([]);
    expect(derivePreflightBlocking(undefined)).toEqual([]);
  });
});

describe('runReviewPhase — the "entry exists but does not load" gate (preflight, Part C)', () => {
  it('routes a non-loading entry through Part C; a rebuild that LOADS clears the gate', async () => {
    // The manifest already HAS an index.html (runnableEntryMissing is false), but its
    // imports are broken so it does not load. This is the exact overnight false sign-off.
    const manifest = manifestWith(['index.html', 'src/app.tsx']);
    const contracts = [contract('c1', 'index.html'), contract('c2', 'src/app.tsx')];
    let dispatchNotes = '';
    const summary = await runReviewPhase({
      lensPlan: selectReviewLenses(manifest),
      task: 'Build a game',
      visionBrief: '',
      manifest,
      verifyResult: okVerify,
      preflightResult: failPreflight,
      contracts,
      workspace: '/ws',
      maxTokens: 8192,
      runReviewAgent: async () => findingsCall([]),
      // The integration engineer rebuilt the entry self-contained → it loads now.
      dispatchIntegrationContract: async ({ notes }) => {
        dispatchNotes = notes;
        return { ran: true, manifest, verify: okVerify, preflight: okPreflight };
      },
    });
    expect(dispatchNotes).toContain('DOES NOT LOAD');
    expect(summary.integrationEntryDispatched).toBe(true);
    expect(summary.integrationEntryRecovered).toBe(true);
    expect(summary.productDoesNotRun).toBe(false);
    expect(summary.testerGatePassed).toBe(true);
  });

  it('stays a hard gate failure when the rebuilt entry STILL does not load', async () => {
    const manifest = manifestWith(['index.html', 'src/app.tsx']);
    const contracts = [contract('c1', 'index.html'), contract('c2', 'src/app.tsx')];
    const summary = await runReviewPhase({
      lensPlan: selectReviewLenses(manifest),
      task: 'Build a game',
      visionBrief: '',
      manifest,
      verifyResult: okVerify,
      preflightResult: failPreflight,
      contracts,
      workspace: '/ws',
      maxTokens: 8192,
      runReviewAgent: async () => findingsCall([]),
      dispatchIntegrationContract: async () => ({
        ran: true,
        manifest,
        verify: okVerify,
        preflight: failPreflight, // still broken
      }),
    });
    expect(summary.integrationEntryDispatched).toBe(true);
    expect(summary.productDoesNotRun).toBe(true);
    expect(summary.testerGatePassed).toBe(false);
  });

  it('without a recovery seam, a non-loading entry stays a hard gate failure', async () => {
    const manifest = manifestWith(['index.html', 'src/app.tsx']);
    const contracts = [contract('c1', 'index.html'), contract('c2', 'src/app.tsx')];
    const summary = await runReviewPhase({
      lensPlan: selectReviewLenses(manifest),
      task: 'Build a game',
      visionBrief: '',
      manifest,
      verifyResult: okVerify,
      preflightResult: failPreflight,
      contracts,
      workspace: '/ws',
      maxTokens: 8192,
      runReviewAgent: async () => findingsCall([]),
    });
    expect(summary.productDoesNotRun).toBe(true);
    expect(summary.testerGatePassed).toBe(false);
    expect(summary.findings.some((f) => f.lens === 'tester' && f.severity === 'blocking')).toBe(
      true,
    );
  });
});

describe('runReviewPhase — the integration-entry recovery (Part C, spec §5/§8)', () => {
  it('synthesizes + dispatches an integration contract when the entry is missing, and the gate clears on re-verify', async () => {
    // A renderable product with NO runnable entry — the "food with no home". With the
    // recovery seam wired, the review bounce PRODUCES the entry and re-assembles; the
    // fresh manifest now HAS one, so the tester gate clears (before this fix it flagged
    // forever, since the missing entry mapped to no existing contract).
    const manifest = manifestWith(['src/app.tsx', 'styles.css']);
    const contracts = [contract('c1', 'src/app.tsx'), contract('c2', 'styles.css')];
    let dispatchCalls = 0;
    let dispatchNotes = '';
    const summary = await runReviewPhase({
      lensPlan: selectReviewLenses(manifest),
      task: 'Build a UI',
      visionBrief: '',
      manifest,
      verifyResult: okVerify,
      contracts,
      workspace: '/ws',
      maxTokens: 8192,
      runReviewAgent: async () => findingsCall([]),
      dispatchIntegrationContract: async ({ notes }) => {
        dispatchCalls += 1;
        dispatchNotes = notes;
        // The integration engineer produced the entry → the re-assembled manifest HAS one.
        return {
          ran: true,
          manifest: manifestWith(['src/app.tsx', 'styles.css', 'index.html']),
          verify: okVerify,
          preflight: okPreflight,
        };
      },
    });
    expect(dispatchCalls).toBe(1);
    expect(dispatchNotes.toLowerCase()).toContain('runnable entry');
    expect(summary.integrationEntryDispatched).toBe(true);
    expect(summary.integrationEntryRecovered).toBe(true);
    // Recomputed against the re-assembled manifest: the "no home" blocker is gone.
    expect(summary.runnableEntryMissing).toBe(false);
    expect(summary.testerGatePassed).toBe(true);
    expect(summary.findings.some((f) => f.lens === 'tester' && f.severity === 'blocking')).toBe(
      false,
    );
  });

  it('stays a gate failure when the recovery dispatch could not produce the entry', async () => {
    const manifest = manifestWith(['src/app.tsx', 'styles.css']);
    const contracts = [contract('c1', 'src/app.tsx'), contract('c2', 'styles.css')];
    const summary = await runReviewPhase({
      lensPlan: selectReviewLenses(manifest),
      task: 'Build a UI',
      visionBrief: '',
      manifest,
      verifyResult: okVerify,
      contracts,
      workspace: '/ws',
      maxTokens: 8192,
      runReviewAgent: async () => findingsCall([]),
      // The dispatch ran but the entry still isn't present (the engineer did not produce it).
      dispatchIntegrationContract: async () => ({
        ran: true,
        manifest: manifestWith(['src/app.tsx', 'styles.css']),
        verify: okVerify,
        preflight: okPreflight,
      }),
    });
    expect(summary.integrationEntryDispatched).toBe(true);
    expect(summary.integrationEntryRecovered).toBe(false);
    expect(summary.runnableEntryMissing).toBe(true);
    expect(summary.testerGatePassed).toBe(false);
  });

  it('without a recovery seam, a missing entry stays a hard gate failure (the pre-fix behavior)', async () => {
    const manifest = manifestWith(['src/app.tsx', 'styles.css']);
    const contracts = [contract('c1', 'src/app.tsx'), contract('c2', 'styles.css')];
    const summary = await runReviewPhase({
      lensPlan: selectReviewLenses(manifest),
      task: 'Build a UI',
      visionBrief: '',
      manifest,
      verifyResult: okVerify,
      contracts,
      workspace: '/ws',
      maxTokens: 8192,
      runReviewAgent: async () => findingsCall([]),
      // No dispatchIntegrationContract seam.
    });
    expect(summary.integrationEntryDispatched).toBe(false);
    expect(summary.runnableEntryMissing).toBe(true);
    expect(summary.testerGatePassed).toBe(false);
  });
});

describe('reviewer prompts — the tester + auditor framing (spec §8)', () => {
  it('the tester system prompt demands BUILD + RUN + SCREENSHOT and blocks on no runnable entry', () => {
    const sys = buildReviewSystemPrompt({ lens: 'tester', renderLimited: false });
    expect(sys).toContain('BUILD');
    expect(sys).toContain('RUN');
    expect(sys).toContain('SCREENSHOT');
    expect(sys.toLowerCase()).toContain('missing runnable entry');
  });

  it('a non-render-limited visual lens is told to consume the tester screenshot', () => {
    const sys = buildReviewSystemPrompt({ lens: 'visual-critic', renderLimited: false });
    expect(sys).toContain('tester already BUILT and RAN');
    expect(sys).not.toContain('RENDER LIMITATION');
  });

  it('the auditor system prompt frames whole-tree root-cause tracing', () => {
    const sys = buildReviewSystemPrompt({ lens: 'auditor', renderLimited: false });
    expect(sys).toContain('ENTIRE product tree');
    expect(sys).toContain('ROOT CAUSE');
  });
});
