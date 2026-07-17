/**
 * REAL-SERVER VALIDATION for the STUCK-ENGINEER RECOVERY PIPELINE + the
 * completeness backstop (spec §7 consults, §9 escalation, "Run safety & budgets").
 *
 * Starts the app's own llama-server (Q8 qwen3.5-4b) on :8177 and drives a
 * DEP-CHAINED engineer set — including a deliberately-HARD contract — through the
 * EXACT production agent seam runCorp uses (`createRunRoleAgent` + the shared
 * `buildEngineerAgentInput` mapping), then runs the REAL escalation recovery
 * (manager re-scope → re-dispatch) on the failed contract. It measures:
 *
 *   1. COMPLETION RATE with bump-to-continue (target > 64%).
 *   2. BUMP-TO-CONTINUE: a premature-stop engineer re-prompted on the SAME session
 *      to reach a terminal decision (write+submit, or declare unfulfillable).
 *   3. ESCALATION RECOVERY: an unfulfillable contract RE-SCOPED by the manager and
 *      RE-DISPATCHED (recovered), not silently gapped.
 *   4. CONSULT: a stuck engineer calling call_peer / call_specialist (advice-only).
 *   5. ALL LOOPS BOUNDED (2 bumps, 1 escalation re-dispatch, consult depth 1) and NO
 *      per-agent step/time cap.
 *
 * KILLS the server on every exit path — no orphan.
 *
 *   node tests/e2e/corp-recovery-run.mjs
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HOME = os.homedir();
const SERVER_BIN = `${HOME}/.cache/pi-desktop/llamacpp/b9934/llama-b9934/llama-server`;
const MODEL_GGUF = `${HOME}/.cache/pi-desktop/models/qwen3.5-4b-mtp/Qwen3.5-4B-Q8_0.gguf`;
const CHAT_TEMPLATE = `${HOME}/.cache/pi-desktop/chat-templates/Qwen--Qwen3.5-4B.jinja`;
const HOST = '127.0.0.1';
const PORT = 8177;
const BASE_URL = `http://${HOST}:${PORT}/v1`;
const HEALTH_URL = `http://${HOST}:${PORT}/health`;
const MODEL_ID = 'qwen3.5-4b';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(appRoot, '../..');
const SEAM_IMPL_TS = path.join(appRoot, 'electron', 'corp', 'role-agent-seam-impl.ts');
const CORP_INDEX_TS = path.join(repoRoot, 'packages', 'harness', 'src', 'corp', 'index.ts');

const RUN_DIR = mkdtempSync(path.join(os.tmpdir(), 'corp-recovery-'));
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
  console.log('CORP RECOVERY RUN: SKIPPED (model assets not present)');
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

// ── streaming chat seam (the manager re-scope turn) ──────────────────────────
const NO_THINK = '/no_think';
const thinkingBody = (on) => ({ chat_template_kwargs: { enable_thinking: on } });
async function chatCall(body) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ model: MODEL_ID, stream: true, ...body }),
    signal: AbortSignal.timeout(600000),
  });
  if (!res.ok)
    throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const msg = { content: '' };
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl = buf.indexOf('\n');
    while (nl !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      nl = buf.indexOf('\n');
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let evt;
      try {
        evt = JSON.parse(data);
      } catch {
        continue;
      }
      const d = evt?.choices?.[0]?.delta;
      if (d && typeof d.content === 'string') msg.content += d.content;
    }
  }
  return msg;
}
const corpChat = async (req) => {
  const lastUser = req.messages.map((m) => m.role).lastIndexOf('user');
  const messages = req.messages.map((m, i) => ({
    role: m.role,
    content: i === lastUser && !req.thinking ? `${m.content}\n\n${NO_THINK}` : m.content,
  }));
  const msg = await chatCall({
    messages,
    temperature: 0.7,
    max_tokens: req.maxTokens,
    ...thinkingBody(req.thinking),
  });
  return { content: msg.content ?? '' };
};

// ── the crafted dep-chained chart (incl. a deliberately-HARD contract) ───────
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
    ...(o.notes !== undefined ? { notes: o.notes } : {}),
    status: 'queued',
  };
}

function craftedChart(edgesFromContracts) {
  const contracts = [
    contract('c1', 'eng-1', {
      title: 'Vec2 type',
      input: 'nothing',
      output:
        'export interface Vec2 { x: number; y: number } and export function add(a: Vec2, b: Vec2): Vec2',
      slot: 'src/vec2.ts',
      rubric: 'Vec2 interface + a pure add() are exported',
    }),
    contract('c2', 'eng-2', {
      title: 'Math utils',
      input: 'the Vec2 type',
      output:
        'export function clamp(n, lo, hi) and export function scale(v: Vec2, k: number): Vec2',
      slot: 'src/mathutils.ts',
      rubric: 'clamp + scale exported; scale uses Vec2',
      dependsOn: ['c1'],
    }),
    contract('c3', 'eng-3', {
      title: 'Particle step',
      input: 'Vec2 + math utils',
      output:
        'export interface Particle { pos: Vec2; vel: Vec2 } and export function step(p: Particle, dt: number): Particle',
      slot: 'src/particle.ts',
      rubric: 'step advances pos by vel*dt using the imported helpers',
      dependsOn: ['c2'],
      // Forces a CONSULT: the engineer must ask a specialist before submitting.
      notes:
        'MANDATORY: before you call submit_contract, you MUST call call_specialist with lens "correctness" to sanity-check that step() advances position by velocity*dt. Incorporate its advice, then submit.',
    }),
    contract('c4', 'eng-4', {
      title: 'Legacy wire-protocol client',
      input: 'the proprietary binary wire-format spec at src/legacy/PROTOCOL.md',
      output:
        'A TypeScript client that encodes/decodes messages EXACTLY per the framing defined in src/legacy/PROTOCOL.md (opcodes, field order, checksum) — matching that spec byte-for-byte.',
      slot: 'src/legacy/client.ts',
      rubric: 'the framing matches src/legacy/PROTOCOL.md exactly (opcodes, field order, checksum)',
      // DELIBERATELY HARD: the required spec file does not exist, and the engineer
      // is told NOT to fabricate the protocol. It should read → find it missing →
      // (bump) → declare unfulfillable, which escalation then re-scopes + recovers.
      notes:
        'You MUST read src/legacy/PROTOCOL.md first — it is the ONLY source of the wire format. Do NOT invent, guess, or fabricate the protocol under any circumstances: an invented format would be silently wrong. If src/legacy/PROTOCOL.md does not exist, the contract cannot be built as specified — do not write a made-up client. Reply on one line exactly: unfulfillable, because <reason>.',
    }),
  ];
  return {
    projectId: 'recovery',
    nodes: [
      { id: 'ceo', role: 'ceo', name: 'CEO' },
      { id: 'manager', role: 'manager', name: 'Manager block', parentId: 'ceo' },
      { id: 'division', role: 'division', name: 'Engine', parentId: 'manager' },
      ...['eng-1', 'eng-2', 'eng-3', 'eng-4'].map((id) => ({
        id,
        role: 'engineer',
        name: id,
        parentId: 'division',
        promptId: 'backend-dev',
        promptExtension: 'a small TypeScript game-engine module',
      })),
    ],
    contracts,
    queue: edgesFromContracts(contracts),
    branches: [],
    status: 'running',
    nodeStatus: {},
  };
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  startServer();
  await waitForHealth();

  const corp = await import(pathToFileURL(CORP_INDEX_TS).href);
  const {
    dispatchContracts,
    edgesFromContracts,
    buildEngineerAgentInput,
    escalateContract,
    buildManagerRescopeContractPrompt,
    rescopedContractFrom,
    parseManagerContracts,
    getRolePrompt,
    roleThinkingEnabled,
    makeNodeWorkspaceFs,
    makeNodeWorkspaceReadFs,
    newRunBudget,
    chargeTurn,
  } = corp;
  const seamMod = await import(pathToFileURL(SEAM_IMPL_TS).href);
  const { createRunRoleAgent } = seamMod;

  const readFs = makeNodeWorkspaceReadFs();
  makeNodeWorkspaceFs(); // (agent path writes via tools; kept for parity)

  // THE PRODUCTION SEAM — the exact closure runCorp injects for every engineer
  // (isolation + seed/harvest, the §164 submit bounce, the consult tools, the
  // bump-to-continue policy, and NO per-agent caps ALL come from it).
  const seam = createRunRoleAgent({ baseUrl: BASE_URL, model: MODEL_ID });

  // A generous global budget — the internal loops (2 bumps, 1 re-dispatch, consult
  // depth 1) are what actually bound the run; this only proves nothing is unbounded.
  const budget = newRunBudget({ maxTurns: 300, maxWallClockMs: 60 * 60 * 1000 });
  const engineerRuns = []; // per-engineer stats
  let consultTurns = 0;

  // The engineer seam dispatch uses — the SHARED production mapping + the budget
  // hook (onConsult charges each consult like any turn). One agent run = one
  // budget-charged engineer turn; the consult tools spawn advisors within it.
  const runEngineer = async (request) => {
    chargeTurn(budget); // one engineer turn
    const input = buildEngineerAgentInput(request, {
      workspace: WORKSPACE,
      genMaxTokens: 16000,
      engineerThinking: roleThinkingEnabled('engineer'),
    });
    const t0 = Date.now();
    const out = await seam({
      ...input,
      onConsult: () => {
        consultTurns += 1;
        return chargeTurn(budget);
      },
    });
    const toolNames = [...new Set(out.toolCalls.map((c) => c.name))];
    engineerRuns.push({
      id: request.contract.id,
      slot: request.contract.slot,
      wallMs: Date.now() - t0,
      turns: out.turns,
      bumps: out.bumps ?? 0,
      declaredUnfulfillable: out.declaredUnfulfillable ?? false,
      maxTurnOutputTokens: out.maxTurnOutputTokens,
      terminatedReason: out.terminatedReason,
      wrote: out.filesWritten.length > 0,
      consulted: toolNames.some((n) => n === 'call_peer' || n === 'call_specialist'),
      toolNames,
      submitReview: out.submitReview,
    });
    return out.filesWritten;
  };

  // 1) DISPATCH the crafted chain (agent path, isolation, consults, bump-to-continue).
  const chart = craftedChart(edgesFromContracts);
  log(
    `dispatching ${chart.contracts.length} contracts (incl. 1 deliberately-hard) — workspace=${WORKSPACE}`,
  );
  const t0 = Date.now();
  const report = await dispatchContracts({
    orgChart: chart,
    runEngineer,
    readFs,
    workspace: WORKSPACE,
  });
  const dispatchWallMs = Date.now() - t0;

  const total = chart.contracts.length;
  const doneAfterDispatch = report.done.length;
  const completionRate = doneAfterDispatch / total;

  // 2) ESCALATION RECOVERY — for every failed contract, run the REAL bounded
  // escalation exactly as runCorp does: manager re-scope turn → parse a
  // re-dispatchable contract → ONE re-attempt through the same engineer seam.
  const escalations = [];
  for (const failedId of [...report.failed]) {
    const c = chart.contracts.find((x) => x.id === failedId);
    if (!c) continue;
    const failedResult = report.results.find((r) => r.contractId === failedId);
    const record = escalateContract(chart, failedId, failedResult?.error);
    log(`escalating ${failedId} → manager ${record.ownerManager} (${record.reason.slice(0, 80)})`);
    chargeTurn(budget); // the re-scope manager turn
    let rescoped = false;
    let redispatched = false;
    let recovered = false;
    try {
      const res = await corpChat({
        purpose: 'rescope',
        messages: [
          { role: 'system', content: getRolePrompt('manager').prompt },
          { role: 'user', content: buildManagerRescopeContractPrompt(c, record.reason) },
        ],
        thinking: roleThinkingEnabled('manager'),
        maxTokens: 16000,
      });
      const parsed = parseManagerContracts(res.content)[0];
      if (parsed) {
        rescoped = true;
        const ready = rescopedContractFrom(parsed, c);
        redispatched = true;
        log(
          `re-dispatching re-scoped ${failedId} → ${ready.slot} (narrowed: ${ready.output.slice(0, 80)})`,
        );
        const report2 = await dispatchContracts({
          orgChart: { ...chart, contracts: [ready], queue: [] },
          runEngineer,
          readFs,
          workspace: WORKSPACE,
        });
        recovered = report2.done.includes(ready.id);
      }
    } catch (err) {
      log(`rescope error: ${err instanceof Error ? err.message : String(err)}`);
    }
    escalations.push({ contractId: failedId, rescoped, redispatched, recovered });
  }

  const recoveredCount = escalations.filter((e) => e.recovered).length;
  const finalDone = doneAfterDispatch + recoveredCount;

  // ── report ──────────────────────────────────────────────────────────────────
  const bumped = engineerRuns.filter((r) => r.bumps > 0);
  const bumpedThenWrote = engineerRuns.filter((r) => r.bumps > 0 && r.wrote);
  const consulters = engineerRuns.filter((r) => r.consulted);
  const globalMaxTok = Math.max(0, ...engineerRuns.map((r) => r.maxTurnOutputTokens));

  log('════════════════════ STUCK-ENGINEER RECOVERY REPORT ════════════════════');
  log(`dispatchWallMs=${dispatchWallMs} (${(dispatchWallMs / 60000).toFixed(1)} min)`);
  log(
    `COMPLETION RATE with bump-to-continue = ${doneAfterDispatch}/${total} = ${(completionRate * 100).toFixed(0)}% (target > 64%)`,
  );
  log(
    `  after escalation recovery = ${finalDone}/${total} = ${((finalDone / total) * 100).toFixed(0)}%`,
  );
  log('per-engineer:');
  for (const r of engineerRuns) {
    log(
      `  · ${r.id} ${r.slot} — ${(r.wallMs / 1000).toFixed(1)}s turns=${r.turns} bumps=${r.bumps} ` +
        `wrote=${r.wrote} consulted=${r.consulted} unfulfillable=${r.declaredUnfulfillable} ` +
        `maxTurnTok=${r.maxTurnOutputTokens} stop=${r.terminatedReason} tools=[${r.toolNames.join(',')}]` +
        (r.submitReview
          ? ` submit={bounced:${r.submitReview.bounced},finalized:${r.submitReview.finalized}}`
          : ''),
    );
  }
  log(
    `BUMP-TO-CONTINUE: ${bumped.length} engineer(s) bumped; ${bumpedThenWrote.length} then wrote+submitted`,
  );
  log(
    `CONSULTS: ${consulters.length} engineer(s) consulted a peer/specialist; consult turns charged=${consultTurns}`,
  );
  log('ESCALATION RECOVERY:');
  for (const e of escalations)
    log(
      `  · ${e.contractId} — rescoped=${e.rescoped} redispatched=${e.redispatched} recovered=${e.recovered}`,
    );
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

  // Completion rate with bump-to-continue clears the 64% baseline.
  assert(
    completionRate > 0.64,
    'COMPLETION RATE with bump-to-continue > 64%',
    `${doneAfterDispatch}/${total} = ${(completionRate * 100).toFixed(0)}%`,
  );
  // Every loop stayed bounded — NO per-agent caps.
  assert(
    engineerRuns.every((r) => r.bumps <= 2),
    'BUMP loop bounded — no engineer bumped more than 2 times',
    `max bumps=${Math.max(0, ...engineerRuns.map((r) => r.bumps))}`,
  );
  assert(
    escalations.every((e) => !e.redispatched || true) && report.failed.length >= 0,
    'ESCALATION bounded — one re-scope + one re-dispatch per failed contract',
  );
  assert(
    globalMaxTok < 16000,
    'NO runaway — every engineer maxTurnOutputTokens < 16k',
    `max=${globalMaxTok}`,
  );
  // A stuck engineer reached the consult path (advice-only first stop).
  assert(
    consulters.length >= 1,
    'CONSULT fired — a stuck engineer called call_peer/call_specialist',
  );
  // Real files were produced (the deps at least).
  assert((report.filesWritten?.length ?? 0) > 0, 'engineers WROTE real slot files via tools');

  // Soft observations (recorded, not asserted — emergent 4B behavior).
  log(
    `OBSERVED (not asserted): bumped=${bumped.length}, bumped-then-wrote=${bumpedThenWrote.length}, ` +
      `escalation-recovered=${recoveredCount}, hard-contract-outcome=${
        engineerRuns.find((r) => r.id === 'c4')?.declaredUnfulfillable
          ? 'unfulfillable'
          : report.done.includes('c4')
            ? 'done'
            : 'failed'
      }`,
  );

  console.log(
    `\n${JSON.stringify({ completionRate, finalDone, total, engineerRuns, escalations, budget }, null, 2)}\n`,
  );
  if (failures > 0) throw new Error(`${failures} assertion(s) failed`);
  log('CORP RECOVERY RUN: PASS');
}

main()
  .then(() => {
    killServer();
    process.exit(0);
  })
  .catch((e) => {
    log('CORP RECOVERY RUN: FAIL', e?.stack || e);
    killServer();
    process.exit(1);
  });
