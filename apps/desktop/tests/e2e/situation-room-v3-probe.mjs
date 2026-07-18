/**
 * Situation-room v3 probe — the owner's watch-feedback polish:
 *   1. the click-through actually STREAMS: live assistant text with a typing
 *      caret, a real "Thinking…" block growing, NAMED tool rows — and never
 *      "Used a tool" / "turn N" / a bare "working…" void;
 *   2. the top card is a plain user-message-style ask (no "TASK BRIEFING"
 *      label) with the deliverables embedded as Plan-style checklist rows;
 *   3. the "Live activity" feed renders `Area · <current action>` rows with a
 *      spinner on live rows that settles into a done check;
 *   4. the context ring FILLS from the run's usage (worker-pane head).
 *
 * Run `pnpm build` first. Screenshots land in scratchpad/situation-room-v3/
 * (override with SITROOM_SHOT_DIR).
 */
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(appRoot, '../..');
const shotDir =
  process.env.SITROOM_SHOT_DIR ?? path.join(repoRoot, 'scratchpad', 'situation-room-v3');

function assert(condition, message) {
  if (!condition) throw new Error(`situation-room v3 probe failed: ${message}`);
}

assert(
  existsSync(path.join(appRoot, 'dist/index.html')) &&
    existsSync(path.join(appRoot, 'dist-electron/main.js')),
  'app is not built — run `pnpm build` first',
);
mkdirSync(shotDir, { recursive: true });

const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-sitroom3-udd-'));
const home = mkdtempSync(path.join(tmpdir(), 'pi-sitroom3-home-'));
const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${userDataDir}`],
  env: { ...process.env, HOME: home, PI_E2E: '1' },
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  const page = await app.firstWindow();
  await page.waitForSelector('#root');
  const baseUrl = page.url().split('?')[0];

  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setSize(1600, 920);
    win.center();
  });

  const setTheme = (flavor, mode) =>
    page.evaluate(
      ([f, m]) => {
        document.documentElement.setAttribute('data-flavor', f);
        document.documentElement.setAttribute('data-mode', m);
      },
      [flavor, mode],
    );

  const openState = async ({ startAt, speed, flavor = 'claude', mode = 'dark' }) => {
    await page.goto(
      `${baseUrl}?situationDemo=1&situationStartAt=${startAt}&situationSpeed=${speed}&situationUserMode=power`,
    );
    await page.waitForSelector('[data-testid="situation-room"]', { timeout: 8000 });
    await setTheme(flavor, mode);
  };

  const shoot = (name) => page.screenshot({ path: path.join(shotDir, name) });

  // ---- 1. The click-through STREAMS -------------------------------------
  await openState({ startAt: 20000, speed: 1 });
  await sleep(600);
  // Pin an area lead so the pane's replay runs uninterrupted.
  await page.locator('.pd-sitroom-node[data-role="division"]').first().click();
  await page.waitForSelector('[data-testid="task-briefing"]', { timeout: 5000 });

  // (2) The ask card: a plain message-style bubble, NO "TASK BRIEFING" label,
  // deliverables embedded as Plan-style checklist rows (same markers).
  assert(
    (await page.locator('.pd-taskbrief-bubble').count()) === 1,
    'expected the message-style ask card',
  );
  assert(
    (await page.locator('.pd-taskbrief-list .pd-sitroom-task-marker').count()) >= 2,
    'expected embedded Plan-style checklist rows in the ask card',
  );
  const briefText = await page.locator('[data-testid="task-briefing"]').textContent();
  assert(!/task briefing/i.test(briefText ?? ''), 'the card must not say "TASK BRIEFING"');

  // (1a) The live text tail: a streaming message with the typing caret.
  await page.waitForSelector('[data-testid="worker-pane"] .pd-stream-caret', { timeout: 6000 });
  const streamedEarly = await page
    .locator('[data-testid="worker-pane"] .pd-msg--assistant')
    .last()
    .textContent();
  await shoot('01-clickthrough-streaming-text.png');
  await sleep(700);
  const streamedLater = await page
    .locator('[data-testid="worker-pane"] .pd-msg--assistant')
    .last()
    .textContent();
  assert(
    (streamedLater ?? '').length > (streamedEarly ?? '').length,
    'the streaming tail must GROW between reads',
  );

  // (1b) A real "Thinking…" state: the live reasoning block, force-open.
  await page.waitForSelector('[data-testid="worker-pane"] .pd-thinking', { timeout: 8000 });
  const thinkingLabel = await page
    .locator('[data-testid="worker-pane"] .pd-thinking-pill-label')
    .first()
    .textContent();
  assert(
    /Thinking…/.test(thinkingLabel ?? ''),
    `expected a live "Thinking…" label, got "${thinkingLabel}"`,
  );
  await sleep(600);
  await shoot('02-clickthrough-thinking-live.png');

  // (1c) Named tool rows — and the context ring filling in the pane head.
  await sleep(4200);
  const paneText = await page.locator('[data-testid="worker-pane"]').textContent();
  assert(/Read a file|Reading/.test(paneText ?? ''), 'expected a named read row');
  assert(/Ran/.test(paneText ?? ''), 'expected a named command row');
  assert(!/Used a tool/i.test(paneText ?? ''), '"Used a tool" must never render');
  assert(!/turn \d/i.test(paneText ?? ''), '"turn N" markers must never render');
  assert(!/working…/i.test(paneText ?? ''), 'a bare "working…" must never render');
  const gaugeTitle = await page
    .locator('[data-testid="worker-pane"] .pd-workerpane-gauge')
    .getAttribute('title');
  const gaugePct = Number(/(\d+)%/.exec(gaugeTitle ?? '')?.[1] ?? '0');
  assert(gaugePct > 5, `expected the context ring filled from the run (got "${gaugeTitle}")`);
  await shoot('03-clickthrough-named-tools-ring.png');

  // ---- 3. The live-activity feed: Area · action, spinner → done check ----
  const feed = page.locator('[data-testid="sitroom-section-feed"]');
  assert((await feed.locator('.pd-sitroom-action').count()) >= 3, 'expected live-action rows');
  assert(
    (await feed.locator('.pd-sitroom-action:not([data-done]) .pd-loader').count()) >= 1,
    'expected a SPINNER on a live row',
  );
  assert(
    (await feed.locator('.pd-sitroom-action[data-done] svg').count()) >= 1,
    'expected a done CHECK on a settled row',
  );
  const firstRow = feed.locator('.pd-sitroom-action').first();
  assert(
    (await firstRow.locator('.pd-sitroom-action-area').count()) === 1 &&
      (await firstRow.locator('.pd-sitroom-action-text').count()) === 1,
    'rows must read as "Area · action"',
  );
  assert(
    (await page.locator('.pd-sitroom-feed-icon').count()) === 0,
    'the old sparkle/icon ticker must be gone',
  );
  await feed.screenshot({ path: path.join(shotDir, '04-live-activity-feed.png') });
  await sleep(1100);
  await feed.screenshot({ path: path.join(shotDir, '05-live-activity-feed-later.png') });

  // Jargon sweep across the whole page.
  const body = await page.evaluate(() => document.body.textContent ?? '');
  for (const phrase of ['Promoting to a team', 'Used a tool', 'Task briefing']) {
    assert(!body.includes(phrase), `jargon leaked into the UI: "${phrase}"`);
  }

  await shoot('06-room-full-dark.png');

  // ---- Light-mode pass ----------------------------------------------------
  await setTheme('claude', 'light');
  await sleep(500);
  await shoot('07-room-full-light.png');

  console.log(`situation-room v3 probe passed — screenshots in ${shotDir}`);
} finally {
  await app.close();
}
