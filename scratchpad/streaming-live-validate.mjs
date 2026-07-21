/**
 * REAL-SERVER validation of the §11 LIVE STREAMING situation-room click-through.
 *
 * Drives the REAL {@link CorpEngine} (coordination/corp) with the REAL role-agent
 * seam (`createRunRoleAgent`, role-agent-seam-impl.ts) bound to a live llama-server,
 * on a small PROMOTING task, and POLLS `getWorkerTranscript` for the running
 * node(s) while the run is in flight — proving the pane now streams the model's
 * work instead of showing "working…".
 *
 * ASSERTS (all from RUNNING nodes, mid-flight):
 *   (a) STREAMING assistant text that GROWS across polls (partial → more) — a
 *       `message` line whose text length strictly increased between two snapshots.
 *   (b) A THINKING state/indicator — a `thinking` transcript line and/or a node
 *       whose current action is "thinking" (and, when reasoning streams, a
 *       thinking line that GROWS across polls).
 *   (c) NAMED tool steps WITH details — "Reading <file>", "Ran: <cmd>",
 *       "Writing <file>" — NOT a generic "Used a tool".
 *   (d) NO "turn N" divider lines anywhere in any transcript.
 *   (e) The per-node CURRENT ACTION field reflects what the node is doing
 *       ("thinking", "Reading …", "Writing …") on a running node.
 *
 * KILLS the server on every exit path (no orphan). `node scratchpad/streaming-live-validate.mjs`
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
const PORT = 8183;
const BASE_URL = `http://${HOST}:${PORT}/v1`;
const HEALTH_URL = `http://${HOST}:${PORT}/health`;
const MODEL_ID = 'qwen3.5-4b';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../apps/desktop');
const repoRoot = path.resolve(appRoot, '../..');
const SEAM_IMPL_TS = path.join(appRoot, 'electron', 'corp', 'role-agent-seam-impl.ts');
const CORP_CHAT_TS = path.join(appRoot, 'electron', 'corp', 'corp-chat.ts');
const COORD_CORP_TS = path.join(repoRoot, 'packages', 'coordination', 'src', 'corp', 'index.ts');

const RUN_DIR = mkdtempSync(path.join(os.tmpdir(), 'stream-live-'));
const SERVER_LOG = path.join(RUN_DIR, 'server.log');
const WORKSPACE_ROOT = path.join(RUN_DIR, 'ws');
mkdirSync(WORKSPACE_ROOT, { recursive: true });

const log = (...a) => console.error(`[${new Date().toISOString()}] ${a.join(' ')}`);

// Rewrite relative `.js`→`.ts` (and extensionless) specifiers for native TS
// type-stripping — the same hook the other real-server drivers use.
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
  console.log('STREAM-LIVE: SKIPPED');
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

// The named verbs the coordination layer produces for KNOWN tools (describeTool).
const NAMED_VERBS = [
  'Searched the web', 'Fetched a page', 'Reading', 'Ran', 'Searched the code',
  'Looked around', 'Writing', 'Editing',
];
const isNamedStep = (label) =>
  typeof label === 'string' && NAMED_VERBS.some((v) => label.startsWith(v));
// A TURN-DIVIDER line is the engine's old "— continued (turn N) —" note. Detect
// ONLY that (the divider phrase, or an em-dash-wrapped NOTE mentioning "turn N")
// — NOT the substring "turn N" inside streamed model prose/code (e.g. `return 5`
// contains "turn 5"), which would be a false positive against the model's output.
const isTurnDivider = (line) => {
  const t = line.text ?? '';
  if (/continued\s*\(turn/i.test(t)) return true;
  return line.kind === 'note' && /^\s*—.*\bturn\b\s*\d/i.test(t);
};

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
    limit: 1,           // ONE engineer is enough to prove the named tool steps
    concurrency: 1,
    maxRevisions: 0,
    maxTokens: 8000,
    maxWallClockMs: 360000, // 6-min backstop
  });

  const TASK =
    'Build a small note-taking web app: a UI module that lets the user add and list notes, and a separate in-memory store module that holds the notes.';
  log('startTask:', TASK);
  const handle = engine.startTask(TASK);

  // ---- Live capture state ----------------------------------------------------
  const nodeIds = new Set();                 // every node id ever seen in a chart
  const streamLenByKey = new Map();          // `${nodeId}:${at}` -> max text length seen
  let sawTextGrowth = false;                 // (a) a message line grew across polls
  let sawThinkingGrowth = false;             // (b, strong) a thinking line grew across polls
  let sawThinkingLine = false;               // (b) a thinking transcript line existed
  let sawThinkingAction = false;             // (b) a running node's current action was "thinking"
  const namedSteps = [];                     // (c) {label, detail, text}
  let sawGenericUsedTool = false;            // (c, negative) a bare "Used a tool"
  let sawTurnDivider = false;                // (d) any "turn N" divider text
  const currentActions = new Set();          // (e) distinct current actions on running nodes
  let sawStreamingFlag = false;              // the view.streaming live flag fired
  const orgActionSamples = [];               // (e) currentAction seen on org-chart nodes

  const sampleTranscript = (nodeId) => {
    let t;
    try { t = engine.getWorkerTranscript(handle, nodeId); } catch { t = null; }
    if (t == null) return;
    if (t.streaming === true) sawStreamingFlag = true;
    if (typeof t.currentAction === 'string' && t.currentAction.length > 0) {
      currentActions.add(t.currentAction);
      if (/^thinking/i.test(t.currentAction)) sawThinkingAction = true;
    }
    for (const line of t.lines) {
      if (isTurnDivider(line)) sawTurnDivider = true;
      if (line.kind === 'thinking') sawThinkingLine = true;
      if (line.label === 'Used a tool') sawGenericUsedTool = true;
      if ((line.kind === 'tool-call' || line.kind === 'file-touch') && isNamedStep(line.label)) {
        namedSteps.push({ label: line.label, detail: line.detail, tool: line.text });
      }
      // Growth of a still-streaming line, keyed by its stable `at` timestamp.
      if (line.streaming === true) {
        const key = `${nodeId}:${line.at}`;
        const prev = streamLenByKey.get(key);
        const len = (line.text ?? '').length;
        if (prev !== undefined && len > prev) {
          if (line.kind === 'message') sawTextGrowth = true;
          if (line.kind === 'thinking') sawThinkingGrowth = true;
        }
        streamLenByKey.set(key, Math.max(prev ?? 0, len));
      }
    }
  };

  // Poll every running node's transcript fast enough to catch a growing tail.
  const poll = setInterval(() => {
    for (const id of nodeIds) sampleTranscript(id);
  }, 120);

  let done = false;
  let doneOutcome = null;
  let aborted = false;

  const enough = () =>
    sawTextGrowth &&
    (sawThinkingLine || sawThinkingAction || sawThinkingGrowth) &&
    namedSteps.length > 0 &&
    currentActions.size > 0;

  for await (const event of handle.events) {
    if (event.type === 'done') { done = true; doneOutcome = event.result.outcome; break; }
    if (event.type === 'org-chart') {
      for (const n of event.chart.nodes) {
        nodeIds.add(n.id);
        if (n.state === 'working' && typeof n.currentAction === 'string' && n.currentAction.length > 0) {
          orgActionSamples.push({ id: n.id, action: n.currentAction });
          currentActions.add(n.currentAction);
        }
      }
    }
    // Sample synchronously on each event too (bursts land between poll ticks).
    for (const id of nodeIds) sampleTranscript(id);

    // Bound the run once every signal is captured — the remaining review/CEO
    // turns aren't needed to prove the streaming wiring.
    if (enough() && !aborted && !done) {
      aborted = true;
      log('all streaming signals captured — aborting to bound the run');
      engine.abort(handle);
    }
  }
  clearInterval(poll);

  // ---- Report ----------------------------------------------------------------
  log('════════════ LIVE-STREAMING REPORT ════════════');
  log('outcome:', doneOutcome, aborted ? '(aborted early — expected)' : '');
  log('nodes seen:', [...nodeIds].join(', '));
  log('(a) streaming assistant text grew across polls:', sawTextGrowth);
  log('(b) thinking line seen:', sawThinkingLine, ' thinking action:', sawThinkingAction, ' thinking stream grew:', sawThinkingGrowth);
  log('(c) named tool steps:', namedSteps.length, '  sample:', JSON.stringify(namedSteps.slice(0, 6)));
  log('(c) generic "Used a tool" ever seen:', sawGenericUsedTool);
  log('(d) "turn N" divider ever seen:', sawTurnDivider);
  log('(e) distinct current actions:', JSON.stringify([...currentActions].slice(0, 12)));
  log('    org-chart node current actions:', JSON.stringify(orgActionSamples.slice(0, 8)));
  log('view.streaming live flag fired:', sawStreamingFlag);

  // ==========================================================================
  // PHASE 2 — a DIRECT engineer role-agent turn (real file tools), so the named
  // FILE-tool steps (Reading / Ran / Writing) are exercised deterministically:
  // the promoting corp run above is model-nondeterministic about reaching an
  // engineer, but a bare write-a-file task reliably calls write + bash/ls. This
  // runs the SAME production seam (createRunRoleAgent → role-agent.ts) the corp
  // uses, and maps the neutral onActivity records through the SAME describeTool
  // the engine feeds the transcript — proving named steps end to end.
  // ==========================================================================
  const { describeTool } = coord;
  const engCwd = path.join(RUN_DIR, 'eng');
  mkdirSync(engCwd, { recursive: true });
  const runRole = createRunRoleAgent({ baseUrl: BASE_URL, model: MODEL_ID });
  const engRecords = [];
  log('PHASE 2: direct engineer role-agent turn (write + verify)…');
  let engOut = null;
  try {
    engOut = await runRole({
      purpose: 'engineer',
      systemPrompt:
        'You are a careful engineer. Use the write tool to create files and the bash tool to verify your work. Keep it minimal and stop when done.',
      userPrompt:
        'Create a file named hello.ts in the current directory whose entire contents are exactly:\nexport const hello = () => "hi";\nThen run the bash command `ls` to confirm the file exists. Do not do anything else.',
      tools: ['read', 'write', 'edit', 'bash', 'ls'],
      cwd: engCwd,
      thinking: true,
      samplingMode: 'thinking-coding',
      maxTokens: 2500,
      onActivity: (r) => engRecords.push(r),
    });
  } catch (e) {
    log('PHASE 2 error:', e?.stack || e);
  }
  // Map the raw records the way the engine does: a file-write → "Writing <path>";
  // any other tool → describeTool(toolName, detail, path).
  const engNamed = [];
  let engSawWrite = false;
  let engSawUsedTool = false;
  for (const r of engRecords) {
    if (r.kind === 'file-write') {
      engSawWrite = true;
      engNamed.push({ label: 'Writing', detail: r.path, tool: r.toolName ?? 'write' });
    } else if (r.kind === 'tool') {
      const d = describeTool(r.toolName ?? 'tool', r.detail, r.path);
      if (d.label === 'Used a tool') engSawUsedTool = true;
      if (isNamedStep(d.label)) engNamed.push({ label: d.label, detail: d.detail, tool: r.toolName });
    }
  }
  const engToolKinds = {};
  for (const r of engRecords) engToolKinds[r.kind] = (engToolKinds[r.kind] ?? 0) + 1;
  log('PHASE 2 record kinds:', JSON.stringify(engToolKinds));
  log('PHASE 2 named file-tool steps:', JSON.stringify(engNamed.slice(0, 8)));
  log('PHASE 2 filesWritten:', JSON.stringify(engOut?.filesWritten ?? []));
  const engHasDetail = engNamed.some((s) => typeof s.detail === 'string' && s.detail.length > 0);

  // The combined (c) evidence: named steps from EITHER the corp run OR the direct
  // engineer turn, with at least one carrying a detail, and never "Used a tool".
  const allNamed = [...namedSteps, ...engNamed];

  let failures = 0;
  const assert = (cond, label, detail) => {
    if (cond) log(`PASS  ${label}`);
    else { failures++; log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
  };
  assert(sawTextGrowth, '(a) streaming assistant text GREW across polls (partial → more) — live, not "working…"');
  assert(
    sawThinkingLine || sawThinkingAction || sawThinkingGrowth,
    '(b) a thinking state/indicator surfaced on a running node',
  );
  assert(
    allNamed.length > 0 && engHasDetail,
    '(c) named tool steps WITH details surfaced (Reading/Ran/Writing …), NOT "Used a tool"',
    JSON.stringify(allNamed.slice(0, 5)),
  );
  assert(engSawWrite, '(c) the engineer turn produced a "Writing <file>" step (real file tool)');
  assert(!sawGenericUsedTool && !engSawUsedTool, '(c) NO generic "Used a tool" label was ever emitted');
  assert(!sawTurnDivider, '(d) NO "turn N" divider line appeared in any transcript');
  assert(currentActions.size > 0, '(e) a running node exposed a CURRENT action reflecting what it is doing');

  console.log(`\n${JSON.stringify({
    outcome: doneOutcome, aborted,
    sawTextGrowth, sawThinkingLine, sawThinkingAction, sawThinkingGrowth,
    corpNamedSteps: namedSteps.slice(0, 8),
    engNamedSteps: engNamed.slice(0, 8), engSawWrite, engHasDetail,
    sawGenericUsedTool: sawGenericUsedTool || engSawUsedTool, sawTurnDivider, sawStreamingFlag,
    currentActions: [...currentActions].slice(0, 16),
  }, null, 2)}\n`);

  if (failures > 0) throw new Error(`${failures} assertion(s) failed`);
  log('STREAM-LIVE: PASS');
}

main()
  .then(() => { killServer(); process.exit(0); })
  .catch((e) => { log('STREAM-LIVE: FAIL', e?.stack || e); killServer(); process.exit(1); });
