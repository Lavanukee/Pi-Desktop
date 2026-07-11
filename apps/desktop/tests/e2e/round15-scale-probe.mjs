/**
 * Round-15 element-size E2E (mock pi, isolated HOME + udd). Verifies the two
 * runtime UI-scale sliders in Settings → Interface → "Element size":
 *   1. the Sidebar-size slider drives `--pd-sidebar-scale` on <html> + persists
 *      `sidebarScale`, and a `.pd-sidebar-row` computed height grows with it;
 *   2. the Menu-size slider drives `--pd-menu-scale` on <html> + persists
 *      `menuScale`, and a `.pd-menu-item` computed min-height grows with it
 *      (measured on the shared footer model dropup).
 * Both default to 1.0 (a no-op) and the vars are present on <html> at boot.
 * Run `pnpm build` first.
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
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
const fixture = path.join(repoRoot, 'packages/engine/tools/mock-pi/fixtures/simple-chat.json');

function assert(condition, message) {
  if (!condition) throw new Error(`round15-scale-probe failed: ${message}`);
}

assert(existsSync(path.join(appRoot, 'dist/index.html')), 'app is not built — run `pnpm build`');

const home = mkdtempSync(path.join(tmpdir(), 'pi-e2e-home-'));
const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'));
const settingsPath = path.join(home, '.pi', 'desktop', 'settings.json');
const readSettings = () => JSON.parse(readFileSync(settingsPath, 'utf8'));

async function waitFor(predicate, label, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (predicate()) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`round15-scale-probe failed: timed out waiting for ${label}`);
}

const cssVar = (page, name) =>
  page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
const firstRowHeight = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('.pd-sidebar-row');
    return el ? Number.parseFloat(getComputedStyle(el).height) : null;
  });
const firstMenuItemMinHeight = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid="footer-model-menu"] .pd-menu-item');
    return el ? Number.parseFloat(getComputedStyle(el).minHeight) : null;
  });

const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${userDataDir}`],
  env: { ...process.env, HOME: home, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});

try {
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 12000 });

  // ── 0. Defaults: both scale vars are present on <html> and are the 1.0 no-op ──
  assert((await cssVar(page, '--pd-sidebar-scale')) === '1', 'default --pd-sidebar-scale is 1');
  assert((await cssVar(page, '--pd-menu-scale')) === '1', 'default --pd-menu-scale is 1');

  // Baseline metrics at scale 1.0 (chat view: the sidebar rows are mounted here).
  const rowBefore = await firstRowHeight(page);
  assert(rowBefore !== null && rowBefore > 0, 'a .pd-sidebar-row must be present at baseline');

  // Baseline menu-item min-height from the shared footer model dropup.
  await page.click('[data-testid="footer-model-chip"]');
  await page.waitForSelector('[data-testid="footer-model-menu"]', { timeout: 8000 });
  const menuBefore = await firstMenuItemMinHeight(page);
  assert(menuBefore !== null && menuBefore > 0, 'a .pd-menu-item must be present at baseline');
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-testid="footer-model-menu"]', {
    state: 'detached',
    timeout: 8000,
  });

  // ── 1. Open Settings → Interface → the "Element size" sliders ─────────────────
  await page.click('[data-testid="profile-button"]');
  await page.waitForSelector('[data-testid="profile-menu"]', { timeout: 8000 });
  await page.click('[data-testid="open-settings"]');
  await page.waitForSelector('[data-testid="settings-view"]', { timeout: 8000 });
  await page.click('[data-testid="settings-nav-interface"]');
  await page.waitForSelector('[data-testid="settings-sidebar-scale"]', { timeout: 8000 });

  // Sidebar-size slider (range max = 1.5) → --pd-sidebar-scale + persisted.
  const sidebarSlider = page.locator('[data-testid="settings-sidebar-scale"]');
  await sidebarSlider.focus();
  await sidebarSlider.press('End');
  await page.waitForFunction(
    () =>
      getComputedStyle(document.documentElement).getPropertyValue('--pd-sidebar-scale').trim() ===
      '1.5',
    { timeout: 5000 },
  );
  await waitFor(
    () => readSettings().sidebarScale === 1.5,
    'sidebarScale persisted to settings.json',
  );

  // Menu-size slider (range max = 1.5) → --pd-menu-scale + persisted.
  const menuSlider = page.locator('[data-testid="settings-menu-scale"]');
  await menuSlider.focus();
  await menuSlider.press('End');
  await page.waitForFunction(
    () =>
      getComputedStyle(document.documentElement).getPropertyValue('--pd-menu-scale').trim() ===
      '1.5',
    { timeout: 5000 },
  );
  await waitFor(() => readSettings().menuScale === 1.5, 'menuScale persisted to settings.json');

  // ── 2. Back to chat: the tokenized metrics grew with their scale var ──────────
  await page.click('[data-testid="settings-back"]');
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 8000 });

  const rowAfter = await firstRowHeight(page);
  assert(
    rowAfter !== null && rowAfter > rowBefore,
    `.pd-sidebar-row height should grow with the sidebar scale (before ${rowBefore}, after ${rowAfter})`,
  );

  await page.click('[data-testid="footer-model-chip"]');
  await page.waitForSelector('[data-testid="footer-model-menu"]', { timeout: 8000 });
  const menuAfter = await firstMenuItemMinHeight(page);
  assert(
    menuAfter !== null && menuAfter > menuBefore,
    `.pd-menu-item min-height should grow with the menu scale (before ${menuBefore}, after ${menuAfter})`,
  );
  await page.keyboard.press('Escape');

  console.log(
    'round15-scale-probe OK — sidebar + menu scale sliders drive --pd-sidebar-scale/--pd-menu-scale on <html>, persist, and grow the sidebar row height + menu-item min-height',
  );
} finally {
  await app.close();
}
