/**
 * THE MANAGER PROMPT, ITERATED IN A MINUTE INSTEAD OF FORTY.
 *
 * jedd's loop: hand the manager a real vision, look at the contracts it writes,
 * fix the prompt, repeat. A full corp run takes 30-40 minutes and confounds the
 * manager's decomposition with everything downstream of it; this runs ONE manager
 * turn and prints, verbatim, every message it sends to an engineer.
 *
 * The engineers are stubs. They accept the work and say they are on it, so the
 * manager's first act of decomposition is isolated: nothing it hears back can
 * flatter or rescue a bad brief. What comes out is exactly the thing being
 * judged — did it break the vision into pieces a person could pick up and build?
 *
 *   node tests/e2e/manager-brief-probe.mjs [--task desktop] [--engineers 4]
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
const PORT = Number(process.env.PORT ?? 8176);
const BASE_URL = `http://127.0.0.1:${PORT}/v1`;
const MODEL_ID = 'qwen3.5-4b';

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d;
};
const ENGINEERS = Number(flag('engineers', '4'));

const TASKS = {
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
  converter:
    'Build a small offline file-conversion tool in this directory. It must convert ' +
    'between exactly three formats to start: JSON, CSV, and YAML — any of the three ' +
    'to any other. Provide a command-line entry point that takes an input file and ' +
    'an output file and does the conversion.',
};
const taskArg = flag('task', 'desktop');
const TASK = TASKS[taskArg] ?? taskArg;

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MESH_HOST_TS = path.join(appRoot, 'electron', 'corp', 'mesh-host.ts');
const ROLE_AGENT_TS = path.join(appRoot, 'electron', 'corp', 'role-agent.ts');
const WORKSPACE = mkdtempSync(path.join('/tmp', 'mgr-probe-'));
mkdirSync(WORKSPACE, { recursive: true });

const t0 = Date.now();
const since = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (...a) => console.error(`[${since()}] ${a.join(' ')}`);

register(
  `data:text/javascript,${encodeURIComponent(`
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
}`)}`,
);

for (const [p, what] of [
  [SERVER_BIN, 'llama-server'],
  [MODEL_GGUF, 'model gguf'],
  [CHAT_TEMPLATE, 'chat template'],
]) {
  if (!existsSync(p)) {
    console.log(`SKIPPED: missing ${what}`);
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
for (const sig of ['SIGINT', 'SIGTERM'])
  process.on(sig, () => {
    killServer();
    process.exit(1);
  });

async function main() {
  serverProc = spawn(
    SERVER_BIN,
    // prettier-ignore
    ['-m', MODEL_GGUF, '--host', '127.0.0.1', '--port', String(PORT), '-c', '32768',
     '--parallel', '1', '--spec-type', 'draft-mtp', '--spec-draft-n-max', '2',
     '--jinja', '--chat-template-file', CHAT_TEMPLATE],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (r.ok) break;
    } catch {}
    await new Promise((res) => setTimeout(res, 750));
  }
  log('server up · task:', taskArg, '· workspace:', WORKSPACE);

  const roleMod = await import(pathToFileURL(ROLE_AGENT_TS).href);
  const meshMod = await import(pathToFileURL(MESH_HOST_TS).href);
  const harness = await import('@pi-desktop/harness/corp');
  const handle = await roleMod.createCorpModelProvider({ baseUrl: BASE_URL, model: MODEL_ID });

  const roster = harness.buildCorpRoster({ task: TASK, engineerCount: ENGINEERS });
  const real = meshMod.createMeshAgentHost({
    handle,
    cwd: WORKSPACE,
    roster,
    task: TASK,
    maxStepsPerMessage: 24,
    onActivity: (id, r) => {
      if (r.kind === 'turn-start') log(`  ${id} · turn`);
      if (r.kind === 'tool') log(`  ${id} → ${r.toolName}`);
    },
  });

  /** The contracts, captured as they are sent. */
  const contracts = [];
  const run = async (turn) => {
    if (turn.agentId === 'manager') return await real(turn);
    // Stubs. They must not help: a canned "on it" cannot rescue a vague brief.
    if (turn.from === 'manager') contracts.push({ to: turn.agentId, message: turn.message });
    return { reply: `Understood, starting on that now. I will report back when it runs.` };
  };
  const mesh = new harness.AgentMesh(run, roster);

  const vision =
    `Message from ceo:\nThe user asked for this, verbatim:\n\n${TASK}\n\n` +
    `Break it up and get it built. Report back when the team has it running.`;
  log('sending the vision to the manager…');
  // `run` drives a root agent directly, which is what the real driver does with
  // the CEO. Here the manager IS the root, so its decomposition is the only
  // thing under test.
  const reply = await mesh.run('manager', vision);

  console.log(`\n${'='.repeat(78)}\nCONTRACTS THE MANAGER WROTE: ${contracts.length}\n${'='.repeat(78)}`);
  contracts.forEach((c, i) => {
    console.log(`\n──── ${i + 1}. to ${c.to} ────`);
    console.log(c.message);
  });
  console.log(`\n${'='.repeat(78)}\nMANAGER'S REPLY TO THE CEO\n${'='.repeat(78)}\n${reply}`);

  const distinct = new Set(contracts.map((c) => c.to));
  console.log(
    `\nSUMMARY: ${contracts.length} contract(s) to ${distinct.size} engineer(s) of ${ENGINEERS} available · ${since()}`,
  );
  try {
    appendFileSync(
      path.join('/tmp', 'manager-probe.jsonl'),
      `${JSON.stringify({ task: taskArg, contracts, reply })}\n`,
    );
  } catch {}
  killServer();
  process.exit(0);
}

main().catch((e) => {
  log('FAILED', e?.stack || e);
  killServer();
  process.exit(1);
});
