/**
 * REAL-SERVER SMOKE for the corp role-agent runtime
 * (electron/corp/role-agent.ts).
 *
 * Starts the app's own llama-server against the recommended Q8 qwen, then runs
 * the REAL {@link runRoleAgent} on an engineer contract and asserts the
 * productionized behaviour the spike proved:
 *   - the required file is WRITTEN VIA TOOLS (not emitted as parseable text),
 *   - no runaway: maxTurnOutputTokens < 4000,
 *   - a clean stop (terminatedReason === 'stop'),
 *   - the owner sampling params were actually sent (result evidence AND a
 *     server-log cross-check).
 *
 * SKIPS (exit 0) when the model gguf / server binary / chat template is absent,
 * so it is safe in CI. KILLS the server on every exit path — leaves NO orphan.
 *
 * The role-agent module is a TS file loaded directly via Node's TS type-stripping
 * (Node >= 23.6). It has no relative value-imports, so this Just Works.
 *
 * Run:  node tests/e2e/role-agent-smoke.mjs      (after nothing — no build needed)
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HOME = os.homedir();
const SERVER_BIN = `${HOME}/.cache/pi-desktop/llamacpp/b9934/llama-b9934/llama-server`;
const MODEL_GGUF = `${HOME}/.cache/pi-desktop/models/qwen3.5-4b-mtp/Qwen3.5-4B-Q8_0.gguf`;
const CHAT_TEMPLATE = `${HOME}/.cache/pi-desktop/chat-templates/Qwen--Qwen3.5-4B.jinja`;
const HOST = '127.0.0.1';
const PORT = 8172;
const BASE_URL = `http://${HOST}:${PORT}/v1`;
const HEALTH_URL = `http://${HOST}:${PORT}/health`;
const MODEL_ID = 'qwen3.5-4b';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ROLE_AGENT_TS = path.join(appRoot, 'electron', 'corp', 'role-agent.ts');

const RUN_DIR = mkdtempSync(path.join(os.tmpdir(), 'role-agent-smoke-'));
const SERVER_LOG = path.join(RUN_DIR, 'server.log');
const WORKSPACE = path.join(RUN_DIR, 'ws');

function log(...a) {
  console.error(`[${new Date().toISOString()}] ${a.join(' ')}`);
}

// ── preflight: SKIP when the local model isn't available ────────────────────
const missing = [
  [SERVER_BIN, 'llama-server binary'],
  [MODEL_GGUF, 'qwen3.5-4b Q8 gguf'],
  [CHAT_TEMPLATE, 'qwen chat template'],
].filter(([p]) => !existsSync(p));
if (missing.length > 0) {
  for (const [p, what] of missing) log(`SKIP: missing ${what} at ${p}`);
  console.log('ROLE-AGENT SMOKE: SKIPPED (model assets not present)');
  process.exit(0);
}

// ── server lifecycle ────────────────────────────────────────────────────────
let serverProc = null;
function startServer() {
  const args = [
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
  log('starting llama-server:', SERVER_BIN, args.join(' '));
  serverProc = spawn(SERVER_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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

// keep no orphan under any termination path
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

const ENGINEER_SYSTEM_PROMPT = [
  'You are a senior TypeScript engineer working inside an agentic coding harness.',
  'You have file tools (read, write, edit, grep, find, ls) and a bash tool.',
  'Your job: implement the assigned contract by WRITING the required file(s) into the workspace using the `write` tool.',
  'Guidelines:',
  '- Write clean, idiomatic TypeScript with JSDoc. No external dependencies.',
  '- Keep your reasoning and prose focused and short. Do not over-explain.',
  '- STOP as soon as the required file(s) are written. Do not keep iterating.',
].join('\n');

const CONTRACT_TARGET = 'src/util/clamp.ts';
const CONTRACT_PROMPT =
  'Implement src/util/clamp.ts: export a function clamp(n: number, min: number, max: number): number ' +
  'that returns n clamped to the [min, max] range. Add a JSDoc comment. TypeScript, no dependencies.';

const EXPECTED_SAMPLING = {
  temperature: 0.6,
  top_p: 0.95,
  top_k: 20,
  min_p: 0.0,
  presence_penalty: 0.0,
  repetition_penalty: 1.0,
};

let failures = 0;
function assert(cond, label, detail) {
  if (cond) {
    log(`PASS  ${label}`);
  } else {
    failures += 1;
    log(`FAIL  ${label}${detail !== undefined ? ` — ${detail}` : ''}`);
  }
}

async function main() {
  startServer();
  await waitForHealth();

  const mod = await import(pathToFileURL(ROLE_AGENT_TS).href);
  const { createCorpModelProvider, runRoleAgent, SAMPLING_MODES } = mod;

  const handle = await createCorpModelProvider({ baseUrl: BASE_URL, model: MODEL_ID });

  log('running engineer role-agent…');
  const t0 = Date.now();
  const result = await runRoleAgent(handle, {
    purpose: 'engineer',
    systemPrompt: ENGINEER_SYSTEM_PROMPT,
    userPrompt: CONTRACT_PROMPT,
    tools: ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls'],
    cwd: WORKSPACE,
    thinking: true,
    samplingMode: 'thinking-coding',
    timeoutMs: 6 * 60 * 1000,
  });
  const wallMs = Date.now() - t0;

  // ── the report ──
  const fileWritten = result.filesWritten.find((f) => f.path === CONTRACT_TARGET);
  log('─────────────── SMOKE RESULT ───────────────');
  log(`wallMs=${wallMs}`);
  log(`turns=${result.turns}`);
  log(`maxTurnOutputTokens=${result.maxTurnOutputTokens}`);
  log(`terminatedReason=${result.terminatedReason}`);
  log(`toolCalls=${result.toolCalls.map((c) => c.name).join(',') || '(none)'}`);
  log(`filesWritten=${JSON.stringify(result.filesWritten)}`);
  log(`samplingCalls=${result.samplingCalls}`);
  log(`sentSampling=${JSON.stringify(result.sentSampling)}`);
  log(`finalTextHead=${JSON.stringify((result.finalText || '').slice(0, 160))}`);

  // ── assertions ──
  assert(
    fileWritten !== undefined,
    'file written via tools',
    `${CONTRACT_TARGET} not in filesWritten`,
  );
  assert(
    fileWritten !== undefined && fileWritten.bytes > 0,
    'written file is non-empty',
    fileWritten ? `bytes=${fileWritten.bytes}` : 'no file',
  );
  assert(
    result.maxTurnOutputTokens > 0 && result.maxTurnOutputTokens < 4000,
    'no runaway (maxTurnOutputTokens < 4000)',
    `got ${result.maxTurnOutputTokens}`,
  );
  assert(
    result.terminatedReason === 'stop',
    "terminatedReason === 'stop'",
    result.terminatedReason,
  );
  assert(result.samplingCalls > 0, 'sampling hook fired', `samplingCalls=${result.samplingCalls}`);
  assert(
    JSON.stringify(result.sentSampling) === JSON.stringify(EXPECTED_SAMPLING),
    'sampling params sent match thinking-coding',
    JSON.stringify(result.sentSampling),
  );
  assert(
    JSON.stringify(SAMPLING_MODES['thinking-coding']) === JSON.stringify(EXPECTED_SAMPLING),
    'SAMPLING_MODES thinking-coding is the owner profile',
  );

  // ── server-log cross-check: the params reached the server ──
  let serverSaw = false;
  try {
    const logText = readFileSync(SERVER_LOG, 'utf8');
    // llama-server echoes sampler params; presence-penalty 0 + temp 0.6 are ours.
    serverSaw = /top_k\s*=\s*20/.test(logText) && /temp(?:erature)?\s*=\s*0\.6/i.test(logText);
  } catch {}
  // Non-fatal (log format varies across builds); the in-process evidence above is authoritative.
  log(
    `server-log sampler cross-check: ${serverSaw ? 'confirmed' : 'not found in log (non-fatal)'}`,
  );

  if (failures > 0) throw new Error(`${failures} assertion(s) failed`);
  log('ROLE-AGENT SMOKE: PASS');
}

main()
  .then(() => {
    killServer();
    process.exit(0);
  })
  .catch((e) => {
    log('ROLE-AGENT SMOKE: FAIL', e?.stack || e);
    killServer();
    process.exit(1);
  });
