/**
 * Verification probe for the live-view polish round:
 *  1. never-blank left pane: auto-follows the top-most running node from t=0
 *  2. follow moves with the run (builders mid-dispatch), pin ⇄ follow-live
 *  3. honest lighting: lead NOT lit mid-dispatch; only running builders pulse
 *  4. sections: collapsible, no overlap at narrow/tiny widths
 *  5. exercise panel still overlays correctly
 * Screenshots land in scratchpad/live-view/shots/.
 */
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const appRoot = path.join(repoRoot, 'apps/desktop');
const require = createRequire(path.join(appRoot, 'package.json'));
const { _electron: electron } = require('playwright-core');
const electronBinary = require('electron');
const shotDir = path.join(repoRoot, 'scratchpad', 'live-view', 'shots');

if (!existsSync(path.join(appRoot, 'dist/index.html'))) throw new Error('build first');
mkdirSync(shotDir, { recursive: true });

function assert(condition, message) {
  if (!condition) throw new Error(`live-view probe failed: ${message}`);
}

const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-liveview-udd-'));
const home = mkdtempSync(path.join(tmpdir(), 'pi-liveview-home-'));
const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${userDataDir}`],
  env: { ...process.env, HOME: home, PI_E2E: '1' },
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const page = await app.firstWindow();
  await page.waitForSelector('#root');
  const baseUrl = page.url().split('?')[0];

  const setSize = (w, h) =>
    app.evaluate(({ BrowserWindow }, [width, height]) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.setSize(width, height);
      win.center();
    }, [w, h]);

  const open = async (startAt, speed, w, h) => {
    await setSize(w, h);
    await page.goto(
      `${baseUrl}?situationDemo=1&situationStartAt=${startAt}&situationSpeed=${speed}&situationUserMode=power`,
    );
    await page.waitForSelector('[data-testid="situation-room"]', { timeout: 8000 });
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-flavor', 'claude');
      document.documentElement.setAttribute('data-mode', 'dark');
    });
  };
  const shoot = (name) => page.screenshot({ path: path.join(shotDir, name) });

  // ---- 1. Never blank: t=0 auto-follows the lead forming the vision -------
  await open(0, 1, 1600, 920);
  await sleep(2500);
  assert(
    (await page.locator('[data-testid="worker-pane"] [data-testid="task-briefing"]').count()) === 1,
    'left pane must auto-show the lead the moment the run starts',
  );
  const paneTitle0 = await page.locator('.pd-workerpane-title').textContent();
  assert(paneTitle0 === 'Pi', `expected the lead followed at start, got "${paneTitle0}"`);
  assert(
    (await page.locator('[data-testid="corp-following"]').count()) === 1,
    'expected the "following live" affordance',
  );
  await shoot('v-01-start-follows-lead.png');

  // ---- 2. Mid-dispatch: follows a running builder + honest lighting -------
  await open(26000, 0.7, 1600, 920);
  await sleep(2500);
  const paneTitle = await page.locator('.pd-workerpane-title').textContent();
  assert(/builder/i.test(paneTitle ?? ''), `expected a builder followed mid-dispatch, got "${paneTitle}"`);
  // Honest lighting: the lead + planner are NOT working mid-dispatch.
  const leadState = await page
    .locator('.pd-sitroom-node[data-role="ceo"]')
    .getAttribute('data-state');
  assert(leadState !== 'working', `lead must be dim mid-dispatch (was "${leadState}")`);
  const mgrState = await page
    .locator('.pd-sitroom-node[data-role="manager"]')
    .getAttribute('data-state');
  assert(mgrState !== 'working', `planner must be dim mid-dispatch (was "${mgrState}")`);
  // Running builders pulse; areas with running crew carry the derived glow.
  assert(
    (await page.locator('.pd-sitroom-crew-dot[data-state="working"]').count()) > 0,
    'expected running builder dots mid-dispatch',
  );
  assert(
    (await page.locator('.pd-sitroom-node[data-crew-active]').count()) > 0,
    'expected area cards lit via their running crew',
  );
  // The followed node is highlighted in the room.
  assert(
    (await page.locator('.pd-sitroom-node[data-selected], .pd-sitroom-crew-dot[data-selected]').count()) >= 1,
    'expected the followed node highlighted in the room',
  );
  await shoot('v-02-dispatch-follows-builder.png');

  // ---- 3. Pin a node, then follow live back --------------------------------
  await page.locator('.pd-sitroom-node[data-role="division"]').first().click();
  await sleep(1200);
  assert(
    (await page.locator('[data-testid="corp-follow-live"]').count()) === 1,
    'expected the pinned ⇄ follow-live button after clicking a node',
  );
  await shoot('v-03-pinned.png');
  await page.locator('[data-testid="corp-follow-live"]').click();
  await sleep(800);
  assert(
    (await page.locator('[data-testid="corp-following"]').count()) === 1,
    'expected follow-live restored after the button',
  );

  // ---- 4. Sections: collapse + narrow/tiny layouts ------------------------
  // Collapse the team section; the room stays coherent.
  await page.locator('[data-testid="sitroom-section-team"] .pd-sitroom-sec-head').click();
  await sleep(600);
  await shoot('v-04-team-collapsed.png');
  await page.locator('[data-testid="sitroom-section-team"] .pd-sitroom-sec-head').click();
  await sleep(400);

  // Narrow window: the plan restacks; nothing overlaps.
  await open(26000, 0.7, 1000, 700);
  await sleep(2500);
  assert(
    (await page.locator('[data-testid="sitroom-section-plan"]').count()) === 1,
    'expected the plan section present when restacked',
  );
  await shoot('v-05-narrow.png');

  // Tiny: force the rail very narrow via DOM style — sections auto-collapse.
  await page.evaluate(() => {
    const rail = document.querySelector('[data-testid="situation-demo"] > div:nth-child(2)');
    if (rail) {
      rail.style.minWidth = '430px';
      rail.style.width = '430px';
    }
  });
  await sleep(900);
  await shoot('v-06-tiny.png');

  // ---- 5. Exercise panel still slides in over the body --------------------
  await open(31200, 1, 1300, 850);
  await sleep(2600);
  assert(
    (await page.locator('[data-testid="exercise-panel"][data-kind="test"]').count()) === 1,
    'expected the test exercise panel',
  );
  await shoot('v-07-exercise.png');

  // ---- 6. No internal-vocabulary leak --------------------------------------
  const banned = await page.evaluate(() => {
    const text = document.body.textContent ?? '';
    return ['corporation', 'contract', 'CEO', 'division', 'architect', 'Manager'].filter((w) =>
      text.includes(w),
    );
  });
  assert(banned.length === 0, `internal vocabulary leaked: ${banned.join(', ')}`);

  console.log('ALL CHECKS PASSED');
} finally {
  await app.close();
}
