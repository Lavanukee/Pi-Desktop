/**
 * Fast VISION-ONLY probe: start the server, run JUST the CEO vision agent turn via
 * the production seam, and dump the full raw output (toolCalls, finalText,
 * filesWritten) so we can see WHY the brief came back empty and tune the prompt.
 *   node scratchpad/vision-probe.mjs
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
  'Build a small browser-based Pomodoro focus timer as a single self-contained web app: a clean, calm UI with start/pause/reset, a 25-minute focus block, a short-break reminder, and a session counter.';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const SEAM_IMPL_TS = path.join(repoRoot, 'apps', 'desktop', 'electron', 'corp', 'role-agent-seam-impl.ts');
const CORP_INDEX_TS = path.join(repoRoot, 'packages', 'harness', 'src', 'corp', 'index.ts');
const SEARCH_TS = path.join(repoRoot, 'packages', 'web-tools', 'src', 'search.ts');
const RUN_DIR = mkdtempSync(path.join(os.tmpdir(), 'vision-probe-'));
const SERVER_LOG = path.join(RUN_DIR, 'server.log');
const WORKSPACE = path.join(RUN_DIR, 'ws');
mkdirSync(WORKSPACE, { recursive: true });
const log = (...a) => console.error(`[${new Date().toISOString()}] ${a.join(' ')}`);

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

for (const [p, what] of [[SERVER_BIN, 'server'], [MODEL_GGUF, 'gguf'], [CHAT_TEMPLATE, 'template']]) {
  if (!existsSync(p)) { console.log(`SKIP missing ${what}`); process.exit(0); }
}

let serverProc = null;
function startServer() {
  const a = ['-m', MODEL_GGUF, '--host', HOST, '--port', String(PORT), '-c', '16384',
    '--parallel', '1', '--spec-type', 'draft-mtp', '--spec-draft-n-max', '2', '--jinja',
    '--chat-template-file', CHAT_TEMPLATE];
  serverProc = spawn(SERVER_BIN, a, { stdio: ['ignore', 'pipe', 'pipe'] });
  const append = (d) => { try { appendFileSync(SERVER_LOG, d); } catch {} };
  serverProc.stdout.on('data', append);
  serverProc.stderr.on('data', append);
}
function killServer() { if (serverProc && !serverProc.killed) { try { serverProc.kill('SIGKILL'); } catch {} } }
async function waitForHealth(timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (serverProc && serverProc.exitCode !== null) throw new Error('server exited early');
    try { const r = await fetch(HEALTH_URL); if (r.ok) { const j = await r.json().catch(() => ({})); if (!j.status || j.status === 'ok') return; } } catch {}
    await new Promise((res) => setTimeout(res, 750));
  }
  throw new Error('server never healthy');
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { killServer(); process.exit(1); });
process.on('uncaughtException', (e) => { log('uncaught', e?.stack || e); killServer(); process.exit(1); });

async function main() {
  startServer();
  await waitForHealth();
  log('server healthy');

  const corp = await import(pathToFileURL(CORP_INDEX_TS).href);
  const { createRunRoleAgent } = await import(pathToFileURL(SEAM_IMPL_TS).href);
  const search = await import(pathToFileURL(SEARCH_TS).href);
  const {
    CEO_VISION_PROMPT, buildCeoVisionPrompt, SUBMIT_VISION_TOOL, parseVisionBrief,
    samplingModeForPurpose, roleThinkingEnabled, MAX_VISION_BUMPS, VISION_BUMP_PROMPT,
  } = corp;

  const backends = search.resolveSearchBackends(search.webSearchConfigFromEnv());
  const webResearchFactory = (pi) => {
    pi.registerTool({
      name: 'web_search', label: 'Web Search',
      description: 'Search the web. Returns a ranked list of results with title, URL, and snippet.',
      promptSnippet: 'Search the web for up-to-date information',
      parameters: { type: 'object', properties: { query: { type: 'string' }, count: { type: 'number' } }, required: ['query'] },
      async execute(_id, params, signal) {
        const o = await search.runWebSearch(backends, params.query, { count: search.boundCount(params.count), signal });
        const lines = o.results.map((r, i) => `[${i + 1}] ${r.title}\n    ${r.url}\n    ${r.snippet}`);
        return { content: [{ type: 'text', text: `${o.results.length} result(s) via ${o.backend}\n\n${lines.join('\n\n')}`.trim() }], details: { backend: o.backend } };
      },
    });
  };

  const seam = createRunRoleAgent({ baseUrl: BASE_URL, model: MODEL_ID, webResearchFactory });

  log('running vision turn…');
  const t0 = Date.now();
  const out = await seam({
    purpose: 'vision',
    systemPrompt: CEO_VISION_PROMPT,
    userPrompt: buildCeoVisionPrompt(TASK),
    tools: ['read', 'write', 'bash', 'web_search', 'web_fetch', 'submit_vision'],
    customTools: [SUBMIT_VISION_TOOL],
    cwd: WORKSPACE,
    isolation: { seed: [], harvest: false },
    thinking: roleThinkingEnabled('ceo'),
    samplingMode: samplingModeForPurpose('vision'),
    maxTokens: 8192,
    bump: { maxBumps: MAX_VISION_BUMPS, continuePrompt: VISION_BUMP_PROMPT },
  });
  const wallMs = Date.now() - t0;
  const brief = parseVisionBrief(out.toolCalls, out.finalText);

  console.log(JSON.stringify({
    wallSec: (wallMs / 1000).toFixed(1),
    turns: out.turns,
    terminatedReason: out.terminatedReason,
    maxTurnOutputTokens: out.maxTurnOutputTokens,
    toolCalls: out.toolCalls.map((c) => ({ name: c.name, args: typeof c.arguments === 'string' ? c.arguments.slice(0, 200) : JSON.stringify(c.arguments).slice(0, 400) })),
    filesWritten: out.filesWritten,
    finalTextLen: (out.finalText || '').length,
    finalTextPreview: (out.finalText || '').slice(0, 600),
    parsedBriefLen: brief.length,
    parsedBriefPreview: brief.slice(0, 600),
  }, null, 2));
}

main().then(() => { killServer(); process.exit(0); }).catch((e) => { log('FAIL', e?.stack || e); killServer(); process.exit(1); });
