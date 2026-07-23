#!/usr/bin/env node
/**
 * prefill-bench.mjs — live A/B harness for llama-server launch args.
 *
 * Launches llama-server once per named config, waits for /health, then runs a
 * deterministic (temperature 0) cache-state matrix reading the AUTHORITATIVE
 * server `timings` block from /v1/chat/completions:
 *   - cold    : big fresh prompt → near-full prefill (prompt_n high, cache_n ~0)
 *   - hit     : identical resend → full KV reuse   (prompt_n ~0, cache_n high)
 *   - extend  : append assistant+user turn        → prefill only the delta
 *   - churn   : early insertion in the system text → re-prefill (the spike jedd feels)
 * plus a streaming cold request measuring real client-observed TTFT.
 *
 * This is the cache-hunter idea, inline: prompt_n / cache_n / prompt_ms tell us
 * exactly when KV is reused vs a full re-prefill is forced.
 *
 * Usage: node prefill-bench.mjs [--model PATH] [--only name1,name2]
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const SERVER = '/Users/jedd/.cache/pi-desktop/llamacpp/b9934/llama-b9934/llama-server';
const DEFAULT_MODEL = '/Users/jedd/.cache/pi-desktop/models/qwen3.5-4b-mtp/Qwen3.5-4B-Q8_0.gguf';

const argv = process.argv.slice(2);
const getOpt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const MODEL = getOpt('model', DEFAULT_MODEL);
const ONLY = getOpt('only', '');

// ---- shared, faithful arg groups ------------------------------------------
// The sampling/reasoning/spec args assembleServerArgs() emits today. Held
// CONSTANT across configs so we isolate the perf-arg contribution only.
const SAMPLING = [
  '--temp', '0.8', '--top-p', '0.9', '--top-k', '50', '--min-p', '0.0',
  '--presence-penalty', '0.0', '--repeat-penalty', '1.0',
  '--dry-multiplier', '1.0', '--dry-base', '1.75', '--dry-allowed-length', '70',
  '--dry-penalty-last-n', '4096',
];
const REASONING = [
  '--reasoning-preserve', '--reasoning-budget', '-1',
  '--reasoning-budget-message', 'time limit for reasoning reached',
];
const CTX = ['-c', '8192', '--parallel', '1'];
// NOTE: spec-decode (--spec-type draft-mtp) intentionally OMITTED here — it only
// affects DECODE, and this Q8 gguf has no separate MTP head wired; keeping it out
// keeps decode numbers comparable and avoids a launch failure on builds w/o it.

// Each config = extra PERF args appended after the shared groups.
const CONFIGS = {
  // Exactly today's fast-text single-slot launch (relies on -ngl auto / -fa auto).
  baseline: [],
  // One knob at a time (isolate each win):
  'cache-reuse': ['--cache-reuse', '256'],
  'ub-2048': ['-ub', '2048', '-b', '2048'],
  'fa-on': ['-fa', 'on'],
  'kv-q8': ['-fa', 'on', '--cache-type-k', 'q8_0', '--cache-type-v', 'q8_0'],
  // The combination we'd ship on Apple Silicon:
  tuned: [
    '-fa', 'on', '-ngl', '999', '--cache-reuse', '256',
    '-ub', '2048', '-b', '2048', '--mlock', '-t', '5', '--no-context-shift',
  ],
};

// ---- prompt construction (realistic ~agent system prompt + tools) ---------
function bigSystemPrompt(extraLine = '') {
  const toolBlock = JSON.stringify({
    name: 'read_file',
    description: 'Read a file from the local filesystem and return its contents.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file to read.' },
        offset: { type: 'number', description: 'Line to start from.' },
        limit: { type: 'number', description: 'Max lines to read.' },
      },
      required: ['path'],
    },
  });
  const para =
    'You are a capable local coding assistant running fully offline. Follow the ' +
    'user instructions precisely, prefer minimal surgical edits, and always explain ' +
    'your reasoning briefly before acting. Use the available tools when needed and ' +
    'never fabricate file contents. Keep responses focused and technically precise. ';
  // Repeat to reach a realistic ~1.5-2k token prefix.
  let sys = 'SYSTEM INSTRUCTIONS\n';
  if (extraLine) sys += extraLine + '\n'; // early insertion → the churn case
  sys += para.repeat(6) + '\n\nAVAILABLE TOOLS:\n';
  for (let i = 0; i < 8; i++) sys += toolBlock + '\n';
  sys += '\nEND OF SYSTEM INSTRUCTIONS. Await the user request.';
  return sys;
}

const U1 = 'Explain what a KV cache is in a transformer inference server, in exactly three sentences.';
const A1 =
  'A KV cache stores the key and value tensors computed for every prior token so ' +
  'they are not recomputed on each step. It lets the server prefill a shared prompt ' +
  'prefix once and reuse it across turns. This makes multi-turn latency depend only ' +
  'on the new tokens rather than the whole growing context.';
const U2 = 'Now explain prefix caching and when it is invalidated, in exactly three sentences.';

// ---- server lifecycle -----------------------------------------------------
function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
}

async function waitHealth(port, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function launch(perfArgs, port) {
  const args = ['-m', MODEL, '--host', '127.0.0.1', '--port', String(port),
    ...CTX, ...SAMPLING, ...REASONING, ...perfArgs];
  const child = spawn(SERVER, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += String(d); });
  const ok = await waitHealth(port);
  if (!ok) {
    child.kill('SIGKILL');
    throw new Error(`server never healthy. stderr tail:\n${stderr.slice(-800)}`);
  }
  return { child, argv: args };
}

// ---- request helpers ------------------------------------------------------
async function chat(port, messages, { maxTokens = 48, stream = false } = {}) {
  const body = {
    messages, max_tokens: maxTokens, temperature: 0, cache_prompt: true, stream,
  };
  if (!stream) {
    const t0 = performance.now();
    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    const wall = performance.now() - t0;
    return { timings: j.timings, usage: j.usage, wallMs: wall };
  }
  // streaming: measure client TTFT (time to first content delta)
  const t0 = performance.now();
  const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let ttft = null, buf = '', timings = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6).trim();
      if (payload === '[DONE]') continue;
      let obj; try { obj = JSON.parse(payload); } catch { continue; }
      const delta = obj.choices?.[0]?.delta?.content;
      if (ttft === null && delta) ttft = performance.now() - t0;
      if (obj.timings) timings = obj.timings;
    }
  }
  return { ttftMs: ttft, timings };
}

function round(x, d = 1) { return x === undefined || x === null ? null : Number(x.toFixed(d)); }

// ---- scenario -------------------------------------------------------------
async function runScenario(port) {
  const sys = bigSystemPrompt();
  const sysChurn = bigSystemPrompt('Current session id: 7f3a-CHANGED-EARLY-INSERTION-2026.');
  const base = [{ role: 'system', content: sys }, { role: 'user', content: U1 }];

  // warmup so Metal shaders are compiled (fair TTFT — matches 2nd+ user prompt).
  await chat(port, [{ role: 'user', content: 'hi' }], { maxTokens: 4 });

  const cold = await chat(port, base);
  const hit = await chat(port, base); // identical resend
  const extend = await chat(port, [
    ...base, { role: 'assistant', content: A1 }, { role: 'user', content: U2 },
  ]);
  const churn = await chat(port, [
    { role: 'system', content: sysChurn }, { role: 'user', content: U1 },
  ]);
  // streaming cold TTFT: use a distinct prompt so the slot cache doesn't short-circuit it
  const streamCold = await chat(port, [
    { role: 'system', content: bigSystemPrompt('Fresh unique prefix 918273 for a cold TTFT read.') },
    { role: 'user', content: 'Summarize the above system prompt in one sentence.' },
  ], { stream: true, maxTokens: 24 });

  const row = (label, res) => ({
    phase: label,
    prompt_n: res.timings?.prompt_n,
    cache_n: res.timings?.cache_n,
    prefill_ms: round(res.timings?.prompt_ms),
    prefill_tps: round(res.timings?.prompt_per_second),
    decode_tps: round(res.timings?.predicted_per_second),
  });
  return {
    matrix: [row('cold', cold), row('hit', hit), row('extend', extend), row('churn', churn)],
    streamTtftMs: round(streamCold.ttftMs),
    streamPrefillMs: round(streamCold.timings?.prompt_ms),
  };
}

// ---- main -----------------------------------------------------------------
async function main() {
  const names = ONLY ? ONLY.split(',') : Object.keys(CONFIGS);
  const results = {};
  for (const name of names) {
    const perfArgs = CONFIGS[name];
    if (!perfArgs) { console.error(`unknown config: ${name}`); continue; }
    const port = await freePort();
    process.stdout.write(`\n=== ${name}  (perf args: ${perfArgs.join(' ') || '(none)'}) ===\n`);
    let srv;
    try {
      srv = await launch(perfArgs, port);
    } catch (e) {
      console.error(`  LAUNCH FAILED: ${e.message}`);
      continue;
    }
    try {
      const r = await runScenario(port);
      results[name] = r;
      console.table(r.matrix);
      console.log(`  stream cold TTFT (client): ${r.streamTtftMs} ms   (server prefill ${r.streamPrefillMs} ms)`);
    } finally {
      srv.child.kill('SIGTERM');
      await new Promise((res) => setTimeout(res, 800));
      srv.child.kill('SIGKILL');
    }
  }

  // ---- comparison summary --------------------------------------------------
  console.log('\n\n================ SUMMARY (vs baseline) ================');
  const b = results.baseline;
  const cell = (r, phase, key) => r?.matrix.find((m) => m.phase === phase)?.[key];
  for (const name of Object.keys(results)) {
    const r = results[name];
    const coldTps = cell(r, 'cold', 'prefill_tps');
    const coldMs = cell(r, 'cold', 'prefill_ms');
    const decTps = cell(r, 'cold', 'decode_tps');
    const hitPrompt = cell(r, 'hit', 'prompt_n');
    const hitCache = cell(r, 'hit', 'cache_n');
    const churnPrompt = cell(r, 'churn', 'prompt_n');
    const churnMs = cell(r, 'churn', 'prefill_ms');
    let delta = '';
    if (b && name !== 'baseline') {
      const bMs = cell(b, 'cold', 'prefill_ms');
      const bDec = cell(b, 'cold', 'decode_tps');
      if (bMs && coldMs) delta += ` prefill ${(((bMs - coldMs) / bMs) * 100).toFixed(0)}% faster`;
      if (bDec && decTps) delta += ` | decode ${(((decTps - bDec) / bDec) * 100).toFixed(0)}%`;
    }
    console.log(
      `${name.padEnd(13)} cold: ${String(coldMs).padStart(7)}ms @${String(coldTps).padStart(6)} tps | ` +
      `decode ${String(decTps).padStart(5)} tps | hit(prompt/cache ${hitPrompt}/${hitCache}) | ` +
      `churn ${churnPrompt}tok/${churnMs}ms${delta}`);
  }
  console.log('=======================================================\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
