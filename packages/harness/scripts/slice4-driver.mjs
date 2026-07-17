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
 *   --max-tokens  <n>         generous cap (default 8192; the generation-heavy
 *                             manager AND engineer turns floor at 16k)
 *   --temperature <t>         sampling temperature                   (default 0.7)
 *   --timeout-ms  <ms>        per-call abort (local thinking is slow) (default 600000)
 *   (the temp workspace is always left on disk so you can inspect the files)
 *
 * Emits a single structured JSON report to STDOUT (progress goes to STDERR):
 *   { task, promoted, divisions, totalContracts, contractsDispatched, workspace,
 *     filesWritten:[{path,bytes,sample}], interceptorFired, interceptorReviewTurns,
 *     interceptorChangedCount, reviews:[{contractId,draftBytes,reviewedBytes,changed}],
 *     emptyAfterRetryDivisions, engineerEmptyAfterRetry,
 *     failures, skips, dispatchResults,
 *     manifest:{divisions,fileCount,totalBytes,interfaceCount,contractStatusSummary},
 *     verify:{ok,errorCount,errorsPreview}, ceoDecision:{decision,notesPreview},
 *     escalations:[{contractId,ownerManager,reason,acceptedGap,rescopePreview}],
 *     ...planningPreviews }
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
  PROMOTION_SYSTEM_PROMPT,
  CREATE_PRODUCTION_HIERARCHY,
  CREATE_PRODUCTION_HIERARCHY_TOOL,
  parseCreateHierarchyArgs,
  ARCHITECT_PROMPT,
  buildArchitectPrompt,
  parseArchitecture,
  buildManagerContractPrompt,
  parseManagerContracts,
  getRolePrompt,
  roleThinkingEnabled,
  applyCreateHierarchy,
  buildOrgChartQueueWithReport,
  resolveInterfaceHandles,
  countCrossDivisionEdges,
  topologicalOrder,
  edgesFromContracts,
  // slice 4:
  ENGINEER_SYSTEM_PROMPT,
  buildEngineerPrompt,
  parseEngineerOutput,
  dispatchContracts,
  makeNodeWorkspaceFs,
  // robustness backstops (spec §0.6):
  withRetryOnEmpty,
  isBlankFile,
  MANAGER_EMPTY_RETRY_NUDGE,
  // slice 5 (completion — assemble → verify → CEO sign-off → escalation):
  makeNodeWorkspaceReadFs,
  buildProductManifest,
  verifyProduct,
  CEO_REVIEW_PROMPT,
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
// writing a whole file) need more room than the judgment turns. A too-tight cap
// silently TRUNCATES — for the manager it lost an entire division (slice 3); for
// the engineer it would truncate the file mid-body. Floor both at ~16k, while a
// user-supplied higher --max-tokens still wins. ("Robustness is external", §0.6.)
const managerMaxTokens = Math.max(maxTokens, 16000);
const engineerMaxTokens = Math.max(maxTokens, 16000);
const temperature = Number.isFinite(Number(args.temperature)) ? Number(args.temperature) : 0.7;
const timeoutMs = Number.isFinite(Number(args['timeout-ms'])) ? Number(args['timeout-ms']) : 600000;
const limit = Number.isFinite(Number(args.limit)) ? Number(args.limit) : 6;

const log = (...m) => console.error('[slice4]', ...m);
const preview = (s, n = 800) =>
  typeof s === 'string' ? (s.length > n ? `${s.slice(0, n)}…` : s) : undefined;

const TOPO_PREVIEW_LIMIT = 20;
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
  const mockEngineer = (request) => {
    const isReview = request.review !== undefined;
    if (isReview) reviewTurns++;
    calls.push({
      id: request.contract.id,
      review: isReview,
      depIds: request.depContext.map((d) => d.contractId),
      depContent: request.depContext.map((d) => d.content),
    });
    return `// file for ${request.contract.id}${isReview ? ' (reviewed)' : ''}\nexport const ${request.contract.id} = 'ok';\n`;
  };

  const report = await dispatchContracts({
    orgChart: chart,
    runEngineer: mockEngineer,
    fs: makeNodeWorkspaceFs(),
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

function firstJsonObject(text) {
  if (typeof text !== 'string') return undefined;
  const start = text.indexOf('{');
  if (start === -1) return undefined;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function detectPromotion(message) {
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const call of calls) {
    if (call?.function?.name !== CREATE_PRODUCTION_HIERARCHY) continue;
    const rawArgs = call.function.arguments;
    const decoded =
      typeof rawArgs === 'string' ? (firstJsonObject(rawArgs) ?? safeParse(rawArgs)) : rawArgs;
    const parsed = parseCreateHierarchyArgs(decoded);
    if (parsed !== undefined) return { args: parsed, raw: call };
  }
  const inText = parseCreateHierarchyArgs(firstJsonObject(message.content));
  if (inText !== undefined)
    return { args: inText, raw: { source: 'content', text: message.content } };
  return undefined;
}

// --- Run ---------------------------------------------------------------------
const report = { task, promoted: false, limit };

try {
  log(`worker turn → ${baseUrl} (max_tokens=${maxTokens}, timeout=${timeoutMs}ms)`);
  const workerMsg = await chat({
    messages: [
      { role: 'system', content: PROMOTION_SYSTEM_PROMPT },
      { role: 'user', content: task },
    ],
    tools: [CREATE_PRODUCTION_HIERARCHY_TOOL],
    tool_choice: 'auto',
    temperature,
    max_tokens: maxTokens,
    ...thinkingBody(true),
  });

  const promotion = detectPromotion(workerMsg);
  if (promotion === undefined) {
    report.promoted = false;
    report.directAnswerPreview = preview(workerMsg.content, 2000);
    log('result: stayed solo (no create_production_hierarchy call)');
  } else {
    report.promoted = true;
    report.promotionReason = promotion.args.reason;
    const { divisions } = promotion.args;
    report.divisions = divisions.map((d) => d.name);
    log(
      `result: PROMOTED — ${divisions.length} division(s): ${divisions.map((d) => d.name).join(', ')}`,
    );

    // --- architect turn -----------------------------------------------------
    const architectThinking = roleThinkingEnabled('architect');
    log(`architect turn → shared architecture (thinking=${architectThinking})`);
    const architectMsg = await chat({
      messages: [
        { role: 'system', content: ARCHITECT_PROMPT },
        {
          role: 'user',
          content: withThinkTag(buildArchitectPrompt(task, divisions), architectThinking),
        },
      ],
      temperature,
      max_tokens: maxTokens,
      ...thinkingBody(architectThinking),
    });
    const architecture = parseArchitecture(architectMsg.content ?? '');
    log(
      `  architecture: ${architecture.moduleMap.length} region(s), ${architecture.interfaces.length} interface(s)`,
    );

    // --- manager turns (seeded) ---------------------------------------------
    const managerBase = getRolePrompt('manager').prompt;
    const managerThinking = roleThinkingEnabled('manager');
    const contractsByDivision = [];
    const emptyAfterRetryDivisions = [];
    for (const division of divisions) {
      log(
        `manager turn → contracts for "${division.name}" (thinking=${managerThinking}, max_tokens=${managerMaxTokens})`,
      );
      // Fix 2: retry-on-empty. A manager that parses 0 contracts silently loses a
      // whole division — retry ONCE with a nudge; if still 0, record it, never drop.
      const managerResult = await withRetryOnEmpty({
        isEmpty: (contracts) => contracts.length === 0,
        run: async ({ isRetry }) => {
          if (isRetry) log(`  0 contracts for "${division.name}" — retrying once with a nudge`);
          const base = withThinkTag(
            buildManagerContractPrompt(division, task, architecture),
            managerThinking,
          );
          const managerMsg = await chat({
            messages: [
              { role: 'system', content: managerBase },
              { role: 'user', content: isRetry ? `${base}\n\n${MANAGER_EMPTY_RETRY_NUDGE}` : base },
            ],
            temperature,
            max_tokens: managerMaxTokens,
            ...thinkingBody(managerThinking),
          });
          return parseManagerContracts(managerMsg.content ?? '');
        },
      });
      const contracts = managerResult.value;
      contractsByDivision.push(contracts);
      if (managerResult.emptyAfterRetry) {
        emptyAfterRetryDivisions.push(division.name);
        log(`  division "${division.name}" produced 0 contracts AFTER retry — recorded`);
      }
      log(
        `  parsed ${contracts.length} contract(s) for "${division.name}"${managerResult.retried ? ' (after retry)' : ''}`,
      );
    }
    report.emptyAfterRetryDivisions = emptyAfterRetryDivisions;

    // --- resolve handles + build the queued chart ---------------------------
    const byDivision = divisions.map((d, i) => ({
      division: d.name,
      contracts: contractsByDivision[i] ?? [],
    }));
    const divisionByContractId = new Map();
    for (const g of byDivision)
      for (const c of g.contracts) divisionByContractId.set(c.id, g.division);
    const { contracts: resolvedContracts, report: integrate } = resolveInterfaceHandles(
      byDivision,
      architecture,
    );
    const base = applyCreateHierarchy(null, { reason: promotion.args.reason, divisions });
    const { chart, report: queueReport } = buildOrgChartQueueWithReport({
      ...base,
      contracts: resolvedContracts,
      architecture,
    });

    report.totalContracts = chart.contracts.length;
    report.queueEdgeCount = chart.queue.length;
    report.crossDivisionEdgeCount = countCrossDivisionEdges(chart.queue, divisionByContractId);
    report.resolvedHandleCount = integrate.resolved.length;
    report.dagAcyclic = queueReport.acyclic;
    const topo = topologicalOrder(
      chart.contracts.map((c) => c.id),
      chart.queue,
    );
    report.topoOrderPreview = topo === null ? null : topo.slice(0, TOPO_PREVIEW_LIMIT);

    // --- DISPATCH a subset --------------------------------------------------
    const workspace = mkdtempSync(join(tmpdir(), 'slice4-ws-'));
    report.workspace = workspace;
    const engineerThinking = roleThinkingEnabled('engineer');
    let interceptorReviewTurns = 0;
    let engineerEmptyAfterRetry = 0;

    const runEngineer = async (request) => {
      const { contract, depContext, architectureRegion, review } = request;
      // Count the review request once, not once per retry attempt.
      if (review !== undefined) interceptorReviewTurns++;
      // Fix 2: retry-on-empty. A runaway think can starve the file body → empty.
      // Retry ONCE, and on the retry flip thinking OFF so the file can't be starved
      // again. If STILL empty, throw → dispatch marks the contract FAILED (recorded)
      // rather than writing an empty file to the slot.
      const engineerResult = await withRetryOnEmpty({
        isEmpty: isBlankFile,
        run: async ({ isRetry }) => {
          const thinking = isRetry ? false : engineerThinking;
          if (isRetry) log(`  empty engineer reply for ${contract.id} — retry with thinking OFF`);
          const messages = [
            { role: 'system', content: ENGINEER_SYSTEM_PROMPT },
            {
              role: 'user',
              content: withThinkTag(
                buildEngineerPrompt(contract, depContext, architectureRegion),
                thinking,
              ),
            },
          ];
          if (review !== undefined) {
            messages.push({ role: 'assistant', content: review.priorSubmission });
            messages.push({ role: 'user', content: withThinkTag(review.prompt, thinking) });
          }
          const msg = await chat({
            messages,
            temperature,
            max_tokens: engineerMaxTokens,
            ...thinkingBody(thinking),
          });
          return parseEngineerOutput(msg.content ?? '');
        },
      });
      if (engineerResult.emptyAfterRetry) {
        engineerEmptyAfterRetry++;
        throw new Error(
          `engineer produced empty content for ${contract.id} after retry (thinking-off fallback)`,
        );
      }
      return engineerResult.value;
    };

    log(
      `dispatching a subset of up to ${limit} contract(s) → ${workspace} (engineer thinking=${engineerThinking}, max_tokens=${engineerMaxTokens})`,
    );
    const dispatch = await dispatchContracts({
      orgChart: chart,
      runEngineer,
      fs: makeNodeWorkspaceFs(),
      workspace,
      // Fix 3: measure the interceptor — capture draft vs reviewed per contract.
      captureReviews: true,
      includeReviewBodies: true,
      limit,
    });

    report.contractsDispatched = dispatch.done.length + dispatch.failed.length;
    report.engineerEmptyAfterRetry = engineerEmptyAfterRetry;
    report.filesWritten = dispatch.filesWritten.map((f) => ({
      path: f.path,
      bytes: f.bytes,
      sample: preview(readFileSync(f.path, 'utf8'), SAMPLE_LEN),
    }));
    report.interceptorFired = interceptorReviewTurns > 0;
    report.interceptorReviewTurns = interceptorReviewTurns;
    report.interceptorChangedCount = dispatch.interceptorChangedCount;
    report.reviews = dispatch.reviews.map((r) => ({
      contractId: r.contractId,
      draftBytes: r.draftBytes,
      reviewedBytes: r.reviewedBytes,
      changed: r.changed,
    }));
    report.failures = dispatch.results
      .filter((r) => r.status === 'failed')
      .map((r) => ({ contractId: r.contractId, error: r.error }));
    report.skips = dispatch.results
      .filter((r) => r.status === 'skipped')
      .map((r) => ({ contractId: r.contractId, skippedBecause: r.skippedBecause }));
    report.dispatchResults = dispatch.results.map((r) => ({
      contractId: r.contractId,
      slot: r.slot,
      status: r.status,
    }));

    log(
      `dispatch done: ${dispatch.done.length} file(s) written, ${dispatch.failed.length} failed, ` +
        `${dispatch.skipped.length} skipped, interceptor fired ${interceptorReviewTurns} time(s)`,
    );

    // --- slice 5: assemble → verify → CEO sign-off → escalation -------------
    const readFs = makeNodeWorkspaceReadFs();
    const manifest = buildProductManifest(dispatch.chart, workspace, readFs);
    const verifyResult = verifyProduct(workspace, readFs);
    report.manifest = {
      divisions: manifest.divisions.map((d) => d.name),
      fileCount: manifest.files.length,
      totalBytes: manifest.totalBytes,
      interfaceCount: manifest.interfaces.length,
      contractStatusSummary: manifest.contractStatusSummary,
    };
    report.verify = {
      ok: verifyResult.ok,
      errorCount: verifyResult.errors.length,
      errorsPreview: verifyResult.errors
        .slice(0, 10)
        .map((e) => ({ file: e.file, message: e.message })),
    };
    log(
      `verify: ${verifyResult.ok ? 'PASS' : 'FAIL'} (${verifyResult.filesChecked} checked, ${verifyResult.errors.length} error(s))`,
    );

    // CEO final review — CLEAN, vision-only context: ONLY the original task, the
    // product manifest, and the verify evidence (never the build transcript).
    const ceoThinking = roleThinkingEnabled('ceo');
    log(`CEO review turn (intelligent tier, thinking=${ceoThinking})`);
    const ceoMsg = await chat({
      messages: [
        { role: 'system', content: CEO_REVIEW_PROMPT },
        {
          role: 'user',
          content: withThinkTag(
            buildCeoReviewPrompt({ originalTask: task, manifest, verifyResult }),
            ceoThinking,
          ),
        },
      ],
      temperature,
      max_tokens: maxTokens,
      ...thinkingBody(ceoThinking),
    });
    const ceoDecision = parseCeoDecision(ceoMsg.content ?? '');
    report.ceoDecision = {
      decision: ceoDecision.decision,
      notesPreview: preview(ceoDecision.notes, 600),
    };
    log(`CEO decision: ${ceoDecision.decision.toUpperCase()}`);

    // Bounded escalation: each failed contract routes ONE level up to its manager
    // for a single re-scope turn; this slice does not re-dispatch, so the bounded
    // attempt records an accepted gap — never a deadlock (spec §9).
    const managerThinkingForRescope = roleThinkingEnabled('manager');
    const escalations = [];
    for (const failed of dispatch.results.filter((r) => r.status === 'failed')) {
      const contract = dispatch.chart.contracts.find((c) => c.id === failed.contractId);
      if (contract === undefined) continue;
      const record = escalateContract(dispatch.chart, failed.contractId, failed.error);
      log(`escalating ${failed.contractId} → manager ${record.ownerManager}`);
      let rescopePreview;
      const outcome = await runBoundedEscalation({
        record,
        attemptRescope: async () => {
          const rescopeMsg = await chat({
            messages: [
              { role: 'system', content: getRolePrompt('manager').prompt },
              {
                role: 'user',
                content: withThinkTag(
                  buildManagerRescopePrompt(contract, record.reason),
                  managerThinkingForRescope,
                ),
              },
            ],
            temperature,
            max_tokens: managerMaxTokens,
            ...thinkingBody(managerThinkingForRescope),
          });
          rescopePreview = preview(rescopeMsg.content ?? '', 600);
          return false; // bounded: no re-dispatch this slice → accept the gap
        },
      });
      escalations.push({
        contractId: record.contractId,
        ownerManager: record.ownerManager,
        reason: record.reason,
        acceptedGap: outcome.acceptedGap,
        rescopePreview,
      });
    }
    report.escalations = escalations;
    if (escalations.length > 0) {
      log(`escalated ${escalations.length} failed contract(s) — bounded, all accepted gaps`);
    }
  }
} catch (err) {
  report.error = err instanceof Error ? err.message : String(err);
  log('ERROR:', report.error);
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
