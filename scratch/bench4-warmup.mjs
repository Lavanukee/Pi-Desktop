#!/usr/bin/env node
/**
 * bench4-warmup.mjs — quantify the Metal shader-compile penalty paid by the FIRST
 * request after a fresh llama-server start (which a post-ready warmup would hide).
 * Launch, then send a real ~1k-token prompt with NO prior warmup; then two more
 * equivalent (unique) prompts. The first minus the steady-state = the warmup win.
 * Repeated over several fresh launches to average out noise.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const SERVER = '/Users/jedd/.cache/pi-desktop/llamacpp/b9934/llama-b9934/llama-server';
const MODEL = '/Users/jedd/.cache/pi-desktop/models/qwen3.5-4b-mtp/Qwen3.5-4B-Q8_0.gguf';
const ARGS = ['-c', '8192', '--parallel', '1', '--spec-type', 'draft-mtp', '--spec-draft-n-max', '2'];
const LAUNCHES = 4;

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer(); s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
async function waitHealth(port) {
  const d = Date.now() + 90_000;
  while (Date.now() < d) {
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}
async function req(port, content) {
  const t0 = performance.now();
  const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content }], max_tokens: 8,
      temperature: 0, cache_prompt: false, stream: false }),
  });
  const j = await r.json();
  return { wallMs: performance.now() - t0, prefill_ms: j.timings?.prompt_ms, prompt_n: j.timings?.prompt_n };
}
function prompt(tag) {
  const para = 'You are a local coding assistant. Follow instructions precisely and ' +
    'explain reasoning briefly before acting. Never fabricate file contents. ';
  return `UNIQUE-${tag}\n` + para.repeat(16) + '\nName three things to consider for latency.';
}

async function main() {
  const first = [], second = [], third = [];
  for (let i = 0; i < LAUNCHES; i++) {
    const port = await freePort();
    const child = spawn(SERVER, ['-m', MODEL, '--host', '127.0.0.1', '--port', String(port), ...ARGS],
      { stdio: ['ignore', 'ignore', 'ignore'] });
    if (!(await waitHealth(port))) { child.kill('SIGKILL'); throw new Error('unhealthy'); }
    try {
      const a = await req(port, prompt(`L${i}-a`)); // COLD: first request, shaders not compiled
      const b = await req(port, prompt(`L${i}-b`)); // warm
      const c = await req(port, prompt(`L${i}-c`)); // warm
      first.push(a.prefill_ms); second.push(b.prefill_ms); third.push(c.prefill_ms);
      console.log(`launch ${i}: first=${a.prefill_ms?.toFixed(0)}ms (${a.prompt_n}tok)  ` +
        `second=${b.prefill_ms?.toFixed(0)}ms  third=${c.prefill_ms?.toFixed(0)}ms`);
    } finally {
      child.kill('SIGTERM'); await new Promise((r) => setTimeout(r, 600)); child.kill('SIGKILL');
    }
  }
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const mf = mean(first), ms = mean(second), mt = mean(third);
  console.log(`\nmean first-request prefill  : ${mf.toFixed(0)} ms  (COLD shaders)`);
  console.log(`mean second-request prefill : ${ms.toFixed(0)} ms  (warm)`);
  console.log(`mean third-request prefill  : ${mt.toFixed(0)} ms  (warm)`);
  console.log(`\n=> first-prompt penalty a warmup would hide: ~${(mf - (ms + mt) / 2).toFixed(0)} ms ` +
    `(${(((mf - (ms + mt) / 2) / mf) * 100).toFixed(0)}% of the first TTFT)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
