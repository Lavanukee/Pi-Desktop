#!/usr/bin/env node
/**
 * Slice-4/5 driver — the EXECUTION CORE plus the COMPLETION path end to end (spec
 * §7/§8/§9). Where slice 3 stopped at PLANNING (promotion → architect → seeded
 * managers → resolve → queue), slice 4 DISPATCHES engineers to a subset of the
 * queued contracts so they produce REAL files, with the model-free submission
 * interceptor and workspace isolation. Slice 5 then COMPLETES the run: it assembles
 * the produced files into a product manifest, runs an evidence-grounded verify
 * pass, takes the CEO sign-off in a clean vision-only context (the false-completion
 * cure), and escalates any failed contract one bounded level up to its manager.
 *
 * Pipeline (spec §7; §4/§5/§6; §0.6 "robustness is external"):
 *   1. solo worker turn → promote-or-not (create_production_hierarchy);
 *   2. applyCreateHierarchy → base OrgChart (CEO + managers + divisions);
 *   3. ARCHITECT turn (intelligent, thinking-off) → the shared architecture;
 *   4. one manager turn PER division, SEEDED with the architecture → contracts;
 *   5. resolveInterfaceHandles + buildOrgChartQueue → the acyclic queued chart;
 *   6. DISPATCH a SUBSET (default the first ~6 ready contracts, --limit N) →
 *      each ready contract's engineer turn (balanced tier, thinking-ON, ~16k
 *      budget) runs through the submission interceptor (first submit bounced once
 *      for a self-review), writing <workspace>/<slot>.
 *   7. ASSEMBLE the workspace into a product manifest → VERIFY the produced files
 *      (deterministic, model-free) → the CEO final-review turn (intelligent tier,
 *      seeded ONLY with the original task + manifest + verify evidence — never the
 *      build transcript) → parse the approve/revise decision → bounded ESCALATION
 *      of every failed contract one level up to its manager (one re-scope turn,
 *      then an accepted gap — never a deadlock).
 *
 * It reuses @pi-desktop/harness/corp end to end and NEVER launches a server — you
 * point it at one.
 *
 * Usage (live, model-in-the-loop):
 *   node packages/harness/scripts/slice4-driver.mjs \
 *     --url http://127.0.0.1:8080/v1 \
 *     --task "Build a 3D browser game with a storyline, gameplay, and UI" \
 *     --limit 6
 *
 * Usage (offline dry-run — dispatches a 3-contract fixture with a MOCK engineer to
 * a temp workspace and ASSERTS files written + DAG ordering + the interceptor
 * firing once per contract, THEN exercises the slice-5 completion path over the
 * fixture: assemble → verify(mock all-pass + some-fail) → CEO decision(mock approve
 * & revise) → bounded escalation → accepted gap; no network):
 *   node packages/harness/scripts/slice4-driver.mjs --dry-run
 *
 * Options (live):
 *   --url         <baseUrl>   OpenAI-compat base ending in /v1        (required)
 *   --task        <prompt>    the user task to route                  (required)
 *   --model       <id>        model id sent in the body    (default "local-model")
 *   --limit       <n>         dispatch at most N engineers (subset)   (default 6)
 *   --max-tokens  <n>         judgment-turn cap (default 8192; the generation-heavy
 *                             architect/manager/engineer turns floor at 16k inside runCorp)
 *   --max-revisions <n>       cap on CEO revise cycles (default 1, inside runCorp)
 *   --temperature <t>         sampling temperature                   (default 0.7)
 *   --timeout-ms  <ms>        per-call abort (local thinking is slow) (default 600000)
 *   (the temp workspace is always left on disk so you can inspect the files)
 *
 * The LIVE flow is delegated to the shared orchestrator {@link runCorp} (corp/run.ts),
 * which threads the global RunBudget (corp/budget.ts) through EVERY model turn and the
 * bounded CEO revise loop (corp/revise.ts) through completion — so a misbehaving /
 * endless-looped model is caught and the run terminates with a recorded terminal state
 * (never a hang). The driver just supplies a streaming model seam + node fs seams and
 * prints runCorp's terminal state as JSON:
 *   { task, promoted, terminatedReason, divisions, totalContracts, contractsDispatched,
 *     workspace, manifest, verify, initialCeoDecision, ceoDecision, revise,
 *     escalations, failures, budget:{maxTurns,maxWallClockMs,turnsUsed,exceeded},
 *     turnsByPurpose, errors }
 */

import { mkdtempSync, readFileSync } from 'node:fs';
import { register } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// --- Import the corp TS module from a plain .mjs -----------------------------
// The corp sources use `.js` import specifiers that actually resolve to `.ts`.
// This resolve hook retries any relative `.js` specifier as `.ts` when the `.js`
// is absent, so `node slice4-driver.mjs` runs the TS module unbuilt.
const tsResolveHook = `
export async function resolve(specifier, context, next) {
  if (/^(\\.\\.?\\/|\\/)/.test(specifier) && specifier.endsWith('.js')) {
    try { return await next(specifier, context); }
    catch (err) {
      if (err && err.code === 'ERR_MODULE_NOT_FOUND') {
        return next(specifier.slice(0, -3) + '.ts', context);
      }
      throw err;
    }
  }
  return next(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(tsResolveHook)}`);

const corpUrl = new URL('../src/corp/index.ts', import.meta.url).href;
const {
  // The whole LIVE flow runs through the shared orchestrator, which threads the
  // global RunBudget (budget.ts) through EVERY model turn and the bounded CEO
  // revise loop (revise.ts) through completion — so an endless-looped / misbehaving
  // model is caught and the run terminates gracefully (spec §0.6 "robustness is
  // external"). The driver is now a thin streaming seam over it.
  runCorp,
  // Node fs seams for the real workspace.
  makeNodeWorkspaceFs,
  makeNodeWorkspaceReadFs,
  // Still used directly by the offline --dry-run fixture below.
  edgesFromContracts,
  dispatchContracts,
  writeSlot,
  buildProductManifest,
  verifyProduct,
  buildCeoReviewPrompt,
  parseCeoDecision,
  escalateContract,
  buildManagerRescopePrompt,
  runBoundedEscalation,
} = await import(corpUrl);

// --- Args --------------------------------------------------------------------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const dryRun = args['dry-run'] === true;
const baseUrl = typeof args.url === 'string' ? args.url.replace(/\/+$/, '') : undefined;
const task = typeof args.task === 'string' ? args.task : undefined;
const model = typeof args.model === 'string' ? args.model : 'local-model';
const maxTokens = Number.isFinite(Number(args['max-tokens'])) ? Number(args['max-tokens']) : 8192;
// Generation-heavy role turns (the manager writing contract JSON, the engineer
// writing a whole file) need more room than the judgment turns and are floored at
// ~16k INSIDE runCorp — a too-tight cap silently TRUNCATES (a whole division lost
// in slice 3), so the base --max-tokens here only sets the judgment-turn cap.
// ("Robustness is external", §0.6.)
const temperature = Number.isFinite(Number(args.temperature)) ? Number(args.temperature) : 0.7;
const timeoutMs = Number.isFinite(Number(args['timeout-ms'])) ? Number(args['timeout-ms']) : 600000;
const limit = Number.isFinite(Number(args.limit)) ? Number(args.limit) : 6;
// Cap on CEO revise cycles (revise.ts); the default (1) applies inside runCorp.
const maxRevisions = Number.isFinite(Number(args['max-revisions']))
  ? Number(args['max-revisions'])
  : undefined;

const log = (...m) => console.error('[slice4]', ...m);
const preview = (s, n = 800) =>
  typeof s === 'string' ? (s.length > n ? `${s.slice(0, n)}…` : s) : undefined;

const SAMPLE_LEN = 240;

// --- Dry-run fixture + assertions --------------------------------------------
function makeContract(id, ownerNodeId, { slot, dependsOn = [] }) {
  return {
    id,
    title: `Contract ${id}`,
    ownerNodeId,
    input: `input ${id}`,
    output: `output ${id}`,
    slot,
    available: { tools: ['read', 'write'], imports: [] },
    reviewRubric: 'meets the slot contract',
    dependsOn,
    status: 'queued',
  };
}

function assert(cond, msg) {
  if (!cond) throw new Error(`dry-run assertion failed: ${msg}`);
}

// A 3-contract chart: a root, a dependent that consumes it, and an independent
// one — enough to exercise DAG ordering + real dep-content forwarding.
function dryRunChart() {
  const contracts = [
    makeContract('a', 'eng-a', { slot: 'src/a.ts' }),
    makeContract('b', 'eng-b', { slot: 'src/b.ts', dependsOn: ['a'] }),
    makeContract('c', 'eng-c', { slot: 'src/c.ts' }),
  ];
  return {
    projectId: 'dry',
    nodes: [],
    contracts,
    queue: edgesFromContracts(contracts),
    branches: [],
    status: 'running',
    nodeStatus: {},
  };
}

async function runDryRun() {
  log('DRY RUN — dispatch a 3-contract fixture with a MOCK engineer (no network)');
  const chart = dryRunChart();
  const workspace = mkdtempSync(join(tmpdir(), 'slice4-dry-'));

  let reviewTurns = 0;
  const calls = [];
  // The engineer SEAM writes its slot file (the write moved out of dispatch) and
  // returns the WrittenFile(s); dispatch reads the slot back for dependents.
  const nodeFs = makeNodeWorkspaceFs();
  const mockEngineer = (request) => {
    const isReview = request.review !== undefined;
    if (isReview) reviewTurns++;
    calls.push({
      id: request.contract.id,
      review: isReview,
      depIds: request.depContext.map((d) => d.contractId),
      depContent: request.depContext.map((d) => d.content),
    });
    const body = `// file for ${request.contract.id}${isReview ? ' (reviewed)' : ''}\nexport const ${request.contract.id} = 'ok';\n`;
    const path = writeSlot(workspace, request.contract.slot, body, nodeFs);
    return [{ path, bytes: Buffer.byteLength(body, 'utf8') }];
  };

  const report = await dispatchContracts({
    orgChart: chart,
    runEngineer: mockEngineer,
    readFs: makeNodeWorkspaceReadFs(),
    workspace,
    // Fix 3: measure the interceptor — capture draft vs reviewed per contract.
    captureReviews: true,
    includeReviewBodies: true,
  });

  // --- assertions: files written + ordering + interceptor --------------------
  assert(report.done.length === 3, `all 3 contracts dispatched (got ${report.done.length})`);
  assert(report.failed.length === 0, 'no failures');
  assert(report.filesWritten.length === 3, '3 files written');
  for (const f of report.filesWritten) {
    const body = readFileSync(f.path, 'utf8');
    assert(body.length > 0, `file ${f.path} is non-empty`);
  }

  const firstDraft = (id) => calls.findIndex((c) => c.id === id && !c.review);
  assert(firstDraft('a') < firstDraft('b'), 'dependency a dispatched before dependent b');

  const bDraft = calls.find((c) => c.id === 'b' && !c.review);
  assert(bDraft.depIds.includes('a'), "b's depContext includes a");
  assert(
    typeof bDraft.depContent[0] === 'string' && bDraft.depContent[0].includes('reviewed'),
    "b builds against a's REAL reviewed file content",
  );

  assert(reviewTurns === 3, `interceptor fired once per contract (got ${reviewTurns})`);

  // Fix 3 assertions: the draft-vs-reviewed capture is populated + measurable.
  assert(report.reviews.length === 3, `3 review records captured (got ${report.reviews.length})`);
  assert(
    report.interceptorChangedCount === 3,
    `all 3 reviewed files differ from their draft (got ${report.interceptorChangedCount})`,
  );
  for (const r of report.reviews) {
    assert(
      typeof r.draft === 'string' && typeof r.reviewed === 'string',
      `review record for ${r.contractId} carries both bodies`,
    );
    assert(
      r.reviewedBytes >= r.draftBytes,
      `reviewed file for ${r.contractId} is not smaller than the draft`,
    );
    assert(r.changed === true, `review changed ${r.contractId}`);
  }

  // --- slice 5: assemble → verify → CEO decision → escalation (all offline) ---
  const readFs = makeNodeWorkspaceReadFs();

  // Assemble the dispatched workspace into a product manifest.
  const manifest = buildProductManifest(report.chart, workspace, readFs);
  assert(
    manifest.files.length === 3,
    `manifest lists all 3 produced files (got ${manifest.files.length})`,
  );
  assert(manifest.totalBytes > 0, 'manifest totals real bytes');
  assert(
    manifest.contractStatusSummary.done === 3,
    `manifest summary counts 3 done (got ${manifest.contractStatusSummary.done})`,
  );

  // Verify — a mock all-pass and a mock some-fail check (the objective evidence).
  const vPass = verifyProduct(workspace, readFs, () => undefined);
  assert(vPass.ok && vPass.filesChecked === 3, 'verify(all-pass) is ok over 3 files');
  const vFail = verifyProduct(workspace, readFs, (f) =>
    f.endsWith('b.ts') ? 'mock type error' : undefined,
  );
  assert(!vFail.ok && vFail.errors.length === 1, 'verify(some-fail) reports exactly one error');

  // CEO review — the prompt composes cleanly, and both decisions parse.
  const ceoPrompt = buildCeoReviewPrompt({
    originalTask: 'dry-run task',
    manifest,
    verifyResult: vPass,
  });
  assert(
    ceoPrompt.includes('ORIGINAL TASK') && ceoPrompt.includes('dry-run task'),
    'CEO prompt is seeded with the original task',
  );
  assert(
    !ceoPrompt.includes('reviewed') && !ceoPrompt.includes('draft'),
    'CEO prompt carries no build transcript',
  );
  const ceoApprove = parseCeoDecision('APPROVE — meets the vision.');
  const ceoRevise = parseCeoDecision('REVISE\nThe data layer is missing entirely.');
  assert(ceoApprove.decision === 'approve', 'CEO mock approve parses to approve');
  assert(
    ceoRevise.decision === 'revise' && (ceoRevise.notes ?? '').includes('data layer'),
    'CEO mock revise parses to revise + notes',
  );

  // Escalation — a failed contract routes one level up, bounded to one attempt.
  const escChart = {
    projectId: 'dry',
    nodes: [
      { id: 'ceo', role: 'ceo', name: 'CEO' },
      { id: 'manager', role: 'manager', name: 'Manager block', parentId: 'ceo' },
      { id: 'division-x', role: 'division', name: 'X', parentId: 'manager' },
    ],
    contracts: [makeContract('x', 'x-eng-1', { slot: 'src/x.ts' })],
    queue: [],
    branches: [],
    status: 'running',
    nodeStatus: {},
  };
  const escRecord = escalateContract(
    escChart,
    'x',
    'unfulfillable, because the API is unavailable',
  );
  assert(escRecord.ownerManager === 'manager', 'escalation routes one level up to the manager');
  const escOutcome = await runBoundedEscalation({ record: escRecord, attemptRescope: () => false });
  assert(escOutcome.attempts === 1, 'escalation is bounded to one attempt');
  assert(
    escOutcome.acceptedGap === true,
    'a still-failing contract becomes an accepted gap (no deadlock)',
  );
  // The manager re-scope prompt is well-formed.
  assert(
    buildManagerRescopePrompt(escChart.contracts[0], escRecord.reason).includes('ACCEPT THE GAP'),
    'manager re-scope prompt offers the accept-the-gap path',
  );

  const out = {
    task: '(dry-run)',
    dryRun: true,
    assertionsPassed: true,
    workspace,
    contractsDispatched: report.done.length,
    dispatchOrder: calls.filter((c) => !c.review).map((c) => c.id),
    interceptorFired: reviewTurns > 0,
    interceptorReviewTurns: reviewTurns,
    interceptorChangedCount: report.interceptorChangedCount,
    reviews: report.reviews.map((r) => ({
      contractId: r.contractId,
      draftBytes: r.draftBytes,
      reviewedBytes: r.reviewedBytes,
      changed: r.changed,
    })),
    filesWritten: report.filesWritten.map((f) => ({
      path: f.path,
      bytes: f.bytes,
      sample: preview(readFileSync(f.path, 'utf8'), SAMPLE_LEN),
    })),
    manifest: {
      divisions: manifest.divisions.length,
      fileCount: manifest.files.length,
      totalBytes: manifest.totalBytes,
      contractStatusSummary: manifest.contractStatusSummary,
    },
    verify: {
      pass: { ok: vPass.ok, filesChecked: vPass.filesChecked },
      fail: { ok: vFail.ok, errorCount: vFail.errors.length },
    },
    ceo: { approve: ceoApprove, revise: ceoRevise },
    escalation: {
      record: escRecord,
      resolved: escOutcome.resolved,
      acceptedGap: escOutcome.acceptedGap,
      attempts: escOutcome.attempts,
    },
    failures: [],
    skips: [],
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

if (dryRun) {
  try {
    await runDryRun();
    process.exit(0);
  } catch (err) {
    console.error(`[slice4] ${err instanceof Error ? err.message : String(err)}`);
    process.stdout.write(
      `${JSON.stringify({ dryRun: true, assertionsPassed: false, error: String(err) }, null, 2)}\n`,
    );
    process.exit(1);
  }
}

if (baseUrl === undefined || task === undefined) {
  console.error(
    'usage: node slice4-driver.mjs --url <http://host:port/v1> --task "<prompt>" [--limit n] [--model id] [--max-tokens n]\n' +
      '   or: node slice4-driver.mjs --dry-run   (offline: dispatch a 3-contract fixture with a mock engineer)',
  );
  process.exit(2);
}

// --- Per-role thinking control (corp knob) -----------------------------------
const NO_THINK_TAG = '/no_think';
const thinkingBody = (enabled) => ({ chat_template_kwargs: { enable_thinking: enabled } });
const withThinkTag = (content, enabled) => (enabled ? content : `${content}\n\n${NO_THINK_TAG}`);

// --- OpenAI-compat chat call: STREAMING (SSE) + accumulate -------------------
async function chat(body) {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ model, stream: true, ...body }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  if (res.body === null) throw new Error('streaming response had no body');
  return accumulateStream(res.body);
}

function accumulateToolCalls(acc, deltas) {
  for (const d of deltas) {
    const idx = typeof d.index === 'number' ? d.index : acc.length;
    if (acc[idx] === undefined) {
      acc[idx] = {
        index: idx,
        id: undefined,
        type: 'function',
        function: { name: '', arguments: '' },
      };
    }
    const slot = acc[idx];
    if (typeof d.id === 'string') slot.id = d.id;
    if (typeof d.type === 'string') slot.type = d.type;
    const fn = d.function;
    if (fn !== undefined && fn !== null) {
      if (typeof fn.name === 'string') slot.function.name += fn.name;
      if (typeof fn.arguments === 'string') slot.function.arguments += fn.arguments;
    }
  }
}

async function accumulateStream(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const msg = { role: 'assistant', content: '', reasoning_content: '', tool_calls: [] };
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf('\n');
        if (line === '' || !line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let evt;
        try {
          evt = JSON.parse(data);
        } catch {
          continue;
        }
        const delta = evt?.choices?.[0]?.delta;
        if (delta === undefined || delta === null) continue;
        if (typeof delta.content === 'string') msg.content += delta.content;
        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (typeof reasoning === 'string') msg.reasoning_content += reasoning;
        if (Array.isArray(delta.tool_calls)) accumulateToolCalls(msg.tool_calls, delta.tool_calls);
      }
    }
  } finally {
    reader.releaseLock();
  }
  msg.tool_calls = msg.tool_calls.filter(Boolean);
  if (msg.tool_calls.length === 0) msg.tool_calls = undefined;
  if (msg.reasoning_content === '') msg.reasoning_content = undefined;
  return msg;
}

// --- Model seam for runCorp --------------------------------------------------
// Bridge the provider-agnostic CorpChatRequest (run.ts) to the live streaming
// call: apply the llama.cpp thinking switch (`chat_template_kwargs` + a `/no_think`
// tag on the last user turn) from `req.thinking`, pass the worker's promotion tool
// through when present, and surface any tool calls back to the orchestrator. All
// prompt composition, budget charging, and the bounded revise loop live inside
// runCorp — this closure is the only live-model-specific glue.
const corpChat = async (req) => {
  const lastUserIdx = req.messages.map((m) => m.role).lastIndexOf('user');
  const messages = req.messages.map((m, i) => ({
    role: m.role,
    content: i === lastUserIdx ? withThinkTag(m.content, req.thinking) : m.content,
  }));
  const msg = await chat({
    messages,
    ...(req.tools !== undefined ? { tools: req.tools, tool_choice: 'auto' } : {}),
    temperature,
    max_tokens: req.maxTokens,
    ...thinkingBody(req.thinking),
  });
  const toolCalls = Array.isArray(msg.tool_calls)
    ? msg.tool_calls
        .filter(Boolean)
        .map((tc) => ({ name: tc.function?.name ?? '', arguments: tc.function?.arguments ?? '' }))
    : [];
  return { content: msg.content ?? '', ...(toolCalls.length > 0 ? { toolCalls } : {}) };
};

// --- Run (delegated to the shared orchestrator) ------------------------------
// runCorp threads the RunBudget (budget.ts) through EVERY model turn and the
// bounded CEO revise loop (revise.ts) through completion, and NEVER throws or
// hangs — a misbehaving / endless-looped model is caught by the per-turn
// backstops and the global budget, and the run terminates with a recorded
// terminal state (spec §0.6). The driver just emits that terminal state.
const workspace = mkdtempSync(join(tmpdir(), 'slice4-ws-'));
log(`worker turn → ${baseUrl} (max_tokens=${maxTokens}, timeout=${timeoutMs}ms)`);

const result = await runCorp({
  task,
  chat: corpChat,
  fs: makeNodeWorkspaceFs(),
  readFs: makeNodeWorkspaceReadFs(),
  workspace,
  limit,
  maxTokens,
  ...(maxRevisions !== undefined ? { maxRevisions } : {}),
  log: (m) => log(m),
});

log(
  `run terminated: ${result.terminatedReason} — ` +
    `${result.contractsDispatched} contract(s) dispatched, ` +
    `CEO ${result.ceoDecision?.decision ?? '(none)'}, ` +
    `turns ${result.budget.turnsUsed}/${result.budget.maxTurns}` +
    `${result.budget.exceeded ? ' (BUDGET EXCEEDED)' : ''}`,
);

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
