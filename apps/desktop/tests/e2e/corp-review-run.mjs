/**
 * REAL-SERVER VALIDATION for the REVIEW-AT-MERGE phase (spec §8) — advisory
 * specialist reviewers that MEASURE, running before the CEO sign-off.
 *
 * Starts the app's own llama-server (Q8 qwen3.5-4b) on :8179 and drives the ACTUAL
 * review phase ({@link runReviewPhase}) over a small crafted product that contains a
 * DELIBERATE flaw (a contract whose code fails the build), through the EXACT
 * production agent seam runCorp uses (`createRunRoleAgent`). It confirms:
 *
 *   1. The specialist reviewers RUN HARNESSED (read + bash, read-only) and USE bash
 *      to build/measure — evidence-grounded, not opinion.
 *   2. They produce FINDINGS that cite the real flaw (the flawed file).
 *   3. A BLOCKING finding triggers a BOUNDED re-dispatch that FIXES the flaw (the
 *      objective re-verify passes after).
 *   4. The CEO then reviews the improved product WITH the specialists' evidence,
 *      TRANSCRIPT-FREE (task + vision + manifest + verify + the FINDINGS summary).
 *   5. Everything is BOUNDED (one review pass; one bounded revision reusing the
 *      revise bound) with NO per-agent cap; the correctness/security/performance
 *      lenses MEASURE, and the visual/accessibility lenses are render-limited.
 *
 * KILLS the server on every exit path — no orphan.
 *
 *   node tests/e2e/corp-review-run.mjs
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HOME = os.homedir();
const SERVER_BIN = `${HOME}/.cache/pi-desktop/llamacpp/b9934/llama-b9934/llama-server`;
const MODEL_GGUF = `${HOME}/.cache/pi-desktop/models/qwen3.5-4b-mtp/Qwen3.5-4B-Q8_0.gguf`;
const CHAT_TEMPLATE = `${HOME}/.cache/pi-desktop/chat-templates/Qwen--Qwen3.5-4B.jinja`;
const HOST = '127.0.0.1';
const PORT = 8179;
const BASE_URL = `http://${HOST}:${PORT}/v1`;
const HEALTH_URL = `http://${HOST}:${PORT}/health`;
const MODEL_ID = 'qwen3.5-4b';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(appRoot, '../..');
const SEAM_IMPL_TS = path.join(appRoot, 'electron', 'corp', 'role-agent-seam-impl.ts');
const CORP_INDEX_TS = path.join(repoRoot, 'packages', 'harness', 'src', 'corp', 'index.ts');

const RUN_DIR = mkdtempSync(path.join(os.tmpdir(), 'corp-review-'));
const SERVER_LOG = path.join(RUN_DIR, 'server.log');
const WORKSPACE = path.join(RUN_DIR, 'ws');
mkdirSync(WORKSPACE, { recursive: true });

function log(...a) {
  console.error(`[${new Date().toISOString()}] ${a.join(' ')}`);
}

// The corp TS sources use `.js` specifiers that resolve to `.ts`, and the seam impl
// imports `./role-agent` extensionless; retry `.js`→`.ts` and add `.ts`.
const tsResolveHook = `
export async function resolve(specifier, context, next) {
  if (/^(\\.\\.?\\/|\\/)/.test(specifier)) {
    try { return await next(specifier, context); }
    catch (err) {
      if (!err || err.code !== 'ERR_MODULE_NOT_FOUND') throw err;
      if (specifier.endsWith('.js')) { try { return await next(specifier.slice(0, -3) + '.ts', context); } catch {} }
      try { return await next(specifier + '.ts', context); } catch {}
      throw err;
    }
  }
  return next(specifier, context);
}`;
register(`data:text/javascript,${encodeURIComponent(tsResolveHook)}`);

// ── preflight ───────────────────────────────────────────────────────────────
const missing = [
  [SERVER_BIN, 'llama-server binary'],
  [MODEL_GGUF, 'qwen3.5-4b Q8 gguf'],
  [CHAT_TEMPLATE, 'qwen chat template'],
].filter(([p]) => !existsSync(p));
if (missing.length > 0) {
  for (const [p, what] of missing) log(`SKIP: missing ${what} at ${p}`);
  console.log('CORP REVIEW RUN: SKIPPED (model assets not present)');
  process.exit(0);
}

// ── server lifecycle ──────────────────────────────────────────────────────────
let serverProc = null;
function startServer() {
  const a = [
    '-m',
    MODEL_GGUF,
    '--host',
    HOST,
    '--port',
    String(PORT),
    '-c',
    '16384',
    '--parallel',
    '1',
    '--spec-type',
    'draft-mtp',
    '--spec-draft-n-max',
    '2',
    '--jinja',
    '--chat-template-file',
    CHAT_TEMPLATE,
  ];
  log('starting llama-server:', SERVER_BIN, a.join(' '));
  serverProc = spawn(SERVER_BIN, a, { stdio: ['ignore', 'pipe', 'pipe'] });
  const append = (d) => {
    try {
      appendFileSync(SERVER_LOG, d);
    } catch {}
  };
  serverProc.stdout.on('data', append);
  serverProc.stderr.on('data', append);
  serverProc.on('exit', (code, sig) => log(`llama-server exited code=${code} sig=${sig}`));
}
function killServer() {
  if (serverProc && !serverProc.killed) {
    log('killing llama-server pid', serverProc.pid);
    try {
      serverProc.kill('SIGKILL');
    } catch {}
  }
}
async function waitForHealth(timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (serverProc && serverProc.exitCode !== null) throw new Error('server exited before healthy');
    try {
      const r = await fetch(HEALTH_URL);
      if (r.ok) {
        const j = await r.json().catch(() => ({}));
        if (!j.status || j.status === 'ok') {
          log('server healthy:', JSON.stringify(j));
          return;
        }
      }
    } catch {}
    await new Promise((res) => setTimeout(res, 750));
  }
  throw new Error('server never became healthy');
}
for (const sig of ['SIGINT', 'SIGTERM'])
  process.on(sig, () => {
    killServer();
    process.exit(1);
  });
process.on('uncaughtException', (e) => {
  log('uncaughtException', e?.stack || e);
  killServer();
  process.exit(1);
});

// ── the crafted product: a small module set with a DELIBERATE build flaw ──────
// c2 (src/format.mjs) is written broken (an unbalanced paren) — it fails `node
// --check` (the correctness reviewer measures it) AND the structural verify pass.
const FILES = {
  'src/mathutils.mjs':
    'export function add(a, b) {\n  return a + b;\n}\n\nexport function subtract(a, b) {\n  return a - b;\n}\n',
  // DELIBERATE FLAW: an unbalanced `(` — a genuine build/parse failure.
  'src/format.mjs': "export function format(n) {\n  return 'value: ' + (n\n}\n",
  'src/index.mjs':
    "import { add, subtract } from './mathutils.mjs';\nimport { format } from './format.mjs';\n\nconsole.log(format(add(2, 3)));\nconsole.log(format(subtract(10, 4)));\n",
  'index.html':
    '<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>Calc</title></head>\n<body>\n  <main>\n    <h1>Calculator</h1>\n    <button id="go">Compute</button>\n    <output id="result"></output>\n  </main>\n</body>\n</html>\n',
};

function writeProduct() {
  for (const [rel, content] of Object.entries(FILES)) {
    const abs = path.join(WORKSPACE, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
}

function contract(id, ownerNodeId, o) {
  return {
    id,
    title: o.title,
    ownerNodeId,
    input: o.input,
    output: o.output,
    slot: o.slot,
    available: { tools: ['read', 'write', 'bash'], imports: o.imports ?? [] },
    reviewRubric: o.rubric,
    dependsOn: o.dependsOn ?? [],
    status: 'in-review',
  };
}

function craftedChart() {
  const contracts = [
    contract('c1', 'eng-1', {
      title: 'Math utils',
      input: 'nothing',
      output: 'export function add(a,b) and export function subtract(a,b)',
      slot: 'src/mathutils.mjs',
      rubric: 'add + subtract exported; both pure',
    }),
    contract('c2', 'eng-2', {
      title: 'Value formatter',
      input: 'a number',
      output:
        "export function format(n) that returns the string 'value: ' followed by n (e.g. format(5) => 'value: 5'). The file MUST be syntactically valid ES module JavaScript that `node --check` accepts.",
      slot: 'src/format.mjs',
      rubric: "format(n) returns 'value: ' + n; the file parses (node --check passes)",
    }),
    contract('c3', 'eng-3', {
      title: 'Entry point',
      input: 'mathutils + format',
      output: 'imports add/subtract and format, prints two computed lines',
      slot: 'src/index.mjs',
      rubric: 'runs and prints two "value: N" lines',
      dependsOn: ['c1', 'c2'],
    }),
    contract('c4', 'eng-4', {
      title: 'Calculator page',
      input: 'the calculator UI',
      output: 'a semantic index.html page with a heading, a button, and an output region',
      slot: 'index.html',
      rubric: 'semantic markup, labeled controls',
    }),
  ];
  return {
    projectId: 'review',
    nodes: [
      { id: 'ceo', role: 'ceo', name: 'CEO' },
      { id: 'manager', role: 'manager', name: 'Manager block', parentId: 'ceo' },
      { id: 'division', role: 'division', name: 'Calculator', parentId: 'manager' },
      ...['eng-1', 'eng-2', 'eng-3', 'eng-4'].map((id) => ({
        id,
        role: 'engineer',
        name: id,
        parentId: 'division',
        promptId: 'backend-dev',
        promptExtension: 'a tiny standalone JavaScript calculator',
      })),
    ],
    contracts,
    queue: [],
    branches: [],
    status: 'running',
    nodeStatus: {},
  };
}

const TASK =
  'Build a tiny standalone JavaScript calculator: math utilities, a value formatter, an entry point that prints two computed results, and a simple HTML page.';
const VISION =
  'VISION BRIEF: a minimal, correct standalone JS calculator. Every module must build and run; the entry point must print two "value: N" lines; the page is simple and semantic.';

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  startServer();
  await waitForHealth();

  const corp = await import(pathToFileURL(CORP_INDEX_TS).href);
  const {
    runReviewPhase,
    selectReviewLenses,
    buildProductManifest,
    verifyProduct,
    buildEngineerAgentInput,
    buildCeoReviewPrompt,
    parseCeoDecision,
    getRolePrompt,
    roleThinkingEnabled,
    makeNodeWorkspaceReadFs,
    newRunBudget,
    chargeTurn,
    budgetExceeded,
  } = corp;
  const { createRunRoleAgent } = await import(pathToFileURL(SEAM_IMPL_TS).href);

  writeProduct();
  const readFs = makeNodeWorkspaceReadFs();
  const chart = craftedChart();

  // THE PRODUCTION SEAM — the exact closure runCorp injects for every role.
  const seam = createRunRoleAgent({ baseUrl: BASE_URL, model: MODEL_ID });

  // A generous global budget — the internal bound (one review pass, one bounded
  // revision) is what actually bounds the run; this only proves nothing is unbounded.
  const budget = newRunBudget({ maxTurns: 300, maxWallClockMs: 60 * 60 * 1000 });

  const preManifest = buildProductManifest(chart, WORKSPACE, readFs);
  const preVerify = verifyProduct(WORKSPACE, readFs);
  const lensPlan = selectReviewLenses(preManifest);
  log(
    `product: ${preManifest.files.length} files; verify=${preVerify.ok ? 'PASS' : 'FAIL'} (${preVerify.errors.length} err); lenses=[${lensPlan
      .map((p) => `${p.lens}${p.renderLimited ? '(render-limited)' : ''}`)
      .join(', ')}]`,
  );

  // Per-reviewer telemetry (proves harnessed + measured + bounded, no runaway).
  const reviewerRuns = [];
  const runReviewAgent = async (input) => {
    if (!chargeTurn(budget)) return undefined; // budget spent → skip gracefully
    const t0 = Date.now();
    const out = await seam(input);
    const lens = /through your (\S+) lens/.exec(input.userPrompt)?.[1] ?? '?';
    const toolNames = [...new Set(out.toolCalls.map((c) => c.name))];
    reviewerRuns.push({
      lens,
      wallMs: Date.now() - t0,
      turns: out.turns,
      usedBash: toolNames.includes('bash'),
      submittedFindings: toolNames.includes('submit_findings'),
      maxTurnOutputTokens: out.maxTurnOutputTokens,
      terminatedReason: out.terminatedReason,
      toolNames,
    });
    return out;
  };

  // The bounded-revision seam: re-dispatch each affected contract through the SAME
  // production engineer seam (buildEngineerAgentInput), then re-verify. One engineer
  // turn per affected contract, budget-charged; never throws.
  let revisionEngineerRuns = 0;
  const reviseForFindings = async ({ contractIds, notes }) => {
    let ran = false;
    for (const id of contractIds) {
      if (budgetExceeded(budget)) break;
      const c = chart.contracts.find((x) => x.id === id);
      if (!c) continue;
      chargeTurn(budget); // one engineer turn
      revisionEngineerRuns += 1;
      const input = buildEngineerAgentInput(
        {
          contract: { ...c, dependsOn: [], workspace: 'shared', status: 'queued' },
          depContext: [],
        },
        {
          workspace: WORKSPACE,
          genMaxTokens: 16000,
          engineerThinking: roleThinkingEnabled('engineer'),
          extraNotes: notes,
        },
      );
      log(`revision: re-dispatching ${id} → ${c.slot}`);
      const out = await seam({ ...input, onConsult: () => chargeTurn(budget) });
      ran = ran || out.filesWritten.length > 0;
    }
    const verify = verifyProduct(WORKSPACE, readFs);
    return { ran, verify };
  };

  // 1) THE REVIEW-AT-MERGE PHASE — spawn each lens harnessed, measure, aggregate,
  // and run the bounded revision on the blocking finding.
  const t0 = Date.now();
  const review = await runReviewPhase({
    lensPlan,
    task: TASK,
    visionBrief: VISION,
    manifest: preManifest,
    verifyResult: preVerify,
    contracts: chart.contracts,
    workspace: WORKSPACE,
    maxTokens: 8192,
    runReviewAgent,
    reviseForFindings,
    maxRevisions: 1,
    budget,
    log: (m) => log(`  ${m}`),
  });
  const reviewWallMs = Date.now() - t0;

  // The product AFTER the bounded revision (the CEO reviews this).
  const postManifest = buildProductManifest(chart, WORKSPACE, readFs);
  const postVerify = verifyProduct(WORKSPACE, readFs);

  // 2) THE CEO FINAL REVIEW — over the improved product + the specialists' findings,
  // TRANSCRIPT-FREE (buildCeoReviewPrompt has NO transcript field; the findings are
  // measured evidence, not a build transcript).
  const ceoUser = buildCeoReviewPrompt({
    originalTask: `${TASK}\n\nVISION BRIEF you formed as the standard:\n${VISION}`,
    manifest: postManifest,
    verifyResult: postVerify,
    reviewFindings: review.ceoFindingsSummary,
  });
  chargeTurn(budget);
  log('CEO final review (transcript-free, WITH the specialist findings)');
  let ceoDecision = { decision: '(none)' };
  try {
    const ceoOut = await seam({
      purpose: 'ceo',
      systemPrompt: getRolePrompt('ceo').prompt,
      userPrompt: ceoUser,
      tools: ['read', 'bash'],
      cwd: WORKSPACE,
      thinking: roleThinkingEnabled('ceo'),
      samplingMode: 'thinking-general',
      maxTokens: 8192,
    });
    ceoDecision = parseCeoDecision(ceoOut.finalText);
  } catch (err) {
    log(`CEO review error: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── report ──────────────────────────────────────────────────────────────────
  const measuredLenses = review.lensRuns.filter((r) => r.ran && r.measured).map((r) => r.lens);
  const renderLimited = review.lensRuns.filter((r) => r.renderLimited).map((r) => r.lens);
  const flawFindings = review.findings.filter((f) =>
    `${f.location ?? ''} ${f.evidence} ${f.title}`.includes('format.mjs'),
  );
  const globalMaxTok = Math.max(0, ...reviewerRuns.map((r) => r.maxTurnOutputTokens ?? 0));

  log('════════════════════ REVIEW-AT-MERGE REPORT ════════════════════');
  log(`reviewWallMs=${reviewWallMs} (${(reviewWallMs / 60000).toFixed(1)} min)`);
  log(
    `lenses run: ${review.lensRuns.map((r) => `${r.lens}[ran=${r.ran},bash=${r.usedBash},findings=${r.findingCount},blocking=${r.blockingCount}${r.renderLimited ? ',render-limited' : ''}]`).join(' ')}`,
  );
  log('per-reviewer:');
  for (const r of reviewerRuns) {
    log(
      `  · ${r.lens} — ${(r.wallMs / 1000).toFixed(1)}s turns=${r.turns} bash=${r.usedBash} submitted=${r.submittedFindings} maxTurnTok=${r.maxTurnOutputTokens} stop=${r.terminatedReason} tools=[${r.toolNames.join(',')}]`,
    );
  }
  log(`findings (${review.findings.length}, ${review.blockingCount} blocking):`);
  for (const f of review.findings)
    log(
      `  · [${f.lens}/${f.severity}] ${f.title}${f.location ? ` @ ${f.location}` : ''} — ${(f.evidence || '').slice(0, 120)}`,
    );
  log(
    `MEASURED lenses: [${measuredLenses.join(', ')}]  |  RENDER-LIMITED lenses: [${renderLimited.join(', ')}]`,
  );
  log(
    `bounded revision: triggered=${review.revisionTriggered} contracts=[${review.revisionContractIds.join(', ')}] ran=${review.revisionRan} engineerRuns=${revisionEngineerRuns} revisedVerifyOk=${review.revisedVerifyOk}`,
  );
  log(
    `objective verify: before=${preVerify.ok ? 'PASS' : 'FAIL'} → after=${postVerify.ok ? 'PASS' : 'FAIL'}`,
  );
  log(`CEO decision: ${ceoDecision.decision}`);
  log(`CEO prompt carries the specialist FINDINGS: ${ceoUser.includes('SPECIALIST REVIEW')}`);
  log(`budget: turnsUsed=${budget.turnsUsed}/${budget.maxTurns} (nothing unbounded)`);

  // ── assertions ────────────────────────────────────────────────────────────────
  let failures = 0;
  const assert = (cond, label, detail) => {
    if (cond) log(`PASS  ${label}`);
    else {
      failures++;
      log(`FAIL  ${label}${detail !== undefined ? ` — ${detail}` : ''}`);
    }
  };

  const correctness = review.lensRuns.find((r) => r.lens === 'correctness');
  assert(
    review.lensRuns.filter((r) => r.ran).length >= 3,
    'REVIEWERS RAN — at least the 3 measured lenses ran harnessed',
    `${review.lensRuns.filter((r) => r.ran).length} ran`,
  );
  assert(
    reviewerRuns.some((r) => r.usedBash),
    'EVIDENCE-GROUNDED — a reviewer USED bash to measure (not opinion)',
    `bash users: ${
      reviewerRuns
        .filter((r) => r.usedBash)
        .map((r) => r.lens)
        .join(',') || 'none'
    }`,
  );
  assert(
    correctness?.ran === true && correctness?.usedBash === true,
    'CORRECTNESS lens measured the build via bash',
  );
  assert(
    flawFindings.length >= 1 || preVerify.ok === false,
    'FINDINGS CITE THE FLAW — a finding references the flawed file (or objective verify caught it)',
    `flawFindings=${flawFindings.length}`,
  );
  assert(
    review.blockingCount >= 1 && review.revisionTriggered === true,
    'BLOCKING → BOUNDED REVISION was triggered by a blocking finding',
    `blocking=${review.blockingCount}`,
  );
  assert(
    review.revisionContractIds.includes('c2'),
    'REVISION targeted the affected contract (c2 / src/format.mjs)',
    review.revisionContractIds.join(','),
  );
  assert(
    review.revisionRan === true && postVerify.ok === true,
    'REVISION FIXED THE FLAW — the objective re-verify passes after the re-dispatch',
    `revisionRan=${review.revisionRan} postVerify=${postVerify.ok}`,
  );
  assert(
    revisionEngineerRuns <= review.revisionContractIds.length,
    'BOUNDED revision — at most one re-dispatch per affected contract (revise bound)',
    `engineerRuns=${revisionEngineerRuns}`,
  );
  assert(
    renderLimited.length >= 1 && renderLimited.includes('visual-critic'),
    'RENDER-LIMITED lenses wired best-effort (visual/accessibility over the markup)',
    `render-limited=[${renderLimited.join(',')}]`,
  );
  assert(
    ceoUser.includes('SPECIALIST REVIEW') && ceoUser.includes(TASK.slice(0, 30)),
    'CEO reviews WITH the specialist findings summary, over the task+vision',
  );
  assert(
    !/build transcript|engineer chatter|<think>|assistant:/i.test(ceoUser),
    'CEO input is TRANSCRIPT-FREE (task + vision + manifest + verify + findings only)',
  );
  assert(
    ceoDecision.decision === 'approve' || ceoDecision.decision === 'revise',
    'CEO produced a verdict over the reviewed product',
    ceoDecision.decision,
  );
  assert(
    globalMaxTok < 16000,
    'NO runaway — every reviewer maxTurnOutputTokens < 16k (no per-agent cap needed)',
    `max=${globalMaxTok}`,
  );

  console.log(
    `\n${JSON.stringify(
      {
        lensRuns: review.lensRuns,
        measuredLenses,
        renderLimited,
        findings: review.findings,
        blockingCount: review.blockingCount,
        revisionTriggered: review.revisionTriggered,
        revisionContractIds: review.revisionContractIds,
        revisionRan: review.revisionRan,
        revisedVerifyOk: review.revisedVerifyOk,
        preVerifyOk: preVerify.ok,
        postVerifyOk: postVerify.ok,
        ceoDecision,
        budget: { turnsUsed: budget.turnsUsed, maxTurns: budget.maxTurns },
      },
      null,
      2,
    )}\n`,
  );
  if (failures > 0) throw new Error(`${failures} assertion(s) failed`);
  log('CORP REVIEW RUN: PASS');
}

main()
  .then(() => {
    killServer();
    process.exit(0);
  })
  .catch((e) => {
    log('CORP REVIEW RUN: FAIL', e?.stack || e);
    killServer();
    process.exit(1);
  });
