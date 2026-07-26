/** Parity audit pass 3 — cropped scrollbar comparison across flavors. */
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
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
const OUT = process.env.AUDIT_OUT;
mkdirSync(OUT, { recursive: true });
const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'pi-audit3-home-')));
const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-audit3-udd-'))}`],
  env: {
    ...process.env,
    HOME: home,
    PI_BIN: mockPi,
    MOCK_PI_FIXTURE: path.join(repoRoot, 'packages/engine/tools/mock-pi/fixtures/simple-chat.json'),
    PI_E2E: '1',
    GEN3D_PY_DIR: '/nonexistent',
    GEN3D_CACHE_DIR: realpathSync(mkdtempSync(path.join(tmpdir(), 'gen3d-empty-'))),
  },
});
let page;
try {
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 15000 });
  await page.click('[data-testid="modality-3d"]');
  await page.waitForSelector('[data-testid="tp-root"]', { timeout: 20000 });
  await page.click('[data-testid="tp-rail-animate"]');
  await page.waitForTimeout(1200);
  // force the panel to overflow and hover it so the thumb paints
  await page.hover('.tp-panel-scroll');
  await page.evaluate(() => {
    document.querySelector('.tp-panel-scroll').scrollTop = 400;
  });
  for (const f of ['bobble', 'claude', 'codex']) {
    await page.evaluate((fl) => {
      document.documentElement.setAttribute('data-flavor', fl);
      document.documentElement.setAttribute('data-mode', 'dark');
    }, f);
    await page.hover('.tp-panel-scroll');
    await page.waitForTimeout(400);
    // crop the panel's right edge where the scrollbar lives
    await page.screenshot({
      path: path.join(OUT, `D-scrollbar-${f}.png`),
      clip: { x: 300, y: 300, width: 120, height: 400 },
    });
    // and the app sidebar's scrollbar for the same flavor
    console.log(`  scrollbar shot: ${f}`);
  }
  // App-side comparison: the sidebar scroller under claude.
  await page.click('[data-testid="tp-back"]');
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 10000 });
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-flavor', 'claude');
    document.documentElement.setAttribute('data-mode', 'dark');
  });
  await page.hover('.pd-sidebar-scroll').catch(() => {});
  await page.waitForTimeout(400);
  await page.screenshot({
    path: path.join(OUT, 'D-scrollbar-app-claude.png'),
    clip: { x: 190, y: 120, width: 120, height: 400 },
  });
  console.log('audit3 done');
} finally {
  await app.close();
}
