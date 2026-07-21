/**
 * REAL-SERVER validation of §11 LIVE SITUATION-ROOM ACTIVITY + the "peek at what
 * we have so far" safety valve.
 *
 * Drives the REAL {@link CorpEngine} (coordination/corp) with the REAL role-agent
 * seam (`createRunRoleAgent`, role-agent-seam-impl.ts) bound to a live llama-server,
 * on a small promoting task, and captures the neutral CoordinationEvent stream.
 *
 * ASSERTS:
 *   1. LIVE mid-work activity — at least one `file-touch`/activity event arrives
 *      WHILE a contract is still in-progress (before the terminal `done`), not only
 *      at the reconcile. A `file-touch` with `phase:'progress'` is the strong signal
 *      (an engineer writing its slot); any activity mid-run also counts.
 *   2. A node PULSES per role-turn — multiple org-chart snapshots land during the
 *      run and an engineer node reaches `working`.
 *   3. PEEK during the run returns the CURRENT in-progress product — real files,
 *      non-empty — read on demand from the workspace (never mock).
 *
 * KILLS the server on every exit path. `node scratchpad/live-activity-peek-validate.mjs`
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
const PORT = 8180;
const BASE_URL = `http://${HOST}:${PORT}/v1`;
const HEALTH_URL = `http://${HOST}:${PORT}/health`;
const MODEL_ID = 'qwen3.5-4b';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../apps/desktop');
const repoRoot = path.resolve(appRoot, '../..');
const SEAM_IMPL_TS = path.join(appRoot, 'electron', 'corp', 'role-agent-seam-impl.ts');
const CORP_CHAT_TS = path.join(appRoot, 'electron', 'corp', 'corp-chat.ts');
const COORD_CORP_TS = path.join(repoRoot, 'packages', 'coordination', 'src', 'corp', 'index.ts');

const RUN_DIR = mkdtempSync(path.join(os.tmpdir(), 'live-peek-'));
const SERVER_LOG = path.join(RUN_DIR, 'server.log');
const WORKSPACE_ROOT = path.join(RUN_DIR, 'ws');
mkdirSync(WORKSPACE_ROOT, { recursive: true });

const log = (...a) => console.error(`[${new Date().toISOString()}] ${a.join(' ')}`);

// Rewrite relative `.js`→`.ts` (and extensionless) specifiers for native TS
// type-stripping — the same hook the writerate driver uses.
const hook = `
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
register(`data:text/javascript,${encodeURIComponent(hook)}`);

const missing = [
  [SERVER_BIN, 'llama-server'],
  [MODEL_GGUF, 'gguf'],
  [CHAT_TEMPLATE, 'chat template'],
].filter(([p]) => !existsSync(p));
if (missing.length > 0) {
  for (const [p, w] of missing) log(`SKIP missing ${w} ${p}`);
  console.log('LIVE-PEEK: SKIPPED');
  process.exit(0);
}

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
  log('starting llama-server on', PORT);
  serverProc = spawn(SERVER_BIN, a, { stdio: ['ignore', 'pipe', 'pipe'] });
  const app = (d) => { try { appendFileSync(SERVER_LOG, d); } catch {} };
  serverProc.stdout.on('data', app);
  serverProc.stderr.on('data', app);
}
function killServer() {
  if (serverProc && !serverProc.killed) {
    try { serverProc.kill('SIGKILL'); } catch {}
  }
}
async function waitForHealth(timeoutMs = 240000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (serverProc && serverProc.exitCode !== null) throw new Error('server exited early');
    try {
      const r = await fetch(HEALTH_URL);
      if (r.ok) {
        const j = await r.json().catch(() => ({}));
        if (!j.status || j.status === 'ok') { log('healthy'); return; }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 750));
  }
  throw new Error('never healthy');
}
for (const s of ['SIGINT', 'SIGTERM'])
  process.on(s, () => { killServer(); process.exit(1); });
process.on('uncaughtException', (e) => { log('uncaught', e?.stack || e); killServer(); process.exit(1); });

async function main() {
  startServer();
  await waitForHealth();

  const coord = await import(pathToFileURL(COORD_CORP_TS).href);
  const { CorpEngine, createNodeWorkspaceFactory } = coord;
  const { createRunRoleAgent } = await import(pathToFileURL(SEAM_IMPL_TS).href);
  const { createLlamaCorpChat } = await import(pathToFileURL(CORP_CHAT_TS).href);

  const chat = createLlamaCorpChat({ baseUrl: BASE_URL, model: MODEL_ID });
  const runRoleAgent = createRunRoleAgent({ baseUrl: BASE_URL, model: MODEL_ID });

  const engine = new CorpEngine({
    chat,
    runRoleAgent,
    workspaceFor: createNodeWorkspaceFactory(WORKSPACE_ROOT),
    limit: 1, // ONE engineer is enough to prove the live path — keeps the run small
    concurrency: 1,
    maxRevisions: 0,
    maxTokens: 8000,
    maxWallClockMs: 300000, // 5-min backstop
  });

  const TASK =
    'Build a small note-taking web app: a UI module that lets the user add and list notes, and a separate in-memory store module that holds the notes.';
  log('startTask:', TASK);
  const handle = engine.startTask(TASK);

  // Live capture -------------------------------------------------------------
  const kinds = {}; // event type → count
  const activityKinds = {}; // activity kind → count
  let sawProgressBeforeDone = false;
  let sawAnyActivityBeforeDone = false;
  let engineerPulsed = false; // an engineer node reached `working` in a mid-run chart
  let orgChartCount = 0;
  let artifactCount = 0;
  let maxPeekFiles = 0;
  let peekSnapshot = null; // the first non-empty in-run peek
  const liveFileTouches = []; // {path, phase, nodeId}
  let done = false;
  let doneOutcome = null;
  let aborted = false;

  const capturePeek = () => {
    const peek = engine.peek(handle);
    const n = peek?.files.length ?? 0;
    if (n > maxPeekFiles) {
      maxPeekFiles = n;
      if (n > 0 && peekSnapshot === null) peekSnapshot = peek;
    }
  };

  for await (const event of handle.events) {
    kinds[event.type] = (kinds[event.type] ?? 0) + 1;

    if (event.type === 'done') { done = true; doneOutcome = event.result.outcome; break; }

    if (!done) {
      // Anything before the terminal `done` is live, mid-run signal.
      if (event.type === 'activity') {
        sawAnyActivityBeforeDone = true;
        const a = event.activity;
        activityKinds[a.kind] = (activityKinds[a.kind] ?? 0) + 1;
        if (a.kind === 'file-touch') {
          liveFileTouches.push({ path: a.path, phase: a.phase, nodeId: a.nodeId });
          if (a.phase === 'progress') sawProgressBeforeDone = true;
        }
      }
      if (event.type === 'org-chart') {
        orgChartCount += 1;
        const eng = event.chart.nodes.find((n) => n.role === 'engineer' && n.state === 'working');
        if (eng) engineerPulsed = true;
      }
      if (event.type === 'artifact') artifactCount += 1;
    }

    // Peek on every event — records the in-progress product tree the moment it fills.
    capturePeek();

    // Bound the run: once we have the live signal AND a non-empty peek, abort (the
    // remaining review/CEO turns are not needed to prove the wiring).
    if (sawProgressBeforeDone && maxPeekFiles > 0 && !aborted && !done) {
      aborted = true;
      log('conditions met — aborting to bound the run');
      engine.abort(handle);
    }
  }

  // A final peek after the stream ends (the task record is still live).
  capturePeek();

  // Report -------------------------------------------------------------------
  log('════════════ LIVE-ACTIVITY + PEEK REPORT ════════════');
  log('outcome:', doneOutcome, aborted ? '(aborted early — expected)' : '');
  log('event kinds:', JSON.stringify(kinds));
  log('activity kinds (mid-run):', JSON.stringify(activityKinds));
  log('org-chart snapshots (mid-run pulses):', orgChartCount, '  engineer node pulsed:', engineerPulsed);
  log('artifact events:', artifactCount);
  log('live file-touches:', JSON.stringify(liveFileTouches.slice(0, 8)));
  log('max in-run peek files:', maxPeekFiles);
  if (peekSnapshot) {
    log('PEEK snapshot — fileCount:', peekSnapshot.fileCount, 'totalBytes:', peekSnapshot.totalBytes);
    for (const f of peekSnapshot.files.slice(0, 8)) {
      const head = f.content.split('\n').slice(0, 2).join(' ⏎ ').slice(0, 120);
      log(`  · ${f.path} — ${f.bytes}B  «${head}»`);
    }
  }

  let failures = 0;
  const assert = (cond, label, detail) => {
    if (cond) log(`PASS  ${label}`);
    else { failures++; log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
  };
  assert(
    sawAnyActivityBeforeDone,
    'LIVE: at least one activity event arrived WHILE work was in-progress (not only at reconcile)',
  );
  assert(
    sawProgressBeforeDone,
    "LIVE: a mid-work file-touch (phase 'progress') fired while a contract was still in-progress",
    JSON.stringify(liveFileTouches.slice(0, 4)),
  );
  assert(orgChartCount > 1, 'PULSE: multiple org-chart snapshots landed during the run', `count=${orgChartCount}`);
  assert(engineerPulsed, 'PULSE: an engineer node reached `working` mid-run (per-role-turn pulse)');
  assert(maxPeekFiles > 0, 'PEEK: a peek during the run returned the CURRENT in-progress product (real files, non-empty)', `maxPeekFiles=${maxPeekFiles}`);

  console.log(`\n${JSON.stringify({ outcome: doneOutcome, aborted, kinds, activityKinds, orgChartCount, engineerPulsed, artifactCount, maxPeekFiles, peekFiles: peekSnapshot?.files.map((f) => ({ path: f.path, bytes: f.bytes })) ?? [] }, null, 2)}\n`);

  if (failures > 0) throw new Error(`${failures} assertion(s) failed`);
  log('LIVE-PEEK: PASS');
}

main()
  .then(() => { killServer(); process.exit(0); })
  .catch((e) => { log('LIVE-PEEK: FAIL', e?.stack || e); killServer(); process.exit(1); });
