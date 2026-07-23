/**
 * Theme toggle E2E (round-3 bug 1): the top-bar flavor/mode toggles must switch
 * the theme LIVE, PERSIST to settings.json, and STICK across a relaunch of the
 * REAL (non-E2E) app.
 *
 * Why this exists on top of probe.mjs: probe.mjs drives the toggles with
 * Playwright's synthetic clicks, which ignore `-webkit-app-region: drag`. The
 * real bug was that the plain toggle buttons sat in the draggable top bar with
 * no no-drag opt-out, so real OS mouse clicks were swallowed and the toggle did
 * nothing. Synthetic clicks can't catch that, but they DO exercise the handler
 * wiring + persistence, which is what this probe verifies. Pass B relaunches
 * WITHOUT PI_E2E so connectSettings actually applies the persisted theme at
 * boot — proving persistence end to end and that a stale onboarding.json theme
 * does not clobber the toggled settings.json theme.
 *
 * Run `pnpm build` first.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
  if (!condition) throw new Error(`theme-toggle-probe failed: ${message}`);
}

assert(existsSync(path.join(appRoot, 'dist/index.html')), 'app is not built — run `pnpm build`');

const home = mkdtempSync(path.join(tmpdir(), 'pi-e2e-home-'));
const settingsPath = path.join(home, '.pi', 'desktop', 'settings.json');
const onboardingPath = path.join(home, '.pi', 'desktop', 'onboarding.json');
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
  throw new Error(`theme-toggle-probe failed: timed out waiting for ${label}`);
}

const themeAttrs = (page) =>
  page.evaluate(() => ({
    flavor: document.documentElement.getAttribute('data-flavor'),
    mode: document.documentElement.getAttribute('data-mode'),
  }));

// ── Pass A: toggles switch live + persist to settings.json (PI_E2E) ───────────
{
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'));
  const app = await electron.launch({
    executablePath: electronBinary,
    args: [appRoot, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, HOME: home, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('[data-testid="profile-button"]', { timeout: 12000 });

    let attrs = await themeAttrs(page);
    assert(
      attrs.flavor === 'bobble' && attrs.mode === 'dark',
      `unexpected initial theme ${JSON.stringify(attrs)}`,
    );

    // Round-4: the raw text toggles are gone; a single clean icon quick-toggle
    // controls mode, and flavor moved into the settings menu.
    assert(
      (await page.locator('[data-testid="toggle-flavor"]').count()) === 0,
      'the "claude" flavor text toggle must be removed from the top bar (img32)',
    );

    // Root-cause guard for the real bug: the top bar is a drag region, or real OS
    // mouse clicks on its interactive children are swallowed. Invisible to
    // Playwright's synthetic clicks (they ignore -webkit-app-region), so assert
    // the computed drag region directly. (The mode toggle moved out of the top
    // bar into the bottom-left profile dropup in round-12 #4.)
    const dragBar = await page.evaluate(() =>
      getComputedStyle(document.querySelector('.pd-topbar'))
        .getPropertyValue('-webkit-app-region')
        .trim(),
    );
    assert(dragBar === 'drag', `top bar should be a drag region, got "${dragBar}"`);

    // Mode quick-toggle now lives in the bottom-left profile DROPUP (round-12 #4);
    // open it, then flip dark → light, live, with flavor untouched + persisted.
    // The theme row keeps the menu open on flip so settings opens from it next.
    await page.click('[data-testid="profile-button"]');
    await page.waitForSelector('[data-testid="profile-menu"]', { timeout: 8000 });
    await page.click('[data-testid="toggle-mode"]');
    await page.waitForFunction(
      () => document.documentElement.getAttribute('data-mode') === 'light',
      { timeout: 5000 },
    );
    attrs = await themeAttrs(page);
    assert(attrs.flavor === 'bobble', `mode toggle changed flavor: ${JSON.stringify(attrs)}`);
    await waitFor(() => readSettings().theme.mode === 'light', 'mode persisted to settings.json');

    // Flavor via the settings menu (the "Settings" row of the same open dropup):
    // claude → codex, live, and mode untouched + persisted. Round-5 #23 moved
    // the flavor toggle out of Appearance into Interface → Advanced.
    await page.click('[data-testid="open-settings"]');
    await page.waitForSelector('[data-testid="settings-view"]', { timeout: 8000 });
    await page.click('[data-testid="settings-nav-interface"]');
    await page.waitForSelector('[data-testid="settings-flavor"]', { timeout: 8000 });
    await page.click('[data-testid="settings-flavor"] >> text=Codex');
    await page.waitForFunction(
      () => document.documentElement.getAttribute('data-flavor') === 'codex',
      { timeout: 5000 },
    );
    attrs = await themeAttrs(page);
    assert(attrs.mode === 'light', `flavor change moved mode: ${JSON.stringify(attrs)}`);
    await waitFor(
      () => readSettings().theme.flavor === 'codex',
      'flavor persisted to settings.json',
    );

    console.log(
      'theme-toggle-probe OK (pass A) — quick-toggle + settings switch live + persist codex/light',
    );
  } finally {
    await app.close();
  }
}

// ── Pass B: relaunch the REAL (non-E2E) app; persisted theme is re-applied ─────
// Seed a completed onboarding whose theme DIFFERS from what we toggled, to prove
// settings.json (codex/light) — not the stale onboarding choice (claude/dark) —
// drives the boot theme.
mkdirSync(path.dirname(onboardingPath), { recursive: true });
writeFileSync(
  onboardingPath,
  `${JSON.stringify({
    version: 1,
    completedAt: new Date().toISOString(),
    choices: {
      source: 'neither',
      imports: { mcp: false, theme: false, sessions: false, skills: false },
      theme: { flavor: 'claude', mode: 'dark' },
      experience: 'new',
      tutorial: false,
      permissionMode: 'reviewer',
      capabilities: { image: false, video: false, audio: false, threeD: false },
      importedSessionCount: 0,
    },
  })}\n`,
);

{
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'));
  const app = await electron.launch({
    executablePath: electronBinary,
    args: [appRoot, `--user-data-dir=${userDataDir}`],
    // No PI_E2E: exercise the real boot path where connectSettings applies the
    // persisted settings.json theme. onboarding.json makes the gate land in chat.
    env: { ...process.env, HOME: home, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('[data-testid="profile-button"]', { timeout: 12000 });
    // The real app applies the persisted theme at boot (async, after settings:get).
    await page.waitForFunction(
      () =>
        document.documentElement.getAttribute('data-flavor') === 'codex' &&
        document.documentElement.getAttribute('data-mode') === 'light',
      { timeout: 8000 },
    );
    const attrs = await themeAttrs(page);
    assert(
      attrs.flavor === 'codex' && attrs.mode === 'light',
      `persisted theme not re-applied on relaunch: ${JSON.stringify(attrs)}`,
    );
    console.log(
      'theme-toggle-probe OK (pass B) — non-E2E relaunch re-applied persisted codex/light (stale onboarding claude/dark did NOT win)',
    );
  } finally {
    await app.close();
  }
}
