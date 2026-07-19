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
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
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

const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-live-udd-'));
const env = { ...process.env, PI_E2E: '1' };
if (!REAL) {
  env.PI_BIN = mockPi;
  env.MOCK_PI_FIXTURE = fixture;
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

const artifacts = [];
try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 15000 });
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 15000 });

  for (let i = 0; i < MESSAGES.length; i++) {
    const msg = MESSAGES[i];
    await page.click('[data-testid="composer-input"]');
    await page.keyboard.type(msg);
    await page.keyboard.press('Enter');
    console.log(`[sent ${i + 1}/${MESSAGES.length}] ${JSON.stringify(msg)}`);
    if (i < MESSAGES.length - 1) await page.waitForTimeout(GAP_MS);
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
