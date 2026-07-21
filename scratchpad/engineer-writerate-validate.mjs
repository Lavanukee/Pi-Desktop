/**
 * REAL-SERVER validation of the REALIGNED engineer execution (spec §7/§91/§164):
 *   FIX 1 — ISOLATED WORKSPACE per engineer: each engineer's cwd is a fresh dir
 *           seeded with ONLY its dependency files (read-only), and its writes are
 *           HARVESTED back into the shared product tree. Measures the WRITE RATE.
 *   FIX 2 — §164 SUBMISSION INTERCEPTOR: submit_contract bounces the first call
 *           with a self-review prompt (improve, don't finalize), verifies the slot
 *           on the second. Measures that the bounce FIRED and engineers IMPROVED.
 *   FIX 3 — NO tight step cap: engineers run until they submit (only a 10-min
 *           wall-clock backstop). Confirms no engineer hit a step cap.
 *
 * It drives the EXACT production seam — `createRunRoleAgent` (role-agent-seam-impl.ts),
 * the same closure runCorp injects — over a 14-contract dependency chain, in
 * dependency order, seeding each isolated workspace with the REAL produced files of
 * its deps. The submit_contract tool + isolation + harvest are the production impl,
 * not a re-implementation.
 *
 * KILLS the server on every exit path. `node scratchpad/engineer-writerate-validate.mjs`
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HOME = os.homedir();
const SERVER_BIN = `${HOME}/.cache/pi-desktop/llamacpp/b9934/llama-b9934/llama-server`;
const MODEL_GGUF = `${HOME}/.cache/pi-desktop/models/qwen3.5-4b-mtp/Qwen3.5-4B-Q8_0.gguf`;
const CHAT_TEMPLATE = `${HOME}/.cache/pi-desktop/chat-templates/Qwen--Qwen3.5-4B.jinja`;
const HOST = '127.0.0.1';
const PORT = 8176;
const BASE_URL = `http://${HOST}:${PORT}/v1`;
const HEALTH_URL = `http://${HOST}:${PORT}/health`;
const MODEL_ID = 'qwen3.5-4b';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../apps/desktop');
const repoRoot = path.resolve(appRoot, '../..');
const SEAM_IMPL_TS = path.join(appRoot, 'electron', 'corp', 'role-agent-seam-impl.ts');
const CORP_INDEX_TS = path.join(repoRoot, 'packages', 'harness', 'src', 'corp', 'index.ts');

const RUN_DIR = mkdtempSync(path.join(os.tmpdir(), 'eng-writerate-'));
const SERVER_LOG = path.join(RUN_DIR, 'server.log');
const WORKSPACE = path.join(RUN_DIR, 'ws'); // the SHARED product tree (harvest target)
mkdirSync(WORKSPACE, { recursive: true });

const log = (...a) => console.error(`[${new Date().toISOString()}] ${a.join(' ')}`);

// Resolve relative specifiers in the loaded .ts modules: retry `.js`→`.ts` and
// extensionless `./role-agent` → `./role-agent.ts` (native type-stripping needs it).
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
  console.log('WRITERATE: SKIPPED');
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
  const app = (d) => {
    try {
      appendFileSync(SERVER_LOG, d);
    } catch {}
  };
  serverProc.stdout.on('data', app);
  serverProc.stderr.on('data', app);
}
function killServer() {
  if (serverProc && !serverProc.killed) {
    try {
      serverProc.kill('SIGKILL');
    } catch {}
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
        if (!j.status || j.status === 'ok') {
          log('healthy');
          return;
        }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 750));
  }
  throw new Error('never healthy');
}
for (const s of ['SIGINT', 'SIGTERM'])
  process.on(s, () => {
    killServer();
    process.exit(1);
  });
process.on('uncaughtException', (e) => {
  log('uncaught', e?.stack || e);
  killServer();
  process.exit(1);
});

// A 14-contract dependency chain: deps are produced BEFORE the contracts that use
// them (serial, dependency-ordered), so every declared dep's REAL produced file is
// available to seed the consumer's isolated workspace — exactly the makeAgentEngineer
// precondition.
const contracts = [
  { id: 'c1', title: 'Vec2 math type', slot: 'src/engine/vec2.ts',
    output: 'export interface Vec2 { x:number; y:number } + add(a,b) and scale(v,s)',
    reviewRubric: 'a typed Vec2 with add and scale', dependsOn: [], tools: ['read', 'write'] },
  { id: 'c2', title: 'Math clamp util', slot: 'src/util/clamp.ts',
    output: 'export function clamp(n, lo, hi): number', reviewRubric: 'clamps n into [lo,hi]',
    dependsOn: [], tools: ['read', 'write'] },
  { id: 'c3', title: 'AABB box', slot: 'src/engine/aabb.ts',
    output: 'export interface AABB { min:Vec2; max:Vec2 } + contains(box, p:Vec2)',
    reviewRubric: 'an AABB using the real Vec2', dependsOn: ['c1'], tools: ['read', 'write', 'bash'] },
  { id: 'c4', title: 'Physics step', slot: 'src/engine/physics.ts',
    output: 'export function step(pos:Vec2, vel:Vec2, dt:number): Vec2 using Vec2.add/scale',
    reviewRubric: 'integrates position by velocity*dt using real Vec2', dependsOn: ['c1'], tools: ['read', 'write', 'bash'] },
  { id: 'c5', title: 'Collision test', slot: 'src/engine/collision.ts',
    output: 'export function overlaps(a:AABB, b:AABB): boolean', reviewRubric: 'AABB overlap test',
    dependsOn: ['c1', 'c3'], tools: ['read', 'write', 'bash'] },
  { id: 'c6', title: 'Entity type', slot: 'src/game/entity.ts',
    output: 'export interface Entity { pos:Vec2; vel:Vec2; alive:boolean }', reviewRubric: 'an Entity using Vec2',
    dependsOn: ['c1'], tools: ['read', 'write'] },
  { id: 'c7', title: 'World state', slot: 'src/game/world.ts',
    output: 'export class World { entities:Entity[]; tick(dt): void } advancing each entity by physics.step',
    reviewRubric: 'a World that ticks entities via step', dependsOn: ['c4', 'c6'], tools: ['read', 'write', 'bash'] },
  { id: 'c8', title: 'Input map', slot: 'src/game/input.ts',
    output: 'export class Input { down(key):boolean; set(key, v):void }', reviewRubric: 'a keyboard Input map',
    dependsOn: [], tools: ['read', 'write'] },
  { id: 'c9', title: 'Score tracker', slot: 'src/game/score.ts',
    output: 'export class ScoreTracker { add(n):void; get():number; reset():void }',
    reviewRubric: 'a ScoreTracker class', dependsOn: [], tools: ['read', 'write'] },
  { id: 'c10', title: 'HUD render', slot: 'src/ui/hud.ts',
    output: 'export function renderHud(score:ScoreTracker): string', reviewRubric: 'renders the score as text',
    dependsOn: ['c9'], tools: ['read', 'write'] },
  { id: 'c11', title: 'Renderer', slot: 'src/ui/renderer.ts',
    output: 'export function draw(world:World): string[] describing each entity',
    reviewRubric: 'draws the world entities', dependsOn: ['c7'], tools: ['read', 'write'] },
  { id: 'c12', title: 'Audio bus', slot: 'src/audio/bus.ts',
    output: 'export class AudioBus { play(name):void; stop():void }', reviewRubric: 'a tiny audio bus',
    dependsOn: [], tools: ['read', 'write'] },
  { id: 'c13', title: 'Game loop', slot: 'src/game/loop.ts',
    output: 'export function loop(world:World, input:Input, dt:number): void — one frame',
    reviewRubric: 'a single-frame loop wiring world+input', dependsOn: ['c7', 'c8'], tools: ['read', 'write', 'bash'] },
  { id: 'c14', title: 'Game entry', slot: 'src/game/game.ts',
    output: 'export function startGame(): { world:World; score:ScoreTracker } wiring loop + hud',
    reviewRubric: 'wires the loop, world and score into a start function', dependsOn: ['c11', 'c10'], tools: ['read', 'write', 'bash'] },
].map((c) => ({
  ownerNodeId: `eng-${c.id}`,
  input: c.dependsOn.length ? `the outputs of ${c.dependsOn.join(', ')}` : 'nothing',
  available: { tools: c.tools, imports: [] },
  status: 'queued',
  ...c,
}));

const readPathsFrom = (toolCalls) => {
  const out = [];
  for (const t of toolCalls) {
    if (t.name !== 'read') continue;
    let args = t.arguments;
    if (typeof args === 'string') {
      try { args = JSON.parse(args); } catch { args = {}; }
    }
    const p = args?.path ?? args?.file_path;
    if (typeof p === 'string') out.push(p.replace(`${WORKSPACE}/`, '').replace(/^\.\//, ''));
  }
  return out;
};

async function main() {
  startServer();
  await waitForHealth();

  const corp = await import(pathToFileURL(CORP_INDEX_TS).href);
  const {
    buildAgentEngineerPrompt,
    AGENT_ENGINEER_SYSTEM_PROMPT,
    engineerAgentToolAllowlist,
    buildSubmitContractTool,
    samplingModeForPurpose,
  } = corp;
  const seamMod = await import(pathToFileURL(SEAM_IMPL_TS).href);
  const { createRunRoleAgent } = seamMod;

  // THE PRODUCTION SEAM — the exact closure runCorp injects for the engineer role.
  const runRoleAgent = createRunRoleAgent({ baseUrl: BASE_URL, model: MODEL_ID });

  const produced = new Map(); // contractId → its real produced slot content (for seeding)
  const runs = [];
  for (const c of contracts) {
    const depContext = c.dependsOn.map((d) => {
      const dep = contracts.find((x) => x.id === d);
      return { contractId: dep.id, title: dep.title, slot: dep.slot, output: dep.output, content: produced.get(d) };
    });
    // Seed the isolated workspace with ONLY the REAL produced dep files (read-only).
    const seed = depContext
      .filter((d) => d.content !== undefined && d.content !== '')
      .map((d) => ({ path: d.slot, content: d.content }));
    const userPrompt = buildAgentEngineerPrompt(c, depContext, undefined, undefined);
    log(`── engineer ${c.id} (${c.slot})${c.dependsOn.length ? ` deps=${c.dependsOn.join(',')} seeded=${seed.length}` : ''}`);
    const t0 = Date.now();
    const out = await runRoleAgent({
      purpose: 'engineer',
      systemPrompt: AGENT_ENGINEER_SYSTEM_PROMPT,
      userPrompt,
      tools: engineerAgentToolAllowlist(c.available.tools),
      customTools: [buildSubmitContractTool(c)],
      cwd: WORKSPACE, // the shared product tree = harvest target
      isolation: { seed }, // spec §91 — a fresh dir seeded with the deps
      thinking: true,
      samplingMode: samplingModeForPurpose('engineer'),
      maxTokens: 16000,
      // NO maxSteps and NO per-agent timeout — the engineer runs fully autonomously
      // until it calls submit_contract; only the app runtime's per-CALL network
      // abort (and, in a real run, the global RunBudget) can stop it.
    });
    const wallMs = Date.now() - t0;
    // The harvest copied the engineer's writes into WORKSPACE; read the slot back.
    const slotAbs = path.join(WORKSPACE, ...c.slot.split('/'));
    const wroteSlot = existsSync(slotAbs);
    if (wroteSlot) produced.set(c.id, readFileSync(slotAbs, 'utf8'));
    const toolNames = out.toolCalls.map((t) => t.name);
    const uniqueTools = [...new Set(toolNames)];
    const reads = readPathsFrom(out.toolCalls);
    const declaredDepSlots = c.dependsOn.map((d) => contracts.find((x) => x.id === d).slot);
    const strayReads = reads.filter((p) => !declaredDepSlots.includes(p) && p !== c.slot);
    const submitCalls = toolNames.filter((n) => n === 'submit_contract').length;
    const sr = out.submitReview ?? { bounced: false, finalized: false, changed: false, draftBytes: 0, finalBytes: 0 };
    runs.push({
      id: c.id, slot: c.slot, wallMs, turns: out.turns,
      maxTurnOutputTokens: out.maxTurnOutputTokens, terminatedReason: out.terminatedReason,
      uniqueTools, wroteSlot, submitCalls,
      bounced: sr.bounced, finalized: sr.finalized, improved: sr.changed,
      draftBytes: sr.draftBytes, finalBytes: sr.finalBytes,
      readDeclaredDeps: declaredDepSlots.length === 0 ? null : declaredDepSlots.every((s) => reads.includes(s)),
      strayReads, selfChecked: uniqueTools.includes('bash'),
      slotBytes: wroteSlot ? statSync(slotAbs).size : 0,
    });
    log(`   ${c.id}: ${(wallMs / 1000).toFixed(1)}s turns=${out.turns} maxTok=${out.maxTurnOutputTokens} stop=${out.terminatedReason} tools=[${uniqueTools.join(',')}] wrote=${wroteSlot} submit=${submitCalls} bounced=${sr.bounced} improved=${sr.changed} (draft ${sr.draftBytes}B→final ${sr.finalBytes}B)`);
  }

  const written = runs.filter((r) => r.wroteSlot).length;
  const writeRate = written / runs.length;
  const bounced = runs.filter((r) => r.bounced).length;
  const finalized = runs.filter((r) => r.finalized).length;
  const improved = runs.filter((r) => r.improved).length;
  const selfChecked = runs.filter((r) => r.selfChecked).length;
  const maxTok = Math.max(0, ...runs.map((r) => r.maxTurnOutputTokens));
  const maxTurns = Math.max(0, ...runs.map((r) => r.turns));
  const stepCapped = runs.filter((r) => r.terminatedReason === 'step-cap');
  const timedOut = runs.filter((r) => r.terminatedReason === 'timeout');
  const depAware = runs.filter((r) => r.readDeclaredDeps === true).length;
  const depTotal = runs.filter((r) => r.readDeclaredDeps !== null).length;
  const strayTotal = runs.reduce((a, r) => a + r.strayReads.length, 0);

  log('════════════ ENGINEER WRITE-RATE / §164 REVIEW REPORT ════════════');
  for (const r of runs) {
    log(`  · ${r.slot} — wrote=${r.wroteSlot} (${r.slotBytes}B) submit=${r.submitCalls} bounce=${r.bounced} improved=${r.improved} turns=${r.turns} maxTok=${r.maxTurnOutputTokens} stop=${r.terminatedReason} tools=[${r.uniqueTools.join(',')}] readDeps=${r.readDeclaredDeps} stray=${r.strayReads.length}`);
  }
  log(`WRITE RATE = ${written}/${runs.length} = ${(writeRate * 100).toFixed(1)}%   (target ≥ 90%, baseline ~13% = 2/15)`);
  log(`§164 review bounce FIRED: ${bounced}/${runs.length}   finalized (2nd submit): ${finalized}/${runs.length}   IMPROVED (draft→final changed): ${improved}/${runs.length}`);
  log(`bash self-check: ${selfChecked}/${runs.length}   dep-aware (read all declared deps): ${depAware}/${depTotal}   stray reads: ${strayTotal}`);
  log(`per-contract bounds: max single-turn output tokens = ${maxTok} (<16k: ${maxTok < 16000})   max turns = ${maxTurns}`);
  log(`NO per-agent caps: step-capped runs = ${stepCapped.length}   per-call-aborted runs = ${timedOut.length}   (no maxSteps and no per-agent timeout were passed — only the app's per-CALL network abort exists)`);

  let failures = 0;
  const assert = (cond, label, detail) => {
    if (cond) log(`PASS  ${label}`);
    else {
      failures++;
      log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    }
  };
  // ARCHITECTURE guarantees (must hold — these are what the realignment delivers):
  assert(strayTotal === 0, 'ISOLATION: engineers read ONLY seeded deps (nothing to wander)', `stray=${strayTotal}`);
  assert(depTotal === 0 || depAware === depTotal, 'ISOLATION: every dep contract read all its seeded deps (real code)', `${depAware}/${depTotal}`);
  assert(bounced >= 1 && finalized >= 1, '§164: the submit self-review bounce FIRED and the full bounce→finalize cycle ran', `bounced=${bounced} finalized=${finalized}`);
  assert(stepCapped.length === 0, 'NO per-agent step cap (engineers ran until they submitted)', JSON.stringify(stepCapped.map((r) => r.id)));
  assert(timedOut.length === 0, 'NO per-agent timeout (only a per-CALL network abort exists; none fired)', JSON.stringify(timedOut.map((r) => r.id)));
  assert(maxTok < 16000, 'no runaway/truncation — max single-turn output < 16k', `max=${maxTok}`);
  assert(writeRate > 0.5, 'ISOLATION lifted the write rate well above the 13% shared-tree baseline', `${written}/${runs.length}`);
  // TUNING metrics vs the aspirational targets (REPORTED — a 4B's tool-call
  // adherence is a Phase-2 §12 tuning outcome, not an architecture pass/fail):
  log(`REPORT  write rate ${(writeRate * 100).toFixed(1)}% vs target ≥90%  |  §164 bounce fired ${bounced}/${runs.length}, improved ${improved}/${runs.length}`);

  console.log(`\n${JSON.stringify({ writeRate, written, total: runs.length, bounced, finalized, improved, selfChecked, maxTok, maxTurns, stepCapped: stepCapped.length, timedOut: timedOut.length, depAware, depTotal, strayTotal }, null, 2)}\n`);
  if (failures > 0) throw new Error(`${failures} assertion(s) failed`);
  log('WRITERATE: PASS');
}

main()
  .then(() => {
    killServer();
    process.exit(0);
  })
  .catch((e) => {
    log('WRITERATE: FAIL', e?.stack || e);
    killServer();
    process.exit(1);
  });
