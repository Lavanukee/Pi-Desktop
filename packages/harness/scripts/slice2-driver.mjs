#!/usr/bin/env node
/**
 * Slice-2 driver — the FULL planning pass against a REAL OpenAI-compatible
 * endpoint (a local llama-server /v1). Where slice 1 stopped after one division,
 * slice 2 runs the manager contract-writing turn for EVERY division, assembles
 * them onto one OrgChart, and builds the whole-corporation queue.
 *
 * Pipeline (spec §4/§5/§6, §0.6 "robustness is external"):
 *   1. solo worker turn → promote-or-not (create_production_hierarchy);
 *   2. if promoted, applyCreateHierarchy → base OrgChart (CEO + managers + divisions);
 *   3. one manager turn PER division → parseManagerContracts;
 *   4. assemble all divisions' contracts onto the chart;
 *   5. buildOrgChartQueue → sanitize (drop dangling deps, de-collide slots, drop
 *      duplicate ids) → edges → acyclicity (break cycles deterministically) → queue.
 *
 * It reuses @pi-desktop/harness/corp end to end and NEVER launches a server —
 * you point it at one. Slice 2 is PLANNING ONLY: no dispatch, engineers, merge,
 * or review are exercised.
 *
 * Usage (live, model-in-the-loop):
 *   node packages/harness/scripts/slice2-driver.mjs \
 *     --url http://127.0.0.1:8080/v1 \
 *     --task "Build a 3D browser game with a storyline, gameplay, and UI"
 *
 * Usage (offline dry-run — exercises assemble + plan + report with a built-in
 * fixture that contains a dangling dep, two slot collisions, a duplicate id, and
 * a cross-division cycle; no network):
 *   node packages/harness/scripts/slice2-driver.mjs --dry-run
 *
 * Options (live):
 *   --url         <baseUrl>   OpenAI-compat base ending in /v1        (required)
 *   --task        <prompt>    the user task to route                  (required)
 *   --model       <id>        model id sent in the body    (default "local-model")
 *   --max-tokens  <n>         generous cap — qwen3.5 THINKS first  (default 8192)
 *   --temperature <t>         sampling temperature                   (default 0.7)
 *   --timeout-ms  <ms>        per-call abort (local thinking is slow) (default 600000)
 *
 * Emits a single structured JSON report to STDOUT (progress goes to STDERR):
 *   { task, promoted, divisions, perDivisionContractCounts, totalContracts,
 *     sweepRepairs, queueEdgeCount, dagAcyclic, topoOrderPreview, ...previews }
 */

import { register } from 'node:module';

// --- Import the corp TS module from a plain .mjs -----------------------------
// The corp sources use `.js` import specifiers that actually resolve to `.ts`
// (tsc rewrites them at build; Node's native type-stripping does not). This tiny
// resolve hook retries any relative `.js` specifier as `.ts` when the `.js` is
// absent, so `node slice2-driver.mjs` runs the TS module unbuilt.
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
  buildManagerContractPrompt,
  parseManagerContracts,
  getRolePrompt,
  roleThinkingEnabled,
  applyCreateHierarchy,
  buildOrgChartQueueWithReport,
  topologicalOrder,
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
const temperature = Number.isFinite(Number(args.temperature)) ? Number(args.temperature) : 0.7;
const timeoutMs = Number.isFinite(Number(args['timeout-ms'])) ? Number(args['timeout-ms']) : 600000;

const log = (...m) => console.error('[slice2]', ...m);
const preview = (s, n = 800) =>
  typeof s === 'string' ? (s.length > n ? `${s.slice(0, n)}…` : s) : undefined;

const TOPO_PREVIEW_LIMIT = 20;

// --- The pure assemble + plan + report core ----------------------------------
// Shared by the live path and the dry-run so the driver's non-network logic is
// verifiable offline. Given the promotion reason, the divisions, and each
// division's parsed contracts, it builds the OrgChart, runs the whole-corp queue
// build (sanitize + DAG), and shapes the structured planning report.
function assembleAndPlan({ reason, divisions, contractsByDivision }) {
  const base = applyCreateHierarchy(null, { reason, divisions });
  const contracts = contractsByDivision.flat();
  const { chart, report } = buildOrgChartQueueWithReport({ ...base, contracts });

  const { sweep, brokenEdges, acyclic } = report;
  const topo = topologicalOrder(
    chart.contracts.map((c) => c.id),
    chart.queue,
  );

  return {
    divisions,
    perDivisionContractCounts: divisions.map((d, i) => ({
      division: d.name,
      count: contractsByDivision[i]?.length ?? 0,
    })),
    totalContracts: chart.contracts.length,
    sweepRepairs: {
      duplicateIdCount: sweep.duplicateIds.length,
      droppedDependencyCount: sweep.droppedDependencies.length,
      slotCollisionCount: sweep.slotCollisions.length,
      brokenEdgeCount: brokenEdges.length,
      duplicateIds: sweep.duplicateIds,
      droppedDependencies: sweep.droppedDependencies,
      slotCollisions: sweep.slotCollisions,
      brokenEdges,
    },
    queueEdgeCount: chart.queue.length,
    dagAcyclic: acyclic,
    topoOrderPreview: topo === null ? null : topo.slice(0, TOPO_PREVIEW_LIMIT),
  };
}

// --- Dry-run: exercise the whole assemble→plan→report path offline -----------
function makeContract(id, ownerNodeId, { slot, dependsOn = [] }) {
  return {
    id,
    title: id,
    ownerNodeId,
    input: 'in',
    output: 'out',
    slot,
    available: { tools: ['read', 'write'], imports: [] },
    reviewRubric: 'meets the slot contract',
    dependsOn,
    status: 'queued',
  };
}

// A fixture that intentionally triggers EVERY repair the sweep + DAG build make:
// a dangling dep (sh-1 → ghost), two slot collisions (be-2 shares be-1's slot;
// sh-2 shares fe-1's slot across divisions), a duplicate id (a second sh-1), and
// a cross-division cycle (fe-1 ↔ be-1).
function dryRunFixture() {
  const divisions = [
    { name: 'Frontend', purpose: 'the UI shell and views' },
    { name: 'Backend', purpose: 'the API and data layer' },
    { name: 'Shared', purpose: 'cross-cutting theme + types' },
  ];
  const contractsByDivision = [
    [
      makeContract('fe-1', 'division-frontend-eng-1', {
        slot: 'src/App.tsx',
        dependsOn: ['be-1'], // forward ref → half of the injected cycle
      }),
      makeContract('fe-2', 'division-frontend-eng-2', {
        slot: 'src/Sidebar.tsx',
        dependsOn: ['fe-1'],
      }),
    ],
    [
      makeContract('be-1', 'division-backend-eng-1', {
        slot: 'src/api.ts',
        dependsOn: ['fe-1'], // cross-division dep → other half of the cycle
      }),
      makeContract('be-2', 'division-backend-eng-2', { slot: 'src/api.ts' }), // slot collision
    ],
    [
      makeContract('sh-1', 'division-shared-eng-1', {
        slot: 'src/theme.ts',
        dependsOn: ['ghost'], // dangling dep
      }),
      makeContract('sh-2', 'division-shared-eng-2', { slot: 'src/App.tsx' }), // cross-div slot collision
      makeContract('sh-1', 'division-shared-eng-3', { slot: 'src/types.ts' }), // duplicate id
    ],
  ];
  return { reason: 'multi-part app (dry-run fixture)', divisions, contractsByDivision };
}

if (dryRun) {
  log('DRY RUN — assembling + planning a built-in 3-division fixture (no network)');
  const fixture = dryRunFixture();
  const planned = assembleAndPlan(fixture);
  const report = { task: task ?? '(dry-run)', dryRun: true, promoted: true, ...planned };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(0);
}

if (baseUrl === undefined || task === undefined) {
  console.error(
    'usage: node slice2-driver.mjs --url <http://host:port/v1> --task "<prompt>" [--model id] [--max-tokens n] [--temperature t] [--timeout-ms ms]\n' +
      '   or: node slice2-driver.mjs --dry-run   (offline: exercises assemble + plan + report)',
  );
  process.exit(2);
}

// --- Per-role thinking control (corp knob) -----------------------------------
// qwen3.5 THINKS inside <think>…</think> before answering. Structured-output
// roles (the manager writing contract JSON) run thinking OFF — real-model testing
// showed the contract turn running away inside <think> and never closing it,
// starving the JSON. Judgment roles (the solo/promotion worker) run thinking ON.
const NO_THINK_TAG = '/no_think';
const thinkingBody = (enabled) => ({ chat_template_kwargs: { enable_thinking: enabled } });
const withThinkTag = (content, enabled) => (enabled ? content : `${content}\n\n${NO_THINK_TAG}`);

// --- OpenAI-compat chat call: STREAMING (SSE) + accumulate -------------------
// Streaming, not one-shot: undici's hidden ~300s timeout kills a long
// non-streaming turn (the whole body is withheld until generation finishes).
// With stream:true each SSE chunk resets the idle timer, so a >5min manager turn
// survives; the overall AbortSignal.timeout is the only hard cap.
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
const report = { task, promoted: false };

try {
  const workerThinking = true;
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
    ...thinkingBody(workerThinking),
  });
  report.workerReasoningPreview = preview(workerMsg.reasoning_content ?? workerMsg.reasoning);
  report.workerContentPreview = preview(workerMsg.content);

  const promotion = detectPromotion(workerMsg);
  if (promotion === undefined) {
    report.promoted = false;
    report.directAnswerPreview = preview(workerMsg.content, 2000);
    log('result: stayed solo (no create_production_hierarchy call)');
  } else {
    report.promoted = true;
    report.promotionReason = promotion.args.reason;
    report.rawWorkerToolCall = promotion.raw;
    const { divisions } = promotion.args;
    log(
      `result: PROMOTED — ${divisions.length} division(s): ${divisions.map((d) => d.name).join(', ')}`,
    );

    // One manager turn PER division (this is the slice-2 step over slice 1).
    const managerBase = getRolePrompt('manager').prompt;
    const managerThinking = roleThinkingEnabled('manager');
    const contractsByDivision = [];
    const managerReplyPreviews = [];
    for (const division of divisions) {
      log(`manager turn → contracts for "${division.name}" (thinking=${managerThinking})`);
      const managerUser = buildManagerContractPrompt(division, task);
      const managerMsg = await chat({
        messages: [
          { role: 'system', content: managerBase },
          { role: 'user', content: withThinkTag(managerUser, managerThinking) },
        ],
        temperature,
        max_tokens: maxTokens,
        ...thinkingBody(managerThinking),
      });
      const contracts = parseManagerContracts(managerMsg.content ?? '');
      contractsByDivision.push(contracts);
      managerReplyPreviews.push({
        division: division.name,
        replyPreview: preview(managerMsg.content, 600),
      });
      log(`  parsed ${contracts.length} contract(s) for "${division.name}"`);
    }
    report.managerReplyPreviews = managerReplyPreviews;

    // Assemble every division's contracts onto one chart + build the whole-corp queue.
    Object.assign(
      report,
      assembleAndPlan({ reason: promotion.args.reason, divisions, contractsByDivision }),
    );
    log(
      `planning done: ${report.totalContracts} contract(s), ${report.queueEdgeCount} queue edge(s), acyclic=${report.dagAcyclic}`,
    );
  }
} catch (err) {
  report.error = err instanceof Error ? err.message : String(err);
  log('ERROR:', report.error);
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
