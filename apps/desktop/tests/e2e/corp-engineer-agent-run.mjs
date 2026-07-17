/**
 * REAL-SERVER VALIDATION for Phase-2 engineers-as-agents.
 *
 * Starts the app's own llama-server (Q8 qwen3.5-4b) and drives the FULL corp
 * pipeline (promotion → architect → managers → DISPATCH) on the Three.js task,
 * with the ENGINEER role wired to run as a real pi AgentSession (the app's
 * `runRoleAgent` impl adapting electron/corp/role-agent.ts) instead of a bare
 * completion. Non-engineer turns use the streaming chat seam.
 *
 * Asserts/reports the productionized behaviour: files WRITTEN VIA TOOLS (list +
 * bytes), per-contract max single-turn output tokens (must be well under the 16k
 * context — no runaway), per-contract wall time, terminatedReason distribution,
 * and that engineers READ their deps + ran a bash SELF-CHECK.
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
const ROLE_AGENT_TS = path.join(appRoot, 'electron', 'corp', 'role-agent.ts');
const CORP_INDEX_TS = path.join(repoRoot, 'packages', 'harness', 'src', 'corp', 'index.ts');

const RUN_DIR = mkdtempSync(path.join(os.tmpdir(), 'corp-eng-agent-'));
const SERVER_LOG = path.join(RUN_DIR, 'server.log');
const WORKSPACE = path.join(RUN_DIR, 'ws');
mkdirSync(WORKSPACE, { recursive: true });

function log(...a) {
  console.error(`[${new Date().toISOString()}] ${a.join(' ')}`);
}

// The corp TS sources use `.js` specifiers that resolve to `.ts`; retry .js → .ts.
const tsResolveHook = `
export async function resolve(specifier, context, next) {
  if (/^(\\.\\.?\\/|\\/)/.test(specifier) && specifier.endsWith('.js')) {
    try { return await next(specifier, context); }
    catch (err) {
      if (err && err.code === 'ERR_MODULE_NOT_FOUND') return next(specifier.slice(0, -3) + '.ts', context);
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
const engineerRuns = []; // per-engineer-run stats

async function main() {
  startServer();
  await waitForHealth();

  const corp = await import(pathToFileURL(CORP_INDEX_TS).href);
  const { runCorp, makeNodeWorkspaceFs, makeNodeWorkspaceReadFs } = corp;
  const ra = await import(pathToFileURL(ROLE_AGENT_TS).href);
  const { createCorpModelProvider, runRoleAgent } = ra;

  // The APP's runRoleAgent seam impl (adapting role-agent.ts), instrumented to
  // record per-contract stats.
  const handle = createCorpModelProvider({ baseUrl: BASE_URL, model: MODEL_ID });
  const slotOf = (userPrompt) => {
    const m = /THIS exact path\):\s*(\S+)/.exec(userPrompt);
    return m ? m[1] : '(unknown)';
  };
  const runRoleAgentSeam = async (input) => {
    const t0 = Date.now();
    const result = await runRoleAgent(handle, {
      purpose: input.purpose,
      systemPrompt: input.systemPrompt,
      userPrompt: input.userPrompt,
      tools: [...input.tools],
      cwd: input.cwd,
      thinking: input.thinking,
      samplingMode: input.samplingMode,
      ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
      ...(input.maxSteps !== undefined ? { maxSteps: input.maxSteps } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    });
    const wallMs = Date.now() - t0;
    const toolNames = [...new Set(result.toolCalls.map((c) => c.name))];
    engineerRuns.push({
      slot: slotOf(input.userPrompt),
      wallMs,
      turns: result.turns,
      maxTurnOutputTokens: result.maxTurnOutputTokens,
      terminatedReason: result.terminatedReason,
      toolNames,
      readDeps: toolNames.includes('read'),
      selfChecked: toolNames.includes('bash'),
      filesWritten: result.filesWritten.map((f) => ({ path: f.path, bytes: f.bytes })),
    });
    return {
      filesWritten: result.filesWritten.map((f) => ({ path: f.path, bytes: f.bytes })),
      finalText: result.finalText,
      toolCalls: result.toolCalls.map((c) => ({ name: c.name, arguments: c.arguments })),
      terminatedReason: result.terminatedReason,
      maxTurnOutputTokens: result.maxTurnOutputTokens,
      turns: result.turns,
    };
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

  // ── report ──
  const reasons = {};
  for (const r of engineerRuns)
    reasons[r.terminatedReason] = (reasons[r.terminatedReason] ?? 0) + 1;
  const maxTok = Math.max(0, ...engineerRuns.map((r) => r.maxTurnOutputTokens));
  const allBounded = engineerRuns.every((r) => r.maxTurnOutputTokens < 16000);
  const allWroteSlot = engineerRuns.every((r) => r.filesWritten.length > 0);
  const readCount = engineerRuns.filter((r) => r.readDeps).length;
  const bashCount = engineerRuns.filter((r) => r.selfChecked).length;

  log('════════════════════ ENGINEER-AGENT RUN REPORT ════════════════════');
  log(`totalWallMs=${totalWallMs} (${(totalWallMs / 60000).toFixed(1)} min)`);
  log(`terminatedReason(run)=${result.terminatedReason}, promoted=${result.promoted}`);
  log(`divisions=${JSON.stringify(result.divisions)} totalContracts=${result.totalContracts}`);
  log(`engineersDispatched=${engineerRuns.length} (limit ${LIMIT})`);
  log(`per-engineer terminatedReason distribution=${JSON.stringify(reasons)}`);
  log(`max single-turn output tokens across engineers=${maxTok} (bounded<16k: ${allBounded})`);
  log(
    `engineers that read deps=${readCount}/${engineerRuns.length}, bash self-checked=${bashCount}/${engineerRuns.length}`,
  );
  for (const r of engineerRuns) {
    log(
      `  · ${r.slot} — ${(r.wallMs / 1000).toFixed(1)}s, turns=${r.turns}, maxTurnTok=${r.maxTurnOutputTokens}, ` +
        `stop=${r.terminatedReason}, tools=[${r.toolNames.join(',')}], files=${r.filesWritten
          .map((f) => `${f.path.replace(`${WORKSPACE}/`, '')}(${f.bytes}B)`)
          .join(', ')}`,
    );
  }
  log('dispatchReport contract results:');
  log(`  done=${result.contractsDispatched} failures=${JSON.stringify(result.failures)}`);

  // ── assertions ──
  let failures = 0;
  const assert = (cond, label, detail) => {
    if (cond) log(`PASS  ${label}`);
    else {
      failures++;
      log(`FAIL  ${label}${detail !== undefined ? ` — ${detail}` : ''}`);
    }
  };
  assert(result.promoted === true, 'task promoted to a corporation');
  assert(engineerRuns.length > 0, 'at least one engineer ran as an agent');
  assert(allWroteSlot, 'every engineer WROTE its slot file via tools');
  assert(allBounded, 'no runaway — every engineer maxTurnOutputTokens < 16k', `max=${maxTok}`);
  assert(readCount > 0, 'engineers READ dependency files via tools', `read=${readCount}`);
  assert(bashCount > 0, 'engineers ran a bash SELF-CHECK', `bash=${bashCount}`);
  assert(
    (reasons.stop ?? 0) >= Math.ceil(engineerRuns.length / 2),
    'majority of engineers reached a clean stop',
    JSON.stringify(reasons),
  );

  console.log(`\n${JSON.stringify({ engineerRuns, result }, null, 2)}\n`);
  if (failures > 0) throw new Error(`${failures} assertion(s) failed`);
  log('CORP ENGINEER-AGENT RUN: PASS');
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
