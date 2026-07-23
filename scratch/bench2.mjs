#!/usr/bin/env node
/**
 * bench2.mjs — two targeted follow-ups to prefill-bench.mjs:
 *   (A) LONG-prompt prefill throughput vs ubatch/flash-attn (where batch size
 *       actually matters — the ~1k-token first bench was GPU-saturated already).
 *   (B) MTP speculative-decode DECODE speedup (embedded head in the Q8 gguf) and
 *       real client-observed TTFT (counting reasoning_content, which the first
 *       bench missed for this reasoning model).
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const SERVER = '/Users/jedd/.cache/pi-desktop/llamacpp/b9934/llama-b9934/llama-server';
const MODEL = '/Users/jedd/.cache/pi-desktop/models/qwen3.5-4b-mtp/Qwen3.5-4B-Q8_0.gguf';

const SAMPLING = [
  '--temp', '0.8', '--top-p', '0.9', '--top-k', '50', '--min-p', '0.0',
  '--presence-penalty', '0.0', '--repeat-penalty', '1.0',
  '--dry-multiplier', '1.0', '--dry-base', '1.75', '--dry-allowed-length', '70',
  '--dry-penalty-last-n', '4096',
];
const REASONING = ['--reasoning-preserve', '--reasoning-budget', '-1',
  '--reasoning-budget-message', 'time limit for reasoning reached'];
const CTX = ['-c', '8192', '--parallel', '1'];

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
async function waitHealth(port, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) return true; } catch {}
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
  if (!ok) { child.kill('SIGKILL'); throw new Error(`unhealthy:\n${stderr.slice(-600)}`); }
  return child;
}
async function chatStream(port, messages, maxTokens) {
  const t0 = performance.now();
  const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages, max_tokens: maxTokens, temperature: 0, cache_prompt: true,
      stream: true, stream_options: { include_usage: true } }),
  });
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let ttft = null, buf = '', timings = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const p = line.slice(6).trim();
      if (p === '[DONE]') continue;
      let o; try { o = JSON.parse(p); } catch { continue; }
      const d = o.choices?.[0]?.delta;
      const tok = d?.content || d?.reasoning_content; // reasoning model emits think tokens first
      if (ttft === null && tok) ttft = performance.now() - t0;
      if (o.timings) timings = o.timings;
    }
  }
  return { ttftMs: ttft, timings };
}
const r1 = (x) => (x == null ? null : Number(x.toFixed(1)));

// ~6000-token prompt (each config gets a UNIQUE tag so no cross-config cache).
function longPrompt(tag) {
  const para =
    'You are a capable local coding assistant running fully offline. Follow user ' +
    'instructions precisely, prefer minimal surgical edits, explain reasoning briefly, ' +
    'use tools when needed, and never fabricate file contents. ';
  return `UNIQUE-${tag}\n` + para.repeat(90) +
    '\n\nList three considerations when optimizing transformer inference latency.';
}

async function benchPrefill() {
  console.log('\n########## (A) LONG-PROMPT PREFILL (~6k tokens) ##########');
  const configs = {
    'baseline(ub512,fa auto)': [],
    'ub1024': ['-ub', '1024', '-b', '2048'],
    'ub2048': ['-ub', '2048', '-b', '2048'],
    'fa-on+ub2048': ['-fa', 'on', '-ub', '2048', '-b', '2048'],
  };
  const rows = [];
  for (const [name, perf] of Object.entries(configs)) {
    const port = await freePort();
    const child = await launch(perf, port);
    try {
      await chatStream(port, [{ role: 'user', content: 'hi' }], 4); // warmup shaders
      const res = await chatStream(port,
        [{ role: 'user', content: longPrompt(name) }], 8);
      rows.push({
        config: name,
        prompt_n: res.timings?.prompt_n,
        prefill_ms: r1(res.timings?.prompt_ms),
        prefill_tps: r1(res.timings?.prompt_per_second),
        ttft_ms: r1(res.ttftMs),
      });
    } finally {
      child.kill('SIGTERM'); await new Promise((r) => setTimeout(r, 700)); child.kill('SIGKILL');
    }
  }
  console.table(rows);
}

async function benchDecode() {
  console.log('\n########## (B) MTP SPECULATIVE-DECODE — decode tps ##########');
  const configs = {
    'no-spec': [],
    'mtp-n2': ['--spec-type', 'draft-mtp', '--spec-draft-n-max', '2'],
    'mtp-n3': ['--spec-type', 'draft-mtp', '--spec-draft-n-max', '3'],
    'mtp-n5': ['--spec-type', 'draft-mtp', '--spec-draft-n-max', '5'],
  };
  const prompt = [
    { role: 'user', content: 'Write a short Python function that returns the nth Fibonacci ' +
      'number iteratively, then explain how it works in two sentences.' },
  ];
  const rows = [];
  for (const [name, perf] of Object.entries(configs)) {
    const port = await freePort();
    let child;
    try { child = await launch(perf, port); }
    catch (e) { rows.push({ config: name, decode_tps: 'LAUNCH FAIL', note: e.message.slice(0, 60) }); continue; }
    try {
      await chatStream(port, [{ role: 'user', content: 'hi' }], 4);
      const res = await chatStream(port, prompt, 220);
      rows.push({
        config: name,
        predicted_n: res.timings?.predicted_n,
        decode_tps: r1(res.timings?.predicted_per_second),
        ttft_ms: r1(res.ttftMs),
        prefill_ms: r1(res.timings?.prompt_ms),
      });
    } finally {
      child.kill('SIGTERM'); await new Promise((r) => setTimeout(r, 700)); child.kill('SIGKILL');
    }
  }
  console.table(rows);
}

async function main() {
  await benchPrefill();
  await benchDecode();
}
main().catch((e) => { console.error(e); process.exit(1); });
