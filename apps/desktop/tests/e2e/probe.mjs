/**
 * Headed smoke probe for the built app: launches Electron via Playwright,
 * verifies the window renders, the pre-mount boot event arrives, and the
 * flavor/mode attribute switching restyles the UI across all four combos.
 *
 * Run `pnpm build` first, then `pnpm e2e`.
 * Env: PROBE_SCREENSHOT overrides the screenshot output path.
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

const screenshotPath =
  process.env.PROBE_SCREENSHOT ?? path.join(appRoot, 'test-results', 'w0-window.png');

function assert(condition, message) {
  if (!condition) throw new Error(`probe failed: ${message}`);
}

assert(
  existsSync(path.join(appRoot, 'dist/index.html')) &&
    existsSync(path.join(appRoot, 'dist-electron/main.js')),
  'app is not built — run `pnpm build` first',
);

// Isolated userData so the probe never contends with an installed Pi Desktop's
// single-instance lock (which would make the second instance quit on launch).
const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'));
// Isolated HOME too: the top-bar theme toggle now persists to
// ~/.pi/desktop/settings.json, so an isolated profile keeps this probe from
// mutating the real user's settings when it exercises the toggles.
const home = mkdtempSync(path.join(tmpdir(), 'pi-e2e-home-'));
const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${userDataDir}`],
  // PI_E2E bypasses the first-run onboarding gate so this boot/theme probe lands
  // straight in the app (its assertions + toggle-flavor/mode testids live there).
  env: { ...process.env, HOME: home, PI_E2E: '1' },
});
try {
  const page = await app.firstWindow();
  await page.waitForSelector('text=Pi Desktop');

  const themeAttrs = () =>
    page.evaluate(() => ({
      flavor: document.documentElement.getAttribute('data-flavor'),
      mode: document.documentElement.getAttribute('data-mode'),
    }));
  const bodyBg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

  // Pre-mount event buffer, end to end: main sent app:boot on did-finish-load,
  // before the React subscriber existed.
  await page.waitForSelector('[data-testid="boot-state"]:text("boot event received")', {
    timeout: 5000,
  });

  let attrs = await themeAttrs();
  assert(
    attrs.flavor === 'claude' && attrs.mode === 'dark',
    `unexpected initial theme ${JSON.stringify(attrs)}`,
  );
  const claudeDarkBg = await bodyBg();
  assert(claudeDarkBg === 'rgb(38, 38, 36)', `claude/dark bg was ${claudeDarkBg}`);

  mkdirSync(path.dirname(screenshotPath), { recursive: true });
  await page.screenshot({ path: screenshotPath });

  const assertTheme = async (flavor, mode, bg, label) => {
    await page.waitForFunction(
      (t) =>
        document.documentElement.getAttribute('data-flavor') === t.flavor &&
        document.documentElement.getAttribute('data-mode') === t.mode,
      { flavor, mode },
      { timeout: 5000 },
    );
    attrs = await themeAttrs();
    const actual = await bodyBg();
    assert(
      actual === bg,
      `${label}: expected body bg ${bg}, got ${actual} (${JSON.stringify(attrs)})`,
    );
  };

  // Round-4: the raw text toggles are gone. Round-12 #4: mode + settings now live
  // in the bottom-left profile DROPUP (opened via data-testid="profile-button");
  // the mode item keeps data-testid="toggle-mode". Drive both to verify all 4
  // flavor/mode combos still restyle the surface.
  assert(
    (await page.locator('[data-testid="toggle-flavor"]').count()) === 0,
    'the dev "claude"/"theme" text toggles must be removed from the top bar (img32)',
  );

  // Open the profile dropup; the theme item flips in place (menu stays open).
  await page.click('[data-testid="profile-button"]');
  await page.waitForSelector('[data-testid="profile-menu"]', { timeout: 8000 });

  // claude/dark → claude/light via the sun quick-toggle.
  await page.click('[data-testid="toggle-mode"]');
  await assertTheme('claude', 'light', 'rgb(250, 249, 245)', 'mode quick-toggle → claude/light');
  // …and back to claude/dark.
  await page.click('[data-testid="toggle-mode"]');
  await assertTheme('claude', 'dark', 'rgb(38, 38, 36)', 'mode quick-toggle → claude/dark');

  // Flavor lives in Interface → Advanced now (round-5 #23); mode stays in
  // Appearance. Settings opens from the same dropup (still open from above).
  await page.click('[data-testid="open-settings"]');
  await page.waitForSelector('[data-testid="settings-view"]', { timeout: 8000 });
  await page.click('[data-testid="settings-nav-interface"]');
  await page.waitForSelector('[data-testid="settings-flavor"]', { timeout: 8000 });
  await page.click('[data-testid="settings-flavor"] >> text=Codex');
  await assertTheme('codex', 'dark', 'rgb(24, 24, 24)', 'settings flavor → codex/dark');
  await page.click('[data-testid="settings-nav-appearance"]');
  await page.waitForSelector('[data-testid="settings-mode"]', { timeout: 8000 });
  await page.click('[data-testid="settings-mode"] >> text=Light');
  await assertTheme('codex', 'light', 'rgb(255, 255, 255)', 'settings mode → codex/light');

  console.log(`probe OK — all 4 flavor/mode combos verified; screenshot: ${screenshotPath}`);
} finally {
  await app.close();
}
