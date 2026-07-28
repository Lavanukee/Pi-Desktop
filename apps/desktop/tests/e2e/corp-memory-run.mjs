/**
 * A8 — THE MEMORY GATE. Does a corp role actually remember, with nothing replayed?
 *
 * This is the acceptance test for the whole persistent-session rebuild, and it is
 * deliberately the smallest possible experiment: open ONE agent, tell it a fact in
 * message 1, ask for that fact back in message 2, and check the answer. Nothing is
 * replayed into the second prompt — if the agent gets it right, its session really
 * did stay alive.
 *
 * Then the harder half: EVICT it (close the session entirely), talk to it again,
 * and ask a third time. That answer can only come from the session FILE on disk,
 * which is what makes "improve the SFX" reach the same engineer next week.
 *
 *   node tests/e2e/corp-memory-run.mjs
 *
 * Exits non-zero if the agent forgets. Kills the server on every path.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HOME = os.homedir();
const SERVER_BIN = `${HOME}/.cache/pi-desktop/llamacpp/b9934/llama-b9934/llama-server`;
const MODEL_GGUF = `${HOME}/.cache/pi-desktop/models/qwen3.5-4b-mtp/Qwen3.5-4B-Q8_0.gguf`;
const CHAT_TEMPLATE = `${HOME}/.cache/pi-desktop/chat-templates/Qwen--Qwen3.5-4B.jinja`;
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT ?? 8176);
const BASE_URL = `http://${HOST}:${PORT}/v1`;
const MODEL_ID = 'qwen3.5-4b';

/** A word the model cannot have guessed — the whole test is whether it comes back. */
const SECRET = 'PLATINUM-OTTER-4417';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ROLE_AGENT_TS = path.join(appRoot, 'electron', 'corp', 'role-agent.ts');
const POOL_TS = path.join(appRoot, 'electron', 'corp', 'agent-pool.ts');

const RUN_DIR = process.env.RUN_DIR ?? mkdtempSync(path.join(os.tmpdir(), 'corp-mem-'));
const SERVER_LOG = path.join(RUN_DIR, 'server.log');
const WS = path.join(RUN_DIR, 'ws');
mkdirSync(WS, { recursive: true });

const t0 = Date.now();
const log = (...a) => console.error(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${a.join(' ')}`);

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

for (const [p, what] of [
  [SERVER_BIN, 'llama-server'],
  [MODEL_GGUF, 'model gguf'],
  [CHAT_TEMPLATE, 'chat template'],
]) {
  if (!existsSync(p)) {
    log(`SKIP: missing ${what}`);
    console.log('CORP MEMORY RUN: SKIPPED');
    process.exit(0);
  }
}

let serverProc = null;
const killServer = () => {
  if (serverProc && !serverProc.killed) {
    try {
      serverProc.kill('SIGKILL');
    } catch {}
  }
};
process.on('uncaughtException', (e) => {
  log('uncaught', e?.stack || e);
  killServer();
  process.exit(1);
});
for (const s of ['SIGINT', 'SIGTERM'])
  process.on(s, () => {
    killServer();
    process.exit(1);
  });

async function main() {
  serverProc = spawn(
    SERVER_BIN,
    // prettier-ignore
    ['-m', MODEL_GGUF, '--host', HOST, '--port', String(PORT), '-c', '32768',
     '--parallel', '1', '--jinja', '--chat-template-file', CHAT_TEMPLATE],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const append = (d) => {
    try {
      appendFileSync(SERVER_LOG, d);
    } catch {}
  };
  serverProc.stdout.on('data', append);
  serverProc.stderr.on('data', append);

  const deadline = Date.now() + 180_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error('server never became healthy');
    try {
      const r = await fetch(`http://${HOST}:${PORT}/health`);
      if (r.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 750));
  }
  log('server healthy');

  const roleMod = await import(pathToFileURL(ROLE_AGENT_TS).href);
  const poolMod = await import(pathToFileURL(POOL_TS).href);
  const handle = await roleMod.createCorpModelProvider({ baseUrl: BASE_URL, model: MODEL_ID });

  const pool = new poolMod.AgentPool({ handle, projectDir: WS });
  const spec = {
    purpose: 'engineer',
    systemPrompt:
      'You are an engineer on a small team. Answer briefly and directly. When asked to ' +
      'remember something, remember it exactly.',
    tools: ['read'],
    cwd: WS,
    thinking: false,
    samplingMode: 'instruct-general',
  };

  const failures = [];
  const check = (label, reply, ok) => {
    console.log(`\n${label}\n  reply: ${reply.replace(/\s+/g, ' ').slice(0, 220)}`);
    console.log(`  ${ok ? 'PASS' : 'FAIL'}`);
    if (!ok) failures.push(label);
  };

  // 1. Tell it the secret.
  const first = await pool.talk(
    'engineer:1',
    spec,
    `Please remember this project codename exactly: ${SECRET}. Just confirm you have it.`,
  );
  log(`told it the codename (${first.finalText.length} chars back)`);

  // 2. Ask for it back — NOTHING about the first exchange is in this prompt.
  const second = await pool.talk(
    'engineer:1',
    spec,
    'What is the project codename I gave you? Reply with just the codename.',
  );
  check('LIVE SESSION — remembers across turns with nothing replayed', second.finalText,
    second.finalText.includes(SECRET));

  // 3. The hard half: close the session entirely, then ask again. Only the file
  //    on disk can answer this — which is what makes a team survive a restart.
  const sessionFile = pool.sessionFile('engineer:1');
  console.log(`\n  session file: ${sessionFile ?? '(none — NOT PERSISTED)'}`);
  if (sessionFile === undefined || !existsSync(sessionFile)) {
    failures.push('no session file was written');
  } else {
    const bytes = readFileSync(sessionFile, 'utf8').length;
    console.log(`  session file holds ${bytes} bytes of conversation`);
    if (!readFileSync(sessionFile, 'utf8').includes(SECRET)) {
      failures.push('the session file does not contain the conversation');
    }
  }

  pool.evict('engineer:1');
  console.log(`  evicted — live: ${pool.isLive('engineer:1')}`);

  const third = await pool.talk(
    'engineer:1',
    spec,
    'Once more: what was the project codename? Just the codename.',
  );
  check('RESUMED FROM DISK — the same person, after the session was closed', third.finalText,
    third.finalText.includes(SECRET));

  pool.disposeAll();

  console.log('\n──────── A8 memory gate ────────');
  if (failures.length === 0) {
    console.log('PASS — a role remembers across turns AND across a closed session.');
  } else {
    for (const f of failures) console.log(`FAIL — ${f}`);
  }
  console.log(`artifacts: ${RUN_DIR}`);
  killServer();
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((e) => {
  log('FAILED', e?.stack || e);
  killServer();
  process.exit(1);
});
