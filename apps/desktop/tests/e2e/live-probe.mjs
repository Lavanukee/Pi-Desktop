/**
 * live-probe.mjs — the reusable "drive the real app + look" harness.
 *
 * Launches the built Electron app headlessly (Playwright `_electron.launch`),
 * types a scripted sequence of messages into the REAL Lexical composer, and
 * after each step captures BOTH a screenshot AND a dump of the store's message
 * order (`window.__pi_store().getState().messages`) — the latter is exact
 * ground truth for ordering/state bugs a screenshot can only hint at.
 *
 * It is deliberately env-parameterised so it can be re-aimed at any UI/runtime
 * bug without editing code:
 *
 *   MESSAGES   messages to send, separated by "||"   (default: a rapid double-send)
 *   GAP_MS     ms to wait between sends              (default: 120 — small, to
 *              deliberately land the 2nd send in the first turn's in-flight
 *              window and exercise the steer/ordering path)
 *   SETTLE_MS  ms to wait after the last send before the final dump (default 6000)
 *   REAL       "1" → drive the real local model (no mock); else mock-pi fixture
 *   CORP       "1" → launch with PI_DESKTOP_CORP=1 (surface the corp harness)
 *   OUT        screenshot/dump output dir (default <repo>/.corp-runs/live-probe)
 *
 * Example — reproduce the message-ordering bug:
 *   MESSAGES='hi||what are you doing today?' node tests/e2e/live-probe.mjs
 *
 * Exit code 0 always (it's an observation tool, not a pass/fail gate) — read the
 * printed ORDER lines + the screenshots. Ordering is CORRECT when every user
 * message is immediately followed by its own assistant reply, never two user
 * rows in a row ahead of a single reply.
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const electronBinary = require('electron');

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(appRoot, '../..');
const mockPi = path.join(repoRoot, 'packages/engine/tools/mock-pi/mock-pi.mjs');
const fixture = path.join(repoRoot, 'packages/engine/tools/mock-pi/fixtures/tool-use.json');

const MESSAGES = (process.env.MESSAGES ?? 'hi||what are you doing today?').split('||');
const GAP_MS = Number(process.env.GAP_MS ?? 120);
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 6000);
const REAL = process.env.REAL === '1';
const CORP = process.env.CORP === '1';
const OUT = process.env.OUT ?? path.join(repoRoot, '.corp-runs', 'live-probe');

mkdirSync(OUT, { recursive: true });

if (
  !existsSync(path.join(appRoot, 'dist/index.html')) ||
  !existsSync(path.join(appRoot, 'dist-electron/main.js'))
) {
  console.error('live-probe: app is not built — run `npm run build` in apps/desktop first');
  process.exit(2);
}

/*
 * A temp profile per run is FINE, and I briefly changed it on a wrong theory.
 * Model selection does NOT live in Electron's userData — it is in
 * ~/.pi/desktop/settings.json (`modelSelection: {mode:'tier'}`), shared by every
 * launch regardless of --user-data-dir. So an isolated profile is not why a run
 * answers "fetch failed"; see the [llm] line below for what actually is.
 */
const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-live-udd-'));
const env = { ...process.env, PI_E2E: '1' };
if (!REAL) {
  env.PI_BIN = mockPi;
  env.MOCK_PI_FIXTURE = fixture;
  // A mock-pi fixture has no model to reach, so skip the server boot. REAL=1
  // deliberately does NOT set this — it needs a real server, and this flag being
  // implied by PI_E2E is what made every live probe answer "fetch failed".
  env.PI_E2E_NO_SERVER = '1';
}
if (CORP) env.PI_DESKTOP_CORP = '1';

// Dump the store's message order — the exact ground truth for ordering bugs.
async function dumpOrder(page, label) {
  const rows = await page.evaluate(() => {
    const store = window.__pi_store?.();
    if (!store) return null;
    return store.getState().messages.map((m) => {
      let text = '';
      if (m.kind === 'user') text = m.text ?? '';
      else if (m.kind === 'assistant')
        text = (m.blocks ?? [])
          .map((b) => b.text ?? b.thinking ?? (b.type ? `[${b.type}]` : ''))
          .join('')
          .slice(0, 60);
      return { kind: m.kind, streaming: m.isStreaming ?? false, text: text.slice(0, 60) };
    });
  });
  console.log(`\n=== ORDER @ ${label} ===`);
  if (rows === null) {
    console.log('  (store not exposed — is PI_E2E=1 set?)');
    return rows;
  }
  rows.forEach((r, i) =>
    console.log(`  ${i}. ${r.kind}${r.streaming ? '*' : ''}: ${JSON.stringify(r.text)}`),
  );
  return rows;
}

const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${userDataDir}`],
  env,
});

/*
 * FORWARD THE MAIN PROCESS. Without this the probe shows only the renderer, and
 * an app whose inference never starts looks like a model that answers "fetch
 * failed" — the supervisor's own log lines, the ones that say WHY, go to a pipe
 * nobody reads. This is what turned a long guessing session into a diagnosis.
 */
app.process().stdout?.on('data', (d) => {
  for (const line of String(d).split('\n')) {
    if (line.trim() !== '') console.log(`[main] ${line.slice(0, 300)}`);
  }
});
app.process().stderr?.on('data', (d) => {
  for (const line of String(d).split('\n')) {
    if (line.trim() !== '') console.log(`[main!] ${line.slice(0, 300)}`);
  }
});

const artifacts = [];
try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 15000 });
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 15000 });

  /*
   * WAIT FOR THE MODEL. Typing at t≈5s while a 4B Q8 is still loading tests the
   * race, not the feature — every turn answers "fetch failed" and the run looks
   * like a model failure when it is a probe failure.
   */
  if (REAL) {
    /*
     * DO NOT GATE — REPORT. The model is chosen by TIER
     * (settings.json `modelSelection: {mode:'tier'}`) and only resolved to a
     * concrete model when the server is lazily started on the first turn, so
     * both `phase` and `status.model` sit empty until then. Two earlier gates
     * here were wrong for exactly that reason. What IS worth doing is printing
     * the status and any server error alongside the transcript, so a run that
     * answers "fetch failed" says WHY instead of looking like a model failure.
     */
    const status = await page
      .evaluate(() => window.__llm_store?.().getState?.().status ?? null)
      .catch(() => null);
    console.log(
      `[llm] phase=${status?.phase ?? '?'} serverRunning=${status?.serverRunning ?? '?'} ` +
        `model=${status?.model?.id ?? '(unresolved — tier resolves on first turn)'} ` +
        `${status?.error !== undefined ? `error=${status.error}` : ''}`,
    );
    page.on('console', (m) => {
      const t = m.text();
      if (/error|fail|refus|ECONN|supervisor|llama/i.test(t))
        console.log(`[console] ${t.slice(0, 300)}`);
    });
  }

  for (let i = 0; i < MESSAGES.length; i++) {
    const msg = MESSAGES[i];
    await page.click('[data-testid="composer-input"]');
    await page.keyboard.type(msg);
    /*
     * TTFT, measured where the USER feels it: from pressing Enter to the first
     * assistant character appearing. jedd: "any oddities/non instant stuff we
     * would expect to be instant … this is really important to UX".
     *
     * Deliberately counted from the keypress, not from the provider request —
     * everything between them (queueing, a server that has to be started, a tool
     * prefix that got invalidated and forces a full re-prefill) is latency the
     * user is sitting through, and hiding it behind "provider TTFT" is how a
     * 4-second wait gets reported as 200ms.
     */
    const before = await page
      .evaluate(() => window.__pi_store?.().getState?.().messages?.length ?? 0)
      .catch(() => 0);
    const t0 = Date.now();
    await page.keyboard.press('Enter');
    console.log(`[sent ${i + 1}/${MESSAGES.length}] ${JSON.stringify(msg)}`);
    const gotToken = await page
      .waitForFunction(
        (n) => {
          const ms = window.__pi_store?.().getState?.().messages ?? [];
          if (ms.length <= n) return false;
          return ms.slice(n).some((m) => {
            if (m.kind !== 'assistant') return false;
            return (m.blocks ?? []).some(
              (b) => (b.type === 'text' || b.type === 'thinking') && (b.text ?? '').length > 0,
            );
          });
        },
        before,
        { timeout: GAP_MS },
      )
      .then(() => true)
      .catch(() => false);
    const ttft = Date.now() - t0;
    console.log(
      gotToken
        ? `[TTFT ${i + 1}] ${ttft}ms${ttft > 2000 ? '  <-- SLOW' : ''}`
        : `[TTFT ${i + 1}] NO TOKEN within ${GAP_MS}ms`,
    );
    if (i < MESSAGES.length - 1) await page.waitForTimeout(Math.max(0, GAP_MS - ttft));
  }

  // Let the turn(s) run, then capture ground truth.
  await page.waitForTimeout(SETTLE_MS);
  const shot = path.join(OUT, 'final.png');
  await page.screenshot({ path: shot, fullPage: true });
  artifacts.push(shot);
  const order = await dumpOrder(page, 'final');
  writeFileSync(path.join(OUT, 'order.json'), JSON.stringify(order, null, 2));

  // Quick ordering assertion (informational): flag two consecutive user rows.
  if (Array.isArray(order)) {
    let twoUsersInARow = false;
    for (let i = 1; i < order.length; i++)
      if (order[i].kind === 'user' && order[i - 1].kind === 'user') twoUsersInARow = true;
    console.log(
      `\nORDER VERDICT: ${twoUsersInARow ? 'SUSPECT — two user rows adjacent (reorder?)' : 'OK — no adjacent user rows'}`,
    );
  }
  console.log(`\nartifacts: ${artifacts.join(', ')}\n  dump: ${path.join(OUT, 'order.json')}`);
} finally {
  await app.close();
}
