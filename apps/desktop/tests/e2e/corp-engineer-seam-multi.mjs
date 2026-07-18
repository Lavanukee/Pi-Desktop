/**
 * FOCUSED MULTI-CONTRACT validation of the engineer role-agent SEAM (the exact
 * wiring runCorp's makeAgentEngineer uses), on a small dependency chain so the
 * `read`-deps behaviour is exercised. Complements the full-corp run: it isolates
 * and REPORTS the per-contract behaviour cleanly — files written via tools, tools
 * used (read/write/bash), max single-turn output tokens (< 16k, no runaway), wall
 * time, and terminatedReason — without the corp planning/revise noise.
 *
 * Uses the SAME harness helpers the app path uses (buildAgentEngineerPrompt,
 * composeNodePrompt + ENGINEERING_HANDBOOK + AGENT_ENGINEER_ADDENDUM,
 * engineerToolAllowlist, samplingModeForPurpose) and the SAME role-agent runtime.
 *
 * KILLS the server on every exit path. `node tests/e2e/corp-engineer-seam-multi.mjs`
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
const PORT = 8173;
const BASE_URL = `http://${HOST}:${PORT}/v1`;
const HEALTH_URL = `http://${HOST}:${PORT}/health`;
const MODEL_ID = 'qwen3.5-4b';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(appRoot, '../..');
const ROLE_AGENT_TS = path.join(appRoot, 'electron', 'corp', 'role-agent.ts');
const CORP_INDEX_TS = path.join(repoRoot, 'packages', 'harness', 'src', 'corp', 'index.ts');

const RUN_DIR = mkdtempSync(path.join(os.tmpdir(), 'corp-seam-multi-'));
const SERVER_LOG = path.join(RUN_DIR, 'server.log');
const WORKSPACE = path.join(RUN_DIR, 'ws');
mkdirSync(WORKSPACE, { recursive: true });

const log = (...a) => console.error(`[${new Date().toISOString()}] ${a.join(' ')}`);

const hook = `
export async function resolve(specifier, context, next) {
  if (/^(\\.\\.?\\/|\\/)/.test(specifier) && specifier.endsWith('.js')) {
    try { return await next(specifier, context); }
    catch (err) { if (err && err.code === 'ERR_MODULE_NOT_FOUND') return next(specifier.slice(0, -3) + '.ts', context); throw err; }
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
  console.log('SEAM MULTI: SKIPPED');
  process.exit(0);
}

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
async function waitForHealth(timeoutMs = 180000) {
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

// A 3-contract dependency chain: c2 depends on c1 (so `read` fires), c3 independent.
const contracts = [
  {
    id: 'c1',
    title: 'Vec3 math type',
    ownerNodeId: 'eng-1',
    input: 'nothing',
    output: 'export interface Vec3 {x,y,z} + add/scale helpers',
    slot: 'src/engine/vec3.ts',
    available: { tools: ['read', 'write'], imports: [] },
    reviewRubric: 'a typed Vec3 with add(a,b) and scale(v,s)',
    dependsOn: [],
    status: 'queued',
  },
  {
    id: 'c2',
    title: 'Physics step',
    ownerNodeId: 'eng-2',
    input: 'the Vec3 type from src/engine/vec3.ts',
    output: 'export function step(pos, vel, dt): Vec3 using Vec3.add/scale',
    slot: 'src/engine/physics.ts',
    available: { tools: ['read', 'write', 'bash'], imports: [] },
    reviewRubric: 'integrates position by velocity*dt using the real Vec3 helpers',
    dependsOn: ['c1'],
    status: 'queued',
  },
  {
    id: 'c3',
    title: 'Score tracker',
    ownerNodeId: 'eng-3',
    input: 'nothing',
    output: 'export class ScoreTracker { add(n); get(): number; reset() }',
    slot: 'src/game/score.ts',
    available: { tools: ['read', 'write'], imports: [] },
    reviewRubric: 'a ScoreTracker class with add/get/reset',
    dependsOn: [],
    status: 'queued',
  },
];

async function main() {
  startServer();
  await waitForHealth();

  const corp = await import(pathToFileURL(CORP_INDEX_TS).href);
  const {
    buildAgentEngineerPrompt,
    AGENT_ENGINEER_ADDENDUM,
    engineerToolAllowlist,
    composeNodePrompt,
    getPromptById,
    getRolePrompt,
    ENGINEERING_HANDBOOK,
    samplingModeForPurpose,
    relativeImportSpecifier,
  } = corp;
  const ra = await import(pathToFileURL(ROLE_AGENT_TS).href);
  const { createCorpModelProvider, runRoleAgent } = ra;
  const handle = await createCorpModelProvider({ baseUrl: BASE_URL, model: MODEL_ID });

  const base = getPromptById('engineer') ?? getRolePrompt('engineer');
  const systemPrompt = `${composeNodePrompt(base, undefined)}\n\n${ENGINEERING_HANDBOOK}\n\n${AGENT_ENGINEER_ADDENDUM}`;

  const produced = new Map();
  const runs = [];
  for (const c of contracts) {
    const depContext = c.dependsOn.map((d) => {
      const dep = contracts.find((x) => x.id === d);
      return {
        contractId: dep.id,
        title: dep.title,
        slot: dep.slot,
        output: dep.output,
        content: produced.get(d),
      };
    });
    const userPrompt = buildAgentEngineerPrompt(c, depContext, undefined, undefined);
    log(
      `── engineer ${c.id} (${c.slot})${c.dependsOn.length ? ` depends on ${c.dependsOn.join(',')}` : ''}`,
    );
    const t0 = Date.now();
    const r = await runRoleAgent(handle, {
      purpose: 'engineer',
      systemPrompt,
      userPrompt,
      tools: engineerToolAllowlist(c.available.tools),
      cwd: WORKSPACE,
      thinking: true,
      samplingMode: samplingModeForPurpose('engineer'),
      maxTokens: 16000,
      maxSteps: 24,
      timeoutMs: 5 * 60 * 1000,
    });
    const wallMs = Date.now() - t0;
    const slotAbs = path.join(WORKSPACE, ...c.slot.split('/'));
    const wroteSlot = existsSync(slotAbs);
    if (wroteSlot) produced.set(c.id, readFileSync(slotAbs, 'utf8'));
    const toolNames = [...new Set(r.toolCalls.map((t) => t.name))];
    runs.push({
      id: c.id,
      slot: c.slot,
      wallMs,
      turns: r.turns,
      maxTurnOutputTokens: r.maxTurnOutputTokens,
      terminatedReason: r.terminatedReason,
      toolNames,
      readDeps: toolNames.includes('read'),
      selfChecked: toolNames.includes('bash'),
      wroteSlot,
      files: r.filesWritten.map((f) => ({
        path: f.path.replace(`${WORKSPACE}/`, ''),
        bytes: f.bytes,
      })),
      slotBytes: wroteSlot ? readFileSync(slotAbs, 'utf8').length : 0,
      readMentionsDep:
        c.dependsOn.length > 0
          ? userPrompt.includes(contracts.find((x) => x.id === c.dependsOn[0]).slot)
          : null,
      importSpecifierForDep:
        c.dependsOn.length > 0
          ? relativeImportSpecifier(c.slot, contracts.find((x) => x.id === c.dependsOn[0]).slot)
          : null,
    });
    log(
      `   ${c.id}: ${(wallMs / 1000).toFixed(1)}s turns=${r.turns} maxTok=${r.maxTurnOutputTokens} stop=${r.terminatedReason} tools=[${toolNames.join(',')}] wroteSlot=${wroteSlot}`,
    );
  }

  const reasons = {};
  for (const r of runs) reasons[r.terminatedReason] = (reasons[r.terminatedReason] ?? 0) + 1;
  const maxTok = Math.max(0, ...runs.map((r) => r.maxTurnOutputTokens));

  log('════════════ SEAM MULTI-CONTRACT REPORT ════════════');
  for (const r of runs) {
    log(
      `  · ${r.slot} — wrote=${r.wroteSlot} (${r.slotBytes}B), ${(r.wallMs / 1000).toFixed(1)}s, turns=${r.turns}, maxTurnTok=${r.maxTurnOutputTokens}, stop=${r.terminatedReason}, tools=[${r.toolNames.join(',')}], files=[${r.files.map((f) => `${f.path}(${f.bytes}B)`).join(', ')}]`,
    );
  }
  log(`terminatedReason distribution=${JSON.stringify(reasons)}`);
  log(`max single-turn output tokens=${maxTok} (bounded<16k: ${maxTok < 16000})`);
  const c2 = runs.find((r) => r.id === 'c2');
  log(
    `c2 (dependent) read deps=${c2?.readDeps}, bash self-checked=${c2?.selfChecked}, import specifier handed=${c2?.importSpecifierForDep}`,
  );

  // Show the produced physics file to confirm it integrated the real Vec3.
  const physAbs = path.join(WORKSPACE, 'src/engine/physics.ts');
  if (existsSync(physAbs)) {
    log('── produced src/engine/physics.ts (head) ──');
    for (const line of readFileSync(physAbs, 'utf8').split('\n').slice(0, 14)) log(`   ${line}`);
  }

  let failures = 0;
  const assert = (c, l, d) => {
    if (c) log(`PASS  ${l}`);
    else {
      failures++;
      log(`FAIL  ${l}${d ? ` — ${d}` : ''}`);
    }
  };
  assert(
    runs.every((r) => r.wroteSlot),
    'every engineer WROTE its slot file via tools',
  );
  assert(maxTok < 16000, 'no runaway — max single-turn output < 16k', `max=${maxTok}`);
  assert(
    runs.some((r) => r.readDeps),
    'a dependent engineer READ its dependency file',
  );
  assert(
    runs.some((r) => r.selfChecked),
    'at least one engineer ran a bash self-check',
  );
  assert((reasons.stop ?? 0) >= 2, 'engineers reached a clean stop', JSON.stringify(reasons));

  console.log(`\n${JSON.stringify({ runs, reasons, maxTok }, null, 2)}\n`);
  if (failures > 0) throw new Error(`${failures} assertion(s) failed`);
  log('SEAM MULTI: PASS');
}

main()
  .then(() => {
    killServer();
    process.exit(0);
  })
  .catch((e) => {
    log('SEAM MULTI: FAIL', e?.stack || e);
    killServer();
    process.exit(1);
  });
