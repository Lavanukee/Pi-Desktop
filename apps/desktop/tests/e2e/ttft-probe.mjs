/**
 * ttft-probe.mjs — how long until the first token, in the REAL app, with a REAL model.
 *
 * This is the only way to tell whether the prefix-cache work is still working.
 * The warm-up, the frozen system prompt and the attachment prefill are all
 * invisible from the outside: when they break, nothing errors — the app just
 * pays a full cold prefill on every message and feels slow.
 *
 * Drives the packaged app the way the latency work was originally verified:
 * pi:start → llm:start-server → wait serverRunning → pi:restart → pi:set-model,
 * because auto-preload does NOT wire the server under Playwright. Then it times
 * from Enter to the first assistant token.
 *
 *   MODEL      model id to serve (default qwen3.5-4b-mtp)
 *   MESSAGES   messages to time, "||"-separated (default two short ones)
 *   PASTE      chars of filler to paste as an attachment before the last message
 *   WAIT_MS    ms to idle after the paste before sending (default 14000 — a big
 *              prefill takes ~6s and sending early ABORTS it, which reads as cold)
 *   APP        app binary (default the installed Bobble.app)
 *
 * Prints a per-message TTFT table. Exits non-zero if the first message is slower
 * than SLOW_MS (default 1200) — that is the regression this exists to catch.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { backgroundLaunch } from './_focus.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const MODEL = process.env.MODEL ?? 'qwen3.5-4b-mtp';
const MESSAGES = (process.env.MESSAGES ?? 'hi||what is the capital of France?').split('||');
const PASTE = Number(process.env.PASTE ?? 0);
const WAIT_MS = Number(process.env.WAIT_MS ?? 14_000);
const SLOW_MS = Number(process.env.SLOW_MS ?? 1200);
const OUT = process.env.OUT ?? path.resolve(here, '..', '..', '..', '..', '.corp-runs', 'ttft');
const APP = process.env.APP ?? '/Applications/Bobble.app/Contents/MacOS/Bobble';

mkdirSync(OUT, { recursive: true });
const results = [];

const background = backgroundLaunch();
const app = await electron.launch({
  executablePath: APP,
  args: [`--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-ttft-udd-'))}`],
  env: {
    ...process.env,
    HOME: homedir(),
    PI_E2E: '1',
    // Headed, but never the active app: the window renders (real GPU, honest
    // screenshots) without stealing focus mid-run. FOCUS=1 to opt out.
    ...background.env,
  },
});

try {
  const win = await app.firstWindow();
  background.restore();
  await win.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 60_000 });
  await win.waitForSelector('[data-testid="composer-input"]', { timeout: 60_000 });

  console.log(`starting ${MODEL}…`);
  const started = Date.now();
  await win.evaluate(async (modelId) => {
    await window.piDesktop.invoke('pi:start', {});
    await window.piDesktop.invoke('llm:start-server', { modelId });
  }, MODEL);
  await win.waitForFunction(
    () => window.__llm_store?.().getState().status.serverRunning === true,
    undefined,
    { timeout: 300_000 },
  );
  console.log(`  server up in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  await win.evaluate(async (modelId) => {
    await window.piDesktop.invoke('pi:restart', {});
    await window.piDesktop.invoke('pi:set-model', { provider: 'llamacpp', modelId });
  }, MODEL);

  // The warm-up is fire-and-forget and takes a moment on a ~3k-token prefix.
  // This is exactly the "after model load" window jedd is describing.
  await win.waitForTimeout(8000);

  const countAssistantTokens = () =>
    win.evaluate(() => {
      const rows = window.__pi_store().getState().messages;
      const last = rows[rows.length - 1];
      if (last === undefined || last.kind !== 'assistant') return { rows: rows.length, chars: 0 };
      const chars = (last.blocks ?? []).reduce(
        (n, b) => n + (b.text ?? b.thinking ?? '').length,
        0,
      );
      return { rows: rows.length, chars };
    });

  for (let i = 0; i < MESSAGES.length; i += 1) {
    const message = MESSAGES[i];
    const last = i === MESSAGES.length - 1;
    if (PASTE > 0 && last) {
      // Paste a big block so it becomes an attachment, then IDLE — this is the
      // path that is supposed to move the whole prompt-processing cost off send.
      const filler = 'The quick brown fox jumps over the lazy dog. '.repeat(Math.ceil(PASTE / 45));
      await win.click('[data-testid="composer-input"]');
      // Synthesise the paste rather than using the real clipboard: Electron
      // refuses `navigator.clipboard.writeText` under automation, and the
      // composer's handler is a Lexical PASTE_COMMAND listener, which a
      // dispatched ClipboardEvent drives exactly the same way a real ⌘V does.
      await win.evaluate((text) => {
        const el = document.querySelector('[data-testid="composer-input"]');
        if (el === null) throw new Error('no composer');
        const data = new DataTransfer();
        data.setData('text/plain', text);
        el.dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
        );
      }, filler);
      await win.waitForTimeout(500);
      console.log(`  pasted ${filler.length} chars, idling ${WAIT_MS}ms for the prefill…`);
      await win.waitForTimeout(WAIT_MS);
    }

    const before = await countAssistantTokens();
    await win.click('[data-testid="composer-input"]');
    await win.keyboard.type(message);
    const sentAt = Date.now();
    await win.keyboard.press('Enter');

    // First token = the store grew a NEW assistant row that has content. Gating
    // on row growth matters: after a send the previous assistant row is still
    // there, and a naive "last row has chars" reads it and reports a bogus ~100ms.
    let ttft = null;
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const now = await countAssistantTokens();
      if (now.rows > before.rows && now.chars > 0) {
        ttft = Date.now() - sentAt;
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    results.push({ message: message.slice(0, 40), ttft });
    console.log(
      `  ${JSON.stringify(message.slice(0, 40))} → ${ttft === null ? 'TIMEOUT' : `${ttft}ms`}`,
    );

    // Let the turn finish so the next one starts from a settled slot.
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
    await win.waitForTimeout(1500);
  }

  await win.screenshot({ path: path.join(OUT, 'ttft.png'), fullPage: true });
} catch (err) {
  console.error(`ttft-probe: ${err.message}`);
} finally {
  await app.close().catch(() => {});
}

console.log('\n──────── TTFT ────────');
for (const r of results)
  console.log(`  ${String(r.ttft ?? 'TIMEOUT').padStart(7)}ms  ${r.message}`);
const first = results[0]?.ttft ?? null;
console.log(
  first === null
    ? '\nno first-token measurement — the run did not get that far'
    : `\nfirst message: ${first}ms (instant is < ${SLOW_MS}ms)`,
);
process.exit(results.length === 0 || first === null || first > SLOW_MS ? 1 : 0);
