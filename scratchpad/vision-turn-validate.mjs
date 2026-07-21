/**
 * REAL-SERVER VALIDATION for the CEO VISION-FORMING turn (spec §4, §12-Q5, §8).
 *
 * Starts the app's llama-server (Q8 qwen3.5-4b) on :8178 and runs the FULL corp
 * pipeline through the PRODUCTION agent seam (`createRunRoleAgent`) — so the CEO
 * vision turn runs HARNESSED with real tools (read/write/bash + web_search/
 * web_fetch + submit_vision), forms a brief, and the architect + managers build
 * against THAT brief (not the raw task). It wraps the seam to OBSERVE:
 *   - the vision turn ran harnessed, which tools it used, how many turns, files it wrote;
 *   - it terminated by ITS OWN submit (bounded only by the RunBudget — no per-agent cap);
 *   - the architect + managers' user prompts CONTAIN the vision brief (seeded, not raw).
 *
 * KILLS the server on every exit path — no orphan.
 *   node scratchpad/vision-turn-validate.mjs
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
const PORT = 8178;
const BASE_URL = `http://${HOST}:${PORT}/v1`;
const HEALTH_URL = `http://${HOST}:${PORT}/health`;
const MODEL_ID = 'qwen3.5-4b';

const TASK =
  'Build a browser-based personal finance dashboard web app with three distinct parts: a data/storage backend module that records transactions and computes monthly summaries; a frontend dashboard UI with charts and a filterable transaction list; and a budgets module to set per-category spending limits and track them against actuals.';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const SEAM_IMPL_TS = path.join(
  repoRoot,
  'apps',
  'desktop',
  'electron',
  'corp',
  'role-agent-seam-impl.ts',
);
const CORP_INDEX_TS = path.join(repoRoot, 'packages', 'harness', 'src', 'corp', 'index.ts');

const RUN_DIR = mkdtempSync(path.join(os.tmpdir(), 'vision-validate-'));
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
  console.log('VISION TURN VALIDATION: SKIPPED (model assets not present)');
  process.exit(0);
}

// ── server lifecycle ──────────────────────────────────────────────────────────
let serverProc = null;
function startServer() {
  const a = [
    '-m', MODEL_GGUF,
    '--host', HOST,
    '--port', String(PORT),
    '-c', '16384',
    '--parallel', '1',
    '--spec-type', 'draft-mtp',
    '--spec-draft-n-max', '2',
    '--jinja',
    '--chat-template-file', CHAT_TEMPLATE,
  ];
  log('starting llama-server:', SERVER_BIN, a.join(' '));
  serverProc = spawn(SERVER_BIN, a, { stdio: ['ignore', 'pipe', 'pipe'] });
  const append = (d) => {
    try { appendFileSync(SERVER_LOG, d); } catch {}
  };
  serverProc.stdout.on('data', append);
  serverProc.stderr.on('data', append);
  serverProc.on('exit', (code, sig) => log(`llama-server exited code=${code} sig=${sig}`));
}
function killServer() {
  if (serverProc && !serverProc.killed) {
    log('killing llama-server pid', serverProc.pid);
    try { serverProc.kill('SIGKILL'); } catch {}
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
  process.on(sig, () => { killServer(); process.exit(1); });
process.on('uncaughtException', (e) => { log('uncaughtException', e?.stack || e); killServer(); process.exit(1); });

// ── streaming chat seam (used only for the escalation rescope turn here) ─────
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
      try { evt = JSON.parse(data); } catch { continue; }
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

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  startServer();
  await waitForHealth();

  const corp = await import(pathToFileURL(CORP_INDEX_TS).href);
  const { runCorp, makeNodeWorkspaceFs, makeNodeWorkspaceReadFs, newRunBudget } = corp;
  const { createRunRoleAgent } = await import(pathToFileURL(SEAM_IMPL_TS).href);

  // Import web-tools' SEARCH module directly (by path) — it is strip-safe (unlike the
  // package barrel, which pulls in python.ts's non-strippable syntax). Build a live
  // web_search registrar to INJECT (webResearchFactory), exactly as the app injects
  // registerWebTools — proving the vision turn gets a real, callable web_search.
  const SEARCH_TS = path.join(repoRoot, 'packages', 'web-tools', 'src', 'search.ts');
  const search = await import(pathToFileURL(SEARCH_TS).href);
  const backends = search.resolveSearchBackends(search.webSearchConfigFromEnv());
  const webResearchFactory = (pi) => {
    pi.registerTool({
      name: 'web_search',
      label: 'Web Search',
      description:
        'Search the web. Returns a ranked list of results with title, URL, and snippet.',
      promptSnippet: 'Search the web for up-to-date information',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          count: { type: 'number', description: 'Max results (default 8, max 20)' },
        },
        required: ['query'],
      },
      async execute(_id, params, signal) {
        const outcome = await search.runWebSearch(backends, params.query, {
          count: search.boundCount(params.count),
          signal,
        });
        const lines = outcome.results.map(
          (r, i) => `[${i + 1}] ${r.title}\n    ${r.url}\n    ${r.snippet}`,
        );
        const header =
          outcome.results.length > 0
            ? `${outcome.results.length} result(s) via ${outcome.backend}`
            : `No results (via ${outcome.backend}).`;
        const text = `${header}\n\n${lines.join('\n\n')}`.trim();
        return {
          content: [{ type: 'text', text }],
          details: { backend: outcome.backend, count: outcome.results.length },
        };
      },
    });
  };

  const baseSeam = createRunRoleAgent({ baseUrl: BASE_URL, model: MODEL_ID, webResearchFactory });

  // WRAP the production seam to OBSERVE the vision turn (and the downstream inputs).
  const seen = { vision: null, architect: null, managers: [] };
  const seam = async (input) => {
    const t0 = Date.now();
    const out = await baseSeam(input);
    if (input.purpose === 'vision') {
      seen.vision = {
        wallMs: Date.now() - t0,
        turns: out.turns,
        toolsUsed: [...new Set(out.toolCalls.map((c) => c.name))],
        submittedVision: out.toolCalls.some((c) => c.name === 'submit_vision'),
        filesWritten: out.filesWritten.map((f) => ({ path: f.path, bytes: f.bytes })),
        isolationHarvest: input.isolation?.harvest,
        allowlist: input.tools,
        hasPerAgentCap: 'maxSteps' in input || 'timeoutMs' in input,
        terminatedReason: out.terminatedReason,
        finalTextPreview: (out.finalText ?? '').slice(0, 300),
      };
    } else if (input.purpose === 'architect') {
      seen.architect = { userPrompt: input.userPrompt };
    } else if (input.purpose === 'manager') {
      seen.managers.push({ userPrompt: input.userPrompt });
    }
    return out;
  };

  const budget = newRunBudget({ maxTurns: 200, maxWallClockMs: 45 * 60 * 1000 });

  log('running corp — task:', TASK);
  const t0 = Date.now();
  const result = await runCorp({
    task: TASK,
    chat: corpChat,
    runRoleAgent: seam,
    fs: makeNodeWorkspaceFs(),
    readFs: makeNodeWorkspaceReadFs(),
    workspace: WORKSPACE,
    limit: 1, // keep the run bounded — the vision turn + brief-seeding is what we validate
    maxRevisions: 0,
    budget,
    log: (m) => log('  corp:', m),
  });
  const wallMs = Date.now() - t0;

  // Probe web-search availability directly (independent of whether the model chose it).
  let webSearchAvailable = false;
  let webSearchNote = '';
  try {
    const probe = await search.runWebSearch(backends, 'pomodoro timer web app design', {
      count: 3,
    });
    // Availability = a backend was REACHED (the probe returned without throwing).
    // A zero-result page is still "available" (DDG may rate-limit automated probes).
    webSearchAvailable = true;
    webSearchNote = `backend=${probe.backend}, results=${probe.results.length}${probe.note ? `, note=${probe.note}` : ''}`;
  } catch (err) {
    webSearchNote = `probe failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  // ── report ──────────────────────────────────────────────────────────────────
  const v = seen.vision;
  const brief = result.vision?.brief ?? '';
  const briefInArchitect = seen.architect && brief !== '' && seen.architect.userPrompt.includes(brief);
  const briefInManagers =
    seen.managers.length > 0 && brief !== '' &&
    seen.managers.every((m) => m.userPrompt.includes(brief));

  log('══════════════════════ CEO VISION TURN REPORT ══════════════════════');
  log(`total wall = ${(wallMs / 60000).toFixed(1)} min; terminatedReason=${result.terminatedReason}`);
  log(`vision RAN harnessed = ${v !== null}`);
  if (v) {
    log(`  vision wall = ${(v.wallMs / 1000).toFixed(1)}s, turns=${v.turns}, terminatedReason=${v.terminatedReason}`);
    log(`  tools available (allowlist) = [${v.allowlist.join(', ')}]`);
    log(`  tools USED = [${v.toolsUsed.join(', ')}]`);
    log(`  submitted via submit_vision = ${v.submittedVision}`);
    log(`  mockup/scratch files written = ${v.filesWritten.length} ${JSON.stringify(v.filesWritten)}`);
    log(`  scratch isolation harvest = ${v.isolationHarvest} (false = mockup NOT in product tree)`);
    log(`  per-agent cap present = ${v.hasPerAgentCap} (expected false — bounded only by RunBudget)`);
  }
  log(`vision brief (formed by the CEO):\n${brief}`);
  log(`architect built against the vision brief = ${briefInArchitect}`);
  log(`managers built against the vision brief = ${briefInManagers} (${seen.managers.length} manager turn(s))`);
  log(`divisions = [${result.divisions.join(', ')}]; totalContracts=${result.totalContracts}; dispatched=${result.contractsDispatched}`);
  log(`web_search WIRED into vision allowlist = ${v?.allowlist.includes('web_search') ?? false}`);
  log(`web_search available (direct probe) = ${webSearchAvailable} (${webSearchNote})`);
  log(`budget: turnsUsed=${result.budget.turnsUsed}/${result.budget.maxTurns}, exceeded=${result.budget.exceeded}`);

  // ── assertions ────────────────────────────────────────────────────────────────
  let failures = 0;
  const assert = (cond, label, detail) => {
    if (cond) log(`PASS  ${label}`);
    else { failures++; log(`FAIL  ${label}${detail !== undefined ? ` — ${detail}` : ''}`); }
  };
  assert(v !== null, 'the CEO vision turn RAN through the harnessed seam');
  assert(
    v && v.allowlist.includes('web_search') && v.allowlist.includes('write') && v.allowlist.includes('submit_vision'),
    'vision allowlist exposes research (web_search) + draft (write) + submit_vision',
  );
  assert(v && v.isolationHarvest === false, 'vision ran in a SCRATCH workspace (harvest off — no product pollution)');
  assert(v && v.hasPerAgentCap === false, 'NO per-agent cap on the vision turn (bounded only by the RunBudget)');
  assert(brief.trim().length > 0, 'the CEO produced a non-empty vision brief', `brief len=${brief.length}`);
  assert(result.vision?.usedRawTask === false, 'the run used the CEO vision brief (not the raw task)');
  assert(briefInArchitect === true, 'the ARCHITECT built against the vision brief (not the raw task)');
  assert(briefInManagers === true, 'the MANAGERS built against the vision brief (not the raw task)');
  assert(webSearchAvailable === true, 'web_search is AVAILABLE (direct probe reached a backend)', webSearchNote);

  console.log(`\n${JSON.stringify({
    terminatedReason: result.terminatedReason,
    vision: { ...v, brief },
    divisions: result.divisions,
    totalContracts: result.totalContracts,
    contractsDispatched: result.contractsDispatched,
    briefSeededArchitect: briefInArchitect,
    briefSeededManagers: briefInManagers,
    webSearch: { wiredInAllowlist: v?.allowlist.includes('web_search') ?? false, available: webSearchAvailable, note: webSearchNote },
    budget: result.budget,
    workspace: WORKSPACE,
  }, null, 2)}\n`);

  if (failures > 0) throw new Error(`${failures} assertion(s) failed`);
  log('VISION TURN VALIDATION: PASS');
}

main()
  .then(() => { killServer(); process.exit(0); })
  .catch((e) => { log('VISION TURN VALIDATION: FAIL', e?.stack || e); killServer(); process.exit(1); });
