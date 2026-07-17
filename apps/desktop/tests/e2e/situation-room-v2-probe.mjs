/**
 * Situation-room v2 probe: screenshots the second-pass war room across its
 * key states in BOTH flavors (claude + codex):
 *   - the growing tree during planning (+ the browse activity panel)
 *   - mid-dispatch in POWER mode (file paths, live +/− deltas, spinners)
 *   - mid-dispatch in USER mode (no raw paths — areas + progress + pages)
 *   - the TEST activity panel streaming
 *   - the RUN/playtest activity panel during review
 *   - the click-through: a worker's live stream in the left chat area
 *
 * Run `pnpm build` first. Screenshots land in scratchpad/situation-room-v2/
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
  process.env.SITROOM_SHOT_DIR ?? path.join(repoRoot, 'scratchpad', 'situation-room-v2');

function assert(condition, message) {
  if (!condition) throw new Error(`situation-room v2 probe failed: ${message}`);
}

assert(
  existsSync(path.join(appRoot, 'dist/index.html')) &&
    existsSync(path.join(appRoot, 'dist-electron/main.js')),
  'app is not built — run `pnpm build` first',
);
mkdirSync(shotDir, { recursive: true });

const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-sitroom2-udd-'));
const home = mkdtempSync(path.join(tmpdir(), 'pi-sitroom2-home-'));
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

  const openState = async ({
    startAt,
    speed,
    userMode = 'power',
    flavor = 'claude',
    mode = 'dark',
  }) => {
    await page.goto(
      `${baseUrl}?situationDemo=1&situationStartAt=${startAt}&situationSpeed=${speed}&situationUserMode=${userMode}`,
    );
    await page.waitForSelector('[data-testid="situation-room"]', { timeout: 8000 });
    await setTheme(flavor, mode);
  };

  const shoot = (name) => page.screenshot({ path: path.join(shotDir, name) });

  // ---- 1. Planning: the tree growing + the browse panel (claude dark) ----
  await openState({ startAt: 5000, speed: 0.35 });
  await sleep(1400);
  assert(
    (await page.locator('[data-testid="exercise-panel"][data-kind="browse"]').count()) === 1,
    'expected the browse activity panel during planning',
  );
  await shoot('01-claude-planning-browse.png');

  // Let the panel leave and the areas fan out — the growth moment.
  await openState({ startAt: 8600, speed: 0.3 });
  await sleep(1600);
  assert(
    (await page.locator('.pd-sitroom-node').count()) >= 5,
    'expected the tree fanned out during planning',
  );
  await shoot('02-claude-planning-growth.png');

  // ---- 2. Mid-dispatch, POWER mode (claude dark) --------------------------
  await openState({ startAt: 26000, speed: 1 });
  await sleep(2200);
  const tasks = await page.locator('.pd-sitroom-contracts').textContent();
  assert(/\d+ of 48 tasks/.test(tasks ?? ''), `task readout was "${tasks}"`);
  assert(
    (await page.locator('.pd-sitroom-file-delta').count()) > 3,
    'expected live +/− deltas on file chips in power mode',
  );
  assert(
    (await page.locator('.pd-sitroom-region-spin').count()) > 0,
    'expected a corner spinner on a hot module card',
  );
  const banned = await page.evaluate(() => {
    const text = document.body.textContent ?? '';
    return ['corporation', 'contract', 'CEO', 'division', 'architect', 'Manager'].filter((w) =>
      text.includes(w),
    );
  });
  assert(banned.length === 0, `internal vocabulary leaked into the UI: ${banned.join(', ')}`);
  await shoot('03-claude-dispatch-power.png');

  // Same state in light mode — theme-awareness check.
  await setTheme('claude', 'light');
  await sleep(400);
  await shoot('04-claude-dispatch-power-light.png');
  await setTheme('claude', 'dark');

  // ---- 3. Mid-dispatch, USER mode: no raw paths ---------------------------
  await openState({ startAt: 26000, speed: 1, userMode: 'user' });
  await sleep(1800);
  assert(
    (await page.locator('.pd-sitroom-file').count()) === 0,
    'user mode must not show raw file chips',
  );
  assert(
    (await page.locator('.pd-sitroom-page').count()) > 4,
    'user mode should show abstract pages for written files',
  );
  await shoot('05-claude-dispatch-user.png');

  // ---- 4. The TEST activity panel (claude dark) ---------------------------
  await openState({ startAt: 31200, speed: 1 });
  await sleep(2600);
  assert(
    (await page.locator('[data-testid="exercise-panel"][data-kind="test"]').count()) === 1,
    'expected the test activity panel mid-dispatch',
  );
  await shoot('06-claude-test-panel.png');

  // ---- 5. The RUN/playtest panel during review (claude dark) --------------
  await openState({ startAt: 44600, speed: 0.6 });
  await sleep(2000);
  assert(
    (await page.locator('[data-testid="exercise-panel"][data-kind="run"]').count()) === 1,
    'expected the playtest panel during review',
  );
  await shoot('07-claude-run-panel.png');

  // ---- 6. Click-through: a worker's stream in the left chat area ----------
  await openState({ startAt: 22000, speed: 1 });
  await sleep(1200);
  await page.locator('.pd-sitroom-node[data-role="division"]').first().click();
  await page.waitForSelector('[data-testid="task-briefing"]', { timeout: 5000 });
  await sleep(4200); // let the stream reveal a few entries
  assert(
    (await page.locator('[data-testid="worker-pane"] .pd-msg').count()) >= 1,
    'expected chat-rendered stream entries in the left area',
  );
  assert(
    (await page.locator('.pd-sitroom-node[data-selected]').count()) === 1,
    'expected the clicked node highlighted as selected',
  );
  await shoot('08-claude-clickthrough.png');

  // ---- 7. CODEX flavor pass ------------------------------------------------
  await openState({ startAt: 26000, speed: 1, flavor: 'codex' });
  await sleep(2200);
  await shoot('09-codex-dispatch-power.png');

  await setTheme('codex', 'light');
  await sleep(400);
  await shoot('10-codex-dispatch-power-light.png');
  await setTheme('codex', 'dark');

  await openState({ startAt: 31200, speed: 1, flavor: 'codex' });
  await sleep(2600);
  await shoot('11-codex-test-panel.png');

  await openState({ startAt: 44600, speed: 0.6, flavor: 'codex' });
  await sleep(2000);
  await shoot('12-codex-run-panel.png');

  await openState({ startAt: 22000, speed: 1, flavor: 'codex' });
  await sleep(1200);
  await page.locator('.pd-sitroom-node[data-role="division"]').first().click();
  await page.waitForSelector('[data-testid="task-briefing"]', { timeout: 5000 });
  await sleep(4200);
  await shoot('13-codex-clickthrough.png');

  // ---- 8. User-mode near-done (claude dark) -------------------------------
  await openState({ startAt: 51000, speed: 0.4, userMode: 'user' });
  await sleep(1600);
  await shoot('14-claude-near-done-user.png');

  console.log(`situation-room v2 probe passed — screenshots in ${shotDir}`);
} finally {
  await app.close();
}
