/**
 * REAL-SERVER VALIDATION for Phase-2 ALL-ROLES-as-agents.
 *
 * Starts the app's own llama-server (Q8 qwen3.5-4b) and drives the FULL corp
 * pipeline (promotion → architect → managers → DISPATCH → CEO sign-off) on the
 * Three.js task, with EVERY corp role wired to run as a real pi AgentSession (the
 * app's `runRoleAgent` impl adapting electron/corp/role-agent.ts) instead of a
 * bare completion: the worker calls the promotion tool, the architect + managers
 * emit their structured JSON thinking-off, engineers write files with tools, and
 * the CEO reviews the product with read + bash. The chat seam remains only as the
 * fallback (rescope).
 *
 * Asserts/reports the productionized behaviour PER ROLE: ran-as-agent, turn count,
 * max single-turn output tokens (must be well under the 16k context — NO runaway on
 * ANY role), terminatedReason distribution, engineers WRITE via tools + READ deps +
 * bash SELF-CHECK, and that the whole pipeline completed (promotion → architecture
 * parsed → contracts parsed → engineers wrote files → CEO decision).
 *
 * KILLS the server on every exit path — no orphan.
 *
 *   node tests/e2e/corp-engineer-agent-run.mjs [--limit 8]
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
const PORT = 8173;
const BASE_URL = `http://${HOST}:${PORT}/v1`;
const HEALTH_URL = `http://${HOST}:${PORT}/health`;
const MODEL_ID = 'qwen3.5-4b';

const args = process.argv.slice(2);
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx >= 0 && args[limitIdx + 1] ? Number(args[limitIdx + 1]) : 8;

const TASK =
  'Build a production-ready 3D browser game using Three.js and TypeScript. ' +
  'It should have a start menu, multiple levels, a scoring system, and sound effects.';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(appRoot, '../..');
const SEAM_IMPL_TS = path.join(appRoot, 'electron', 'corp', 'role-agent-seam-impl.ts');
const CORP_INDEX_TS = path.join(repoRoot, 'packages', 'harness', 'src', 'corp', 'index.ts');

const RUN_DIR = mkdtempSync(path.join(os.tmpdir(), 'corp-eng-agent-'));
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
  console.log('CORP ENGINEER-AGENT RUN: SKIPPED (model assets not present)');
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

// ── streaming chat seam (non-engineer turns) ─────────────────────────────────
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
  const msg = { content: '', tool_calls: [] };
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
      if (!d) continue;
      if (typeof d.content === 'string') msg.content += d.content;
      if (Array.isArray(d.tool_calls))
        for (const tc of d.tool_calls) {
          const i = typeof tc.index === 'number' ? tc.index : msg.tool_calls.length;
          msg.tool_calls[i] ??= { function: { name: '', arguments: '' } };
          if (tc.function?.name) msg.tool_calls[i].function.name += tc.function.name;
          if (tc.function?.arguments) msg.tool_calls[i].function.arguments += tc.function.arguments;
        }
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
    ...(req.tools ? { tools: req.tools, tool_choice: 'auto' } : {}),
    temperature: 0.7,
    max_tokens: req.maxTokens,
    ...thinkingBody(req.thinking),
  });
  const toolCalls = (msg.tool_calls || [])
    .filter(Boolean)
    .map((tc) => ({ name: tc.function?.name ?? '', arguments: tc.function?.arguments ?? '' }));
  return { content: msg.content ?? '', ...(toolCalls.length ? { toolCalls } : {}) };
};

// ── main ──────────────────────────────────────────────────────────────────────
const roleRuns = []; // per-role-agent-run stats (worker/architect/manager/engineer/ceo)

async function main() {
  startServer();
  await waitForHealth();

  const corp = await import(pathToFileURL(CORP_INDEX_TS).href);
  const { runCorp, makeNodeWorkspaceFs, makeNodeWorkspaceReadFs } = corp;
  const seamMod = await import(pathToFileURL(SEAM_IMPL_TS).href);
  const { createRunRoleAgent } = seamMod;

  // THE PRODUCTION SEAM — the exact closure runCorp injects for every role (engineer
  // isolation + seed/harvest, the §164 submit_contract bounce, and NO per-agent
  // caps all come from it). Wrapped to record per-role stats.
  const seam = createRunRoleAgent({ baseUrl: BASE_URL, model: MODEL_ID });
  const slotOf = (userPrompt) => {
    const m = /THIS exact path\):\s*(\S+)/.exec(userPrompt);
    return m ? m[1] : '(unknown)';
  };
  // A human label per role for the report (engineer → its slot; manager → its
  // division; others → the purpose).
  const labelOf = (input) => {
    if (input.purpose === 'engineer') return slotOf(input.userPrompt);
    if (input.purpose === 'manager') {
      const m = /Division:\s*(.+)/.exec(input.userPrompt);
      return `manager:${m ? m[1].trim() : '?'}`;
    }
    return input.purpose;
  };
  const runRoleAgentSeam = async (input) => {
    const t0 = Date.now();
    const result = await seam(input); // the production seam (isolation + §164 + no caps)
    const wallMs = Date.now() - t0;
    const toolNames = [...new Set(result.toolCalls.map((c) => c.name))];
    roleRuns.push({
      purpose: input.purpose,
      label: labelOf(input),
      wallMs,
      turns: result.turns,
      maxTurnOutputTokens: result.maxTurnOutputTokens,
      terminatedReason: result.terminatedReason,
      toolNames,
      readDeps: toolNames.includes('read'),
      selfChecked: toolNames.includes('bash'),
      submitReview: result.submitReview,
      filesWritten: result.filesWritten.map((f) => ({ path: f.path, bytes: f.bytes })),
    });
    return result;
  };

  log(`driving corp — task="Three.js game", limit=${LIMIT}, workspace=${WORKSPACE}`);
  const t0 = Date.now();
  const result = await runCorp({
    task: TASK,
    chat: corpChat,
    runRoleAgent: runRoleAgentSeam,
    fs: makeNodeWorkspaceFs(),
    readFs: makeNodeWorkspaceReadFs(),
    workspace: WORKSPACE,
    limit: LIMIT,
    log: (m) => log('[corp]', m),
  });
  const totalWallMs = Date.now() - t0;

  // ── report ── every corp role now runs harnessed through the seam; report and
  // assert PER ROLE (worker / architect / each manager / each engineer / CEO).
  const byPurpose = (p) => roleRuns.filter((r) => r.purpose === p);
  const engineerRuns = byPurpose('engineer');
  const globalMaxTok = Math.max(0, ...roleRuns.map((r) => r.maxTurnOutputTokens));
  const allBounded = roleRuns.every((r) => r.maxTurnOutputTokens < 16000);
  const runaways = roleRuns.filter((r) => r.maxTurnOutputTokens >= 16000);
  const reasons = {};
  for (const r of roleRuns) reasons[r.terminatedReason] = (reasons[r.terminatedReason] ?? 0) + 1;

  log('════════════════════ CORP ALL-ROLES-AGENT RUN REPORT ════════════════════');
  log(`totalWallMs=${totalWallMs} (${(totalWallMs / 60000).toFixed(1)} min)`);
  log(`terminatedReason(run)=${result.terminatedReason}, promoted=${result.promoted}`);
  log(`divisions=${JSON.stringify(result.divisions)} totalContracts=${result.totalContracts}`);
  log(
    `architecture: moduleCount=${result.architecture?.moduleCount ?? 0} interfaceCount=${result.architecture?.interfaceCount ?? 0}`,
  );
  log(`ceoDecision=${JSON.stringify(result.ceoDecision)}`);
  log(
    `total role-agent turns=${roleRuns.length}; terminatedReason distribution=${JSON.stringify(reasons)}`,
  );
  log(
    `GLOBAL max single-turn output tokens across ALL roles=${globalMaxTok} (bounded<16k: ${allBounded})`,
  );
  // Per-role roll-up: ran-as-agent count, turns, max single-turn tokens, stop reasons.
  for (const purpose of ['worker', 'architect', 'manager', 'engineer', 'ceo', 'revise']) {
    const runs = byPurpose(purpose);
    if (runs.length === 0) continue;
    const rMax = Math.max(0, ...runs.map((r) => r.maxTurnOutputTokens));
    const rReasons = {};
    for (const r of runs) rReasons[r.terminatedReason] = (rReasons[r.terminatedReason] ?? 0) + 1;
    log(
      `  [${purpose}] ran-as-agent=${runs.length}, maxTurnTok=${rMax} (<16k: ${rMax < 16000}), ` +
        `stops=${JSON.stringify(rReasons)}`,
    );
  }
  log('per-turn detail:');
  for (const r of roleRuns) {
    log(
      `  · ${r.label} [${r.purpose}] — ${(r.wallMs / 1000).toFixed(1)}s, turns=${r.turns}, ` +
        `maxTurnTok=${r.maxTurnOutputTokens}, stop=${r.terminatedReason}, tools=[${r.toolNames.join(',')}]` +
        (r.filesWritten.length
          ? `, files=${r.filesWritten.map((f) => `${f.path.replace(`${WORKSPACE}/`, '')}(${f.bytes}B)`).join(', ')}`
          : ''),
    );
  }
  log('dispatchReport contract results:');
  log(`  dispatched=${result.contractsDispatched} failures=${JSON.stringify(result.failures)}`);

  // ── assertions ── the pipeline completed end-to-end AND no role ran away.
  const engReadCount = engineerRuns.filter((r) => r.readDeps).length;
  const engBashCount = engineerRuns.filter((r) => r.selfChecked).length;
  const engWroteCount = engineerRuns.filter((r) => r.filesWritten.length > 0).length;
  const engStops = engineerRuns.filter((r) => r.terminatedReason === 'stop').length;
  log(
    `engineer write rate=${engWroteCount}/${engineerRuns.length}, read=${engReadCount}, bash=${engBashCount}, cleanStop=${engStops}`,
  );
  let failures = 0;
  const assert = (cond, label, detail) => {
    if (cond) log(`PASS  ${label}`);
    else {
      failures++;
      log(`FAIL  ${label}${detail !== undefined ? ` — ${detail}` : ''}`);
    }
  };
  // Each role ran AS AN AGENT (went through the seam).
  assert(byPurpose('worker').length >= 1, 'WORKER ran as an agent');
  assert(byPurpose('architect').length >= 1, 'ARCHITECT ran as an agent');
  assert(byPurpose('manager').length >= 1, 'each MANAGER ran as an agent');
  assert(engineerRuns.length > 0, 'ENGINEERS ran as agents');
  assert(byPurpose('ceo').length >= 1, 'CEO ran as an agent');
  // No runaway on ANY role.
  assert(
    allBounded,
    'no runaway — EVERY role maxTurnOutputTokens < 16k',
    runaways.length
      ? runaways.map((r) => `${r.purpose}=${r.maxTurnOutputTokens}`).join(',')
      : `max=${globalMaxTok}`,
  );
  // The full pipeline completed: promotion → architecture → contracts → files → CEO.
  assert(result.promoted === true, 'PROMOTION: task promoted to a corporation');
  assert(
    result.architecture !== undefined,
    'ARCHITECTURE parsed from the architect agent',
    JSON.stringify(result.architecture),
  );
  assert(
    result.totalContracts > 0,
    'CONTRACTS parsed from the manager agents',
    `n=${result.totalContracts}`,
  );
  // Pipeline-completion bar (per the task): engineers WROTE files via tools — i.e.
  // real files were produced (not that EVERY engineer succeeded; a 4B model's
  // per-engineer write rate is inherently below 1.0, and the failed contracts are
  // finite, escalated, and honestly surfaced to the CEO).
  assert(
    engWroteCount > 0 && (result.manifest?.fileCount ?? 0) > 0,
    'ENGINEERS wrote slot files via tools (files produced)',
    `wrote=${engWroteCount}/${engineerRuns.length}, files=${result.manifest?.fileCount ?? 0}`,
  );
  assert(
    result.ceoDecision !== undefined,
    'CEO produced a decision',
    JSON.stringify(result.ceoDecision),
  );
  // Engineer quality signals (agentic behaviour).
  assert(engReadCount > 0, 'engineers READ dependency files via tools', `read=${engReadCount}`);
  assert(engBashCount > 0, 'engineers ran a bash SELF-CHECK', `bash=${engBashCount}`);
  assert(
    engStops >= Math.ceil(engineerRuns.length / 2),
    'majority of engineers reached a clean stop',
    `stops=${engStops}/${engineerRuns.length}`,
  );

  console.log(`\n${JSON.stringify({ roleRuns, result }, null, 2)}\n`);
  if (failures > 0) throw new Error(`${failures} assertion(s) failed`);
  log('CORP ALL-ROLES-AGENT RUN: PASS');
}

main()
  .then(() => {
    killServer();
    process.exit(0);
  })
  .catch((e) => {
    log('CORP ENGINEER-AGENT RUN: FAIL', e?.stack || e);
    killServer();
    process.exit(1);
  });
