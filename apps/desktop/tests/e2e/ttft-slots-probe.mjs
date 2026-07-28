/**
 * ttft-slots-probe.mjs — TTFT plus the server's own account of WHY.
 *
 * ttft-probe says a follow-up is slow. This says whether it is slow because the
 * KV prefix was thrown away: llama-server's /slots reports `n_prompt_tokens`
 * (the whole prompt) against `n_prompt_tokens_processed` (what it actually had
 * to prefill). Reuse working = processed is a handful of tokens on a follow-up.
 * Reuse broken = processed ≈ the whole prompt, every turn.
 *
 * (`n_prompt_tokens_cache` reads 0 regardless — do not trust it.)
 *
 *   PORT       llama-server port (default: discovered from the running process)
 *   MESSAGES   "||"-separated
 *   MODEL/APP  as ttft-probe
 */
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { backgroundLaunch } from './_focus.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const MODEL = process.env.MODEL ?? 'qwen3.5-4b-mtp';
const MESSAGES = (process.env.MESSAGES ?? 'hi||hello again||once more').split('||');
const OUT = process.env.OUT ?? path.resolve(here, '..', '..', '..', '..', '.corp-runs', 'ttft');
const APP = process.env.APP ?? '/Applications/Bobble.app/Contents/MacOS/Bobble';
mkdirSync(OUT, { recursive: true });

function discoverPort() {
  if (process.env.PORT !== undefined) return Number(process.env.PORT);
  try {
    const ps = execSync('ps aux | grep llama-server | grep -v grep', { encoding: 'utf8' });
    const m = /--port (\d+)/.exec(ps);
    return m === null ? null : Number(m[1]);
  } catch {
    return null;
  }
}

const background = backgroundLaunch();
const app = await electron.launch({
  executablePath: APP,
  args: [`--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-slots-udd-'))}`],
  env: {
    ...process.env,
    HOME: homedir(),
    PI_E2E: '1',
    // Headed, but never the active app: the window renders (real GPU, honest
    // screenshots) without stealing focus mid-run. FOCUS=1 to opt out.
    ...background.env,
  },
});

const rows = [];
try {
  const win = await app.firstWindow();
  background.restore();
  await win.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 60_000 });
  await win.waitForSelector('[data-testid="composer-input"]', { timeout: 60_000 });
  await win.evaluate(async (modelId) => {
    await window.piDesktop.invoke('pi:start', {});
    await window.piDesktop.invoke('llm:start-server', { modelId });
  }, MODEL);
  await win.waitForFunction(
    () => window.__llm_store?.().getState().status.serverRunning === true,
    undefined,
    { timeout: 300_000 },
  );
  await win.evaluate(async (modelId) => {
    await window.piDesktop.invoke('pi:restart', {});
    await window.piDesktop.invoke('pi:set-model', { provider: 'llamacpp', modelId });
  }, MODEL);
  await win.waitForTimeout(8000);

  const port = discoverPort();
  if (port === null) throw new Error('no llama-server port found');
  console.log(`llama-server on ${port}\n`);

  // Poll /slots hard while a turn runs and keep every DISTINCT processing state.
  // A follow-up's prefill is over in well under a second when reuse works, so a
  // slow poll would miss the very sample that matters.
  const watch = async (ms, sink) => {
    const until = Date.now() + ms;
    let last = '';
    while (Date.now() < until) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/slots`);
        const [slot] = await res.json();
        const key = `${slot.id_task}|${slot.n_prompt_tokens}|${slot.n_prompt_tokens_processed}`;
        if (key !== last && slot.n_prompt_tokens > 0) {
          last = key;
          sink.push({
            task: slot.id_task,
            total: slot.n_prompt_tokens,
            processed: slot.n_prompt_tokens_processed,
          });
        }
      } catch {
        /* server busy — keep polling */
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  const count = () =>
    win.evaluate(() => {
      const m = window.__pi_store().getState().messages;
      const last = m[m.length - 1];
      const chars =
        last?.kind === 'assistant'
          ? (last.blocks ?? []).reduce((n, b) => n + (b.text ?? b.thinking ?? '').length, 0)
          : 0;
      return { rows: m.length, chars };
    });

  for (const message of MESSAGES) {
    const before = await count();
    await win.click('[data-testid="composer-input"]');
    await win.keyboard.type(message);
    const samples = [];
    const watching = watch(20_000, samples);
    const sentAt = Date.now();
    await win.keyboard.press('Enter');
    let ttft = null;
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const now = await count();
      if (now.rows > before.rows && now.chars > 0) {
        ttft = Date.now() - sentAt;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    await watching;
    // The turn's OWN prefill is the sample with the largest prompt — background
    // work (naming) shows up as its own task id with a different total.
    const turn = samples.reduce((a, b) => (b.total > (a?.total ?? -1) ? b : a), null);
    rows.push({ message, ttft, turn, samples });
    console.log(
      `${JSON.stringify(message.slice(0, 32))} → ${ttft}ms | prompt ${turn?.total ?? '?'} tok, ` +
        `PREFILLED ${turn?.processed ?? '?'} | ${samples.length} slot states`,
    );
    for (const s of samples) console.log(`      task ${s.task}: ${s.processed}/${s.total}`);
    await win
      .waitForFunction(
        () => {
          const s = window.__pi_store().getState();
          return s.agent.isStreaming !== true && s.promptInFlight !== true;
        },
        undefined,
        { timeout: 180_000 },
      )
      .catch(() => {});
    await win.waitForTimeout(2500);
  }
  writeFileSync(path.join(OUT, 'slots.json'), JSON.stringify(rows, null, 2));
} catch (err) {
  console.error(`ttft-slots-probe: ${err.message}`);
} finally {
  await app.close().catch(() => {});
}

console.log('\n──────── verdict ────────');
for (const r of rows) {
  const reused = r.turn === null ? null : r.turn.total - r.turn.processed;
  console.log(
    `  ${String(r.ttft ?? '?').padStart(6)}ms  reused ${String(reused ?? '?').padStart(6)} of ` +
      `${String(r.turn?.total ?? '?').padStart(6)} tokens  ${r.message.slice(0, 30)}`,
  );
}
