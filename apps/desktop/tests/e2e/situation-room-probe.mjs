/**
 * Situation-room probe: launches the built app on the `?situationDemo=1` route
 * (the spec §11 war room driven by the scripted mock corp run) and screenshots
 * it at four run states — promotion, planning, mid-dispatch, near-done — plus
 * one light-mode shot. Also asserts the honest-ETA + contract-count readouts
 * and that the peek button opens the build-snapshot tab.
 *
 * Run `pnpm build` first. Screenshots default to scratchpad/situation-room/
 * at the repo root (override with SITROOM_SHOT_DIR).
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
const shotDir = process.env.SITROOM_SHOT_DIR ?? path.join(repoRoot, 'scratchpad', 'situation-room');

function assert(condition, message) {
  if (!condition) throw new Error(`situation-room probe failed: ${message}`);
}

assert(
  existsSync(path.join(appRoot, 'dist/index.html')) &&
    existsSync(path.join(appRoot, 'dist-electron/main.js')),
  'app is not built — run `pnpm build` first',
);
mkdirSync(shotDir, { recursive: true });

const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-sitroom-udd-'));
const home = mkdtempSync(path.join(tmpdir(), 'pi-sitroom-home-'));
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

  // A roomy window so the war room reads like the hero surface it is.
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setSize(1360, 860);
    win.center();
  });

  const setMode = (mode) =>
    page.evaluate((m) => {
      document.documentElement.setAttribute('data-flavor', 'claude');
      document.documentElement.setAttribute('data-mode', m);
    }, mode);

  const openState = async ({ startAt, speed, mode = 'dark' }) => {
    await page.goto(
      `${baseUrl}?situationDemo=1&situationStartAt=${startAt}&situationSpeed=${speed}&situationUserMode=power`,
    );
    await page.waitForSelector('[data-testid="situation-room"]', { timeout: 8000 });
    await setMode(mode);
  };

  // -- State 1: promotion — the solo agent has just become the CEO. --------
  await openState({ startAt: 3000, speed: 0.12 });
  await sleep(900);
  assert(
    (await page.locator('.pd-sitroom-node').count()) >= 2,
    'expected CEO + manager cards after promotion',
  );
  await page.screenshot({ path: path.join(shotDir, '1-promotion.png') });

  // -- State 2: planning — managers writing contracts, org fanning out. ----
  await openState({ startAt: 12500, speed: 0.08 });
  await sleep(900);
  assert(
    (await page.locator('.pd-sitroom-plangroup').count()) >= 3,
    'expected division plan groups during planning',
  );
  await page.screenshot({ path: path.join(shotDir, '2-planning.png') });

  // -- State 3: dispatch at live speed — files landing, org pulsing. -------
  await openState({ startAt: 26000, speed: 1 });
  await sleep(1600); // let a couple of contracts land in real time
  const contracts = await page.locator('.pd-sitroom-contracts').textContent();
  assert(/\d+ of 48 tasks/.test(contracts ?? ''), `task readout was "${contracts}"`);
  const eta = await page.locator('.pd-sitroom-eta').textContent();
  assert(/~\d+–\d+ min left/.test(eta ?? ''), `eta readout was "${eta}" (must be a range)`);
  assert(
    (await page.locator('.pd-sitroom-file').count()) > 8,
    'expected files lit up in the module map mid-dispatch',
  );
  await page.screenshot({ path: path.join(shotDir, '3-dispatch.png') });

  // Same state in light mode — theme-awareness check.
  await setMode('light');
  await sleep(300);
  await page.screenshot({ path: path.join(shotDir, '3b-dispatch-light.png') });
  await setMode('dark');

  // -- State 4: near-done — checklist mostly checked, ETA nearly closed. ---
  await openState({ startAt: 43000, speed: 0.12 });
  await sleep(900);
  const nearDone = await page.locator('.pd-sitroom-contracts').textContent();
  const doneCount = Number((nearDone ?? '').match(/(\d+) of 48/)?.[1] ?? '0');
  assert(doneCount >= 40, `expected ≥40 contracts done near the end, got ${doneCount}`);

  // The peek button must be real: click it, get the build-snapshot tab.
  await page.locator('button', { hasText: 'Peek at the build' }).click();
  await page.waitForSelector('.pd-canvas-tab[data-active="true"]', { timeout: 5000 });
  const tabs = await page.locator('.pd-canvas-tab').count();
  assert(tabs >= 2, 'peek should open a second canvas tab');
  // Back to the situation tab: the room must survive the round-trip (the
  // replayable stream rebuilds it) — assert the state is still near-done.
  await page.locator('.pd-canvas-tab', { hasText: 'Situation room' }).click();
  await sleep(1000);
  const afterSwitch = await page.locator('.pd-sitroom-contracts').textContent();
  const afterCount = Number((afterSwitch ?? '').match(/(\d+) of 48/)?.[1] ?? '0');
  assert(afterCount >= 40, `room lost state on tab switch (readout "${afterSwitch}")`);
  await page.screenshot({ path: path.join(shotDir, '4-near-done.png') });

  console.log(`situation-room probe passed — screenshots in ${shotDir}`);
} finally {
  await app.close();
}
