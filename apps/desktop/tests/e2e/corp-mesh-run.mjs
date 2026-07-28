/**
 * THE CORP MESH RUN — the real thing, end to end, against a real model.
 *
 * Starts the app's own llama-server and runs `runCorpMeshTask` on a task: the CEO
 * is prompted, talks to the manager, the manager talks to engineers and
 * specialists, everyone works in ONE shared tree, and a product either exists at
 * the end or it does not. Nothing about the outcome is a model's opinion — the
 * gate at the bottom looks at the FILES.
 *
 * It is also the diagnostic instrument. A failed run here is the only place the
 * real lessons live, so everything needed to trace one is written to disk:
 *
 *   <run>/server.log      the llama-server log (prefill/cache/slot behaviour)
 *   <run>/transcript.jsonl every hop and every activity record, in order
 *   <run>/summary.json    per-agent turn counts, tools used, files written
 *   the workspace         the product itself, plus .pi/corp/ (team + sessions).
 *                         Deliberately OUTSIDE <run>, on a short path — see below.
 *
 *   node tests/e2e/corp-mesh-run.mjs --task converter   # the small green-run target
 *   node tests/e2e/corp-mesh-run.mjs --task memory      # A8: does an agent remember?
 *   node tests/e2e/corp-mesh-run.mjs --task godot
 *   node tests/e2e/corp-mesh-run.mjs --task "…free text…" [--engineers 2] [--minutes 45]
 *
 * Kills the server on every exit path — no orphan.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HOME = os.homedir();
const SERVER_BIN = `${HOME}/.cache/pi-desktop/llamacpp/b9934/llama-b9934/llama-server`;
const MODEL_GGUF = `${HOME}/.cache/pi-desktop/models/qwen3.5-4b-mtp/Qwen3.5-4B-Q8_0.gguf`;
const CHAT_TEMPLATE = `${HOME}/.cache/pi-desktop/chat-templates/Qwen--Qwen3.5-4B.jinja`;
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT ?? 8174);
const BASE_URL = `http://${HOST}:${PORT}/v1`;
const HEALTH_URL = `http://${HOST}:${PORT}/health`;
const MODEL_ID = 'qwen3.5-4b';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

/** The named targets. `converter` is the SMALL one the machine gets debugged on. */
const TASKS = {
  converter:
    'Build a small offline file-conversion tool in this directory. It must convert ' +
    'between exactly three formats to start: JSON, CSV, and YAML — any of the three ' +
    'to any other. Provide a command-line entry point that takes an input file and ' +
    'an output file and does the conversion. It must RUN with no network access and ' +
    'no paid services. Include a test that converts a real file each way and checks ' +
    'the result, and make sure that test passes before you call the work done.',
  /*
   * THE REAL TARGET (jedd, 2026-07-28). The `converter` task above is a hundred
   * lines of Python; a manager that one-shots it is not misbehaving, it is
   * correct, and a benchmark that cannot tell a good manager from a bad one is
   * not a benchmark. THIS is the task that was actually asked for, and it cannot
   * be done by one agent in one turn: a GUI, a packaged app, an install step, and
   * a dozen independent format backends that different people can own.
   */
  desktop:
    'Build a real macOS desktop application for converting files, and install it into ' +
    '/Applications so it can be launched from Finder like any other app. It needs a ' +
    'GUI in the shape of CloudConvert: drop files in (or browse for them), pick the ' +
    'output format from what is actually possible for that input, watch progress, and ' +
    'get the converted file back. Support the breadth CloudConvert does — documents, ' +
    'spreadsheets, presentations, images, audio, video, archives, ebooks and fonts — ' +
    'using whatever converters this machine has (ffmpeg, sips, and anything else you ' +
    'find); where a format genuinely cannot be handled, say so in the UI rather than ' +
    'failing silently. It must run offline with no paid services. Leave behind a way ' +
    'to check it that RUNS: something that converts real files in several formats and ' +
    'exits non-zero when a conversion is wrong.',
  godot:
    'Build a 3D flight-combat game in Godot 4: command a fleet, create units, direct ' +
    'them on a 3D map against an enemy, with capturable bases and outposts, buildable ' +
    'turrets, and several types of plane. Production ready.',
  memory:
    'This is a MEMORY CHECK, not a build. Ask your engineer to invent a distinctive ' +
    'codename for this project and remember it. Then, in a SEPARATE later message, ask ' +
    'that same engineer what codename they chose. Report both replies verbatim.',
};
const taskArg = flag('task', 'converter');
const TASK = TASKS[taskArg] ?? taskArg;
const TASK_NAME = TASKS[taskArg] !== undefined ? taskArg : 'custom';
const ENGINEERS = Number(flag('engineers', '2'));
const BUDGET_MS = Number(flag('minutes', '45')) * 60_000;

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(appRoot, '../..');
const MESH_HOST_TS = path.join(appRoot, 'electron', 'corp', 'mesh-host.ts');
const ROLE_AGENT_TS = path.join(appRoot, 'electron', 'corp', 'role-agent.ts');

const RUN_DIR = process.env.RUN_DIR ?? mkdtempSync(path.join(os.tmpdir(), 'corp-mesh-'));
const SERVER_LOG = path.join(RUN_DIR, 'server.log');
const TRANSCRIPT = path.join(RUN_DIR, 'transcript.jsonl');
/*
 * DELIBERATELY SHORT, and NOT under RUN_DIR.
 *
 * Runs 9 and 11 were both lost to an agent re-stating the workspace path as a
 * relative one — `private/tmp/claude-501/<uuid>/scratchpad/mesh11/ws/src/cli.py`
 * — which resolves into a nested shadow copy the gate cannot see. The harness now
 * repairs that (workspace-paths.ts), but the cause is that there was 120
 * characters of UUID-laden path to mangle in the first place. Artifacts still go
 * to RUN_DIR; only the product tree moves somewhere a small model can hold in
 * one piece.
 */
// `/tmp` LITERALLY, not os.tmpdir(): on macOS the latter is
// /var/folders/4h/nq1c73q107v594j4g0lq6bw00000gn/T — an opaque 50-character path,
// which is most of the problem again. /tmp resolves to /private/tmp.
const WORKSPACE = process.env.WORKSPACE ?? path.join('/tmp', `cw-${path.basename(RUN_DIR)}`);
mkdirSync(WORKSPACE, { recursive: true });

const t0 = Date.now();
const since = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
function log(...a) {
  console.error(`[${since()}] ${a.join(' ')}`);
}
function record(entry) {
  try {
    appendFileSync(TRANSCRIPT, `${JSON.stringify({ at: since(), ...entry })}\n`);
  } catch {
    /* the transcript must never break the run */
  }
}

// The corp TS sources use `.js` specifiers that resolve to `.ts`.
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

const missing = [
  [SERVER_BIN, 'llama-server binary'],
  [MODEL_GGUF, 'qwen3.5-4b Q8 gguf'],
  [CHAT_TEMPLATE, 'qwen chat template'],
].filter(([p]) => !existsSync(p));
if (missing.length > 0) {
  for (const [p, what] of missing) log(`SKIP: missing ${what} at ${p}`);
  console.log('CORP MESH RUN: SKIPPED (model assets not present)');
  process.exit(0);
}

// ── server lifecycle ────────────────────────────────────────────────────────
let serverProc = null;
function startServer() {
  const a = [
    '-m',
    MODEL_GGUF,
    '--host',
    HOST,
    '--port',
    String(PORT),
    // Room for a role that works for a long time. Each agent holds its OWN
    // conversation now, so the window is per-role, not shared.
    '-c',
    '32768',
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
        if (!j.status || j.status === 'ok') return;
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

/** Every file in the product tree, excluding the corp's own bookkeeping. */
function productFiles(root, base = root, out = []) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === '.pi' || e.name === 'node_modules' || e.name === '.git') continue;
    const abs = path.join(root, e.name);
    if (e.isDirectory()) productFiles(abs, base, out);
    else {
      let bytes = 0;
      try {
        bytes = statSync(abs).size;
      } catch {}
      out.push({ path: path.relative(base, abs), bytes });
    }
  }
  return out;
}

async function main() {
  startServer();
  await waitForHealth();
  log('server healthy · task:', TASK_NAME, '· workspace:', WORKSPACE);

  const roleMod = await import(pathToFileURL(ROLE_AGENT_TS).href);
  const meshMod = await import(pathToFileURL(MESH_HOST_TS).href);
  const handle = await roleMod.createCorpModelProvider({ baseUrl: BASE_URL, model: MODEL_ID });

  // Per-agent accounting, so a bad run can be READ rather than guessed at.
  const agents = new Map();
  const seen = (id) => {
    let a = agents.get(id);
    if (a === undefined) {
      a = { turns: 0, tools: {}, files: new Set(), lastText: '' };
      agents.set(id, a);
    }
    return a;
  };

  const controller = new AbortController();
  const budget = setTimeout(() => {
    log(`BUDGET SPENT (${BUDGET_MS / 60000} min) — telling every agent to wrap up`);
    record({ kind: 'budget-exceeded' });
    controller.abort();
  }, BUDGET_MS);

  let result;
  try {
    result = await meshMod.runCorpMeshTask({
      handle,
      task: TASK,
      cwd: WORKSPACE,
      engineerCount: ENGINEERS,
      signal: controller.signal,
      onSubmitted: (agentId, command, accepted) => {
        log(`  ${agentId} SUBMIT ${accepted ? 'ACCEPTED' : 'REJECTED'}: ${command.slice(0, 90)}`);
        record({ kind: 'submit', agentId, command, accepted });
      },
      onRepaired: (agentId, count) => {
        // Files rescued out of a re-stated workspace path. Loud on purpose: this
        // is the harness papering over a model mistake, and a run where it fires
        // constantly is a run to go and look at.
        log(`  ${agentId} REPAIRED ${count} file(s) written to a nested workspace path`);
        record({ kind: 'repair', agentId, count });
      },
      onChecked: (agentId, ok, command) => {
        // The team running the REAL acceptance check on itself. Watching this
        // number climb while `ok` flips to true is what convergence looks like;
        // a run with zero of these is a team working blind.
        log(`  ${agentId} CHECK ${ok ? 'PASS' : 'fail'}${command ? ` [${command}]` : ''}`);
        record({ kind: 'check', agentId, ok, command });
      },
      onGate: (g, round) => {
        const verdict = g.ok ? 'PASS' : g.ran ? `FAIL (exit ${g.exitCode})` : 'UNVERIFIABLE';
        log(`GATE round ${round}: ${verdict} — ${g.how}${g.command ? ` [${g.command}]` : ''}`);
        record({
          kind: 'gate',
          round,
          ok: g.ok,
          ran: g.ran,
          how: g.how,
          command: g.command,
          output: g.output,
        });
      },
      onActivity: (agentId, r) => {
        const a = seen(agentId);
        if (r.kind === 'turn-start') {
          a.turns += 1;
          log(`${agentId} · turn ${a.turns}`);
        }
        if (r.kind === 'tool') {
          a.tools[r.toolName] = (a.tools[r.toolName] ?? 0) + 1;
          log(
            `  ${agentId} → ${r.toolName}${r.detail ? `: ${String(r.detail).slice(0, 100)}` : ''}`,
          );
        }
        if (r.kind === 'file-write' && r.phase !== 'start') a.files.add(r.path);
        // Full fidelity to disk; only the interesting lines to the console.
        if (r.kind !== 'assistant-text' && r.kind !== 'thinking') record({ agentId, ...r });
        if (r.kind === 'assistant-text' && r.phase === 'end') {
          a.lastText = String(r.text ?? '').slice(0, 4000);
          record({ agentId, kind: 'said', text: a.lastText });
        }
      },
    });
  } finally {
    clearTimeout(budget);
  }

  for (const hop of result.hops) record({ kind: 'hop', ...hop });

  const files = productFiles(WORKSPACE);
  const summary = {
    task: TASK_NAME,
    gate: result.gate,
    blockedCapabilities: result.blocked,
    capabilities: result.capabilities,
    wallSeconds: Math.round((Date.now() - t0) / 1000),
    turns: result.turns,
    hops: result.hops.length,
    ceoReply: result.reply.slice(0, 4000),
    agents: [...agents.entries()].map(([id, a]) => ({
      id,
      turns: a.turns,
      tools: a.tools,
      files: [...a.files],
    })),
    files,
    productBytes: files.reduce((n, f) => n + f.bytes, 0),
  };
  writeFileSync(path.join(RUN_DIR, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

  console.log('\n──────── corp mesh run ────────');
  console.log(`task            ${TASK_NAME}`);
  console.log(`wall            ${summary.wallSeconds}s`);
  console.log(`agent turns     ${result.turns}   hops ${result.hops.length}`);
  for (const a of summary.agents) {
    const tools = Object.entries(a.tools)
      .map(([n, c]) => `${n}×${c}`)
      .join(' ');
    console.log(`  ${a.id.padEnd(22)} turns ${String(a.turns).padStart(3)}  ${tools}`);
  }
  const g = result.gate;
  console.log(
    `\nGATE            ${g.ok ? 'PASS' : g.ran ? 'FAIL' : 'UNVERIFIABLE'} · ${g.how}` +
      `${g.command ? `\n                ${g.command}` : ''}`,
  );
  if (!g.ok)
    console.log(`                ${g.output.split('\n').slice(-6).join('\n                ')}`);
  if (result.blocked.length > 0) console.log(`BLOCKED         ${result.blocked.join(', ')}`);

  console.log(`\nproduct         ${files.length} file(s), ${summary.productBytes} bytes`);
  for (const f of files.slice(0, 40)) console.log(`  ${f.bytes.toString().padStart(8)}  ${f.path}`);
  console.log(`\nartifacts       ${RUN_DIR}`);
  console.log(`CEO said: ${result.reply.slice(0, 600)}`);

  /*
   * THE GATE. Deliberately about the ARTIFACT, never the conversation: a run that
   * talks beautifully and writes nothing has failed, and that is the exact failure
   * mode this whole rebuild exists to catch.
   */
  const nonTrivial = files.filter((f) => f.bytes > 64);

  /*
   * THE HELD-OUT CHECK. The product gate runs the TEAM'S tests, so it can only ask
   * "is this self-consistent?" — and run 14 went green while failing YAML->CSV,
   * because the suite tested the limitation the team had built rather than the
   * requirement it was given. For the named benchmark targets the harness keeps
   * its own acceptance check, never shown to the team, run on inputs the product
   * has never seen. DELIVERED means both agree.
   */
  const acceptanceScript = path.join(appRoot, 'tests/e2e/acceptance', `${TASK_NAME}-acceptance.py`);
  let accepted;
  if (existsSync(acceptanceScript)) {
    const res = spawnSync('python3', [acceptanceScript, WORKSPACE], {
      encoding: 'utf8',
      timeout: 300_000,
    });
    const out = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
    accepted = res.status === 0;
    console.log(`\nHELD-OUT CHECK  ${accepted ? 'PASS' : 'FAIL'}`);
    if (out !== '') console.log(out.split('\n').map((l) => `                ${l}`).join('\n'));
    record({ kind: 'acceptance', ok: accepted, output: out.slice(0, 4000) });
  }

  const delivered = nonTrivial.length > 0 && g.ok && accepted !== false;
  const verdict = delivered
    ? 'DELIVERED — the product exists, passes its own check, and passes the held-out check'
    : nonTrivial.length > 0
      ? `INCOMPLETE — built a product but ${!g.ok ? 'its own check fails' : 'it fails the held-out check'}`
      : 'NO PRODUCT — talked, built nothing';
  console.log(`\nVERDICT: ${verdict}`);
  killServer();
  process.exit(delivered ? 0 : 1);
}

main().catch((e) => {
  log('FAILED', e?.stack || e);
  record({ kind: 'run-error', error: String(e?.stack || e) });
  killServer();
  process.exit(1);
});
