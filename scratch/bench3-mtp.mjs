#!/usr/bin/env node
/**
 * bench3-mtp.mjs — confirm the MTP --spec-draft-n-max sweet spot with repeats.
 * Launch once per n value; run {code, prose} prompts × TRIALS; report mean/min/max
 * decode tps. Decode tps is noisy, so we need repeats before changing a default.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const SERVER = '/Users/jedd/.cache/pi-desktop/llamacpp/b9934/llama-b9934/llama-server';
const MODEL = '/Users/jedd/.cache/pi-desktop/models/qwen3.5-4b-mtp/Qwen3.5-4B-Q8_0.gguf';
const TRIALS = 3;
const NVALUES = [2, 3, 4];

const SAMPLING = ['--temp', '0.8', '--top-p', '0.9', '--top-k', '50', '--min-p', '0.0',
  '--presence-penalty', '0.0', '--repeat-penalty', '1.0', '--dry-multiplier', '1.0',
  '--dry-base', '1.75', '--dry-allowed-length', '70', '--dry-penalty-last-n', '4096'];
const REASONING = ['--reasoning-preserve', '--reasoning-budget', '-1',
  '--reasoning-budget-message', 'time limit for reasoning reached'];
const CTX = ['-c', '8192', '--parallel', '1'];

const PROMPTS = {
  code: 'Write a Python function `quicksort(arr)` that sorts a list in place using the ' +
    'Lomuto partition scheme, with a docstring, then show a usage example.',
  prose: 'Explain, in one clear paragraph, why speculative decoding speeds up LLM ' +
    'inference and what determines its acceptance rate.',
};

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
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}
async function launch(perf, port) {
  const child = spawn(SERVER, ['-m', MODEL, '--host', '127.0.0.1', '--port', String(port),
    ...CTX, ...SAMPLING, ...REASONING, ...perf], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; child.stderr.on('data', (d) => { err += String(d); });
  if (!(await waitHealth(port))) { child.kill('SIGKILL'); throw new Error(err.slice(-500)); }
  return child;
}
async function decodeTps(port, content, maxTokens) {
  const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content }], max_tokens: maxTokens,
      temperature: 0, cache_prompt: false, stream: false }),
  });
  const j = await r.json();
  return { tps: j.timings?.predicted_per_second, n: j.timings?.predicted_n };
}
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

async function main() {
  const results = {};
  for (const n of NVALUES) {
    const port = await freePort();
    const child = await launch(['--spec-type', 'draft-mtp', '--spec-draft-n-max', String(n)], port);
    try {
      await decodeTps(port, 'hi', 4); // warmup
      for (const [pname, content] of Object.entries(PROMPTS)) {
        const samples = [];
        for (let t = 0; t < TRIALS; t++) {
          // vary content slightly per trial to avoid identical-cache short-circuit on decode
          const res = await decodeTps(port, `${content} (variant ${t})`, 200);
          if (res.tps) samples.push(res.tps);
        }
        results[`n=${n} ${pname}`] = samples;
      }
    } finally {
      child.kill('SIGTERM'); await new Promise((r) => setTimeout(r, 700)); child.kill('SIGKILL');
    }
  }
  const rows = Object.entries(results).map(([k, s]) => ({
    config: k,
    mean_tps: Number(mean(s).toFixed(1)),
    min: Number(Math.min(...s).toFixed(1)),
    max: Number(Math.max(...s).toFixed(1)),
    n_samples: s.length,
  }));
  console.table(rows);
  // aggregate per n
  console.log('\nPer-n mean decode tps (across both prompt types):');
  for (const n of NVALUES) {
    const all = [...(results[`n=${n} code`] ?? []), ...(results[`n=${n} prose`] ?? [])];
    console.log(`  n=${n}: ${mean(all).toFixed(1)} tps`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
