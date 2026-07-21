/**
 * Reproduction probe for the live-view polish round: screenshots the situation
 * demo at several panel widths / run moments to see overlap + lighting truthing.
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
    await page.goto(`${baseUrl}?situationDemo=1&situationStartAt=${startAt}&situationSpeed=${speed}&situationUserMode=power`);
    await page.waitForSelector('[data-testid="situation-room"]', { timeout: 8000 });
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-flavor', 'claude');
      document.documentElement.setAttribute('data-mode', 'dark');
    });
  };

  const shoot = (name) => page.screenshot({ path: path.join(shotDir, name) });

  // Wide window, mid-dispatch (busy chart + feed + map).
  await open(26000, 0.7, 1600, 920);
  await sleep(2000);
  await shoot('repro-01-wide-dispatch.png');

  // Small window → the demo panel bottoms out at its 560px min.
  await open(26000, 0.7, 1000, 700);
  await sleep(2000);
  await shoot('repro-02-narrow-dispatch.png');

  // Very small window / short height — where clipping + overlap shows.
  await open(26000, 0.7, 860, 600);
  await sleep(2000);
  await shoot('repro-03-tiny-dispatch.png');

  // Planning phase narrow (mid-row cards + feed).
  await open(9000, 0.5, 1000, 700);
  await sleep(1600);
  await shoot('repro-04-narrow-planning.png');

  // Click a division node → worker pane on the left (current click-through).
  await open(24000, 0.7, 1600, 920);
  await sleep(1400);
  await page.locator('.pd-sitroom-node[data-role="division"]').first().click();
  await sleep(2600);
  await shoot('repro-05-clickthrough.png');
} finally {
  await app.close();
}
console.log('shots in', shotDir);
