/**
 * Round-14 COMPOSER E2E (issues 2/3/4): launches the built app against mock-pi
 * and drives the real composer bar + footer chip. Asserts the objectively
 * TESTABLE halves of the wave:
 *
 *   #2  the effort SLIDER is no longer inline — an "Effort" button
 *       (data-testid=composer-effort) opens it inside a popover.
 *   #3  the stray centre dot is gone (.pd-tier-dot never renders); under Auto the
 *       tier control is a clickable "[Auto] · [<tier>]" whose segments open the
 *       shared tier picker; the whole control HIDES when a tier/model is pinned.
 *   #4  the footer model chip shows the mode/tier LABEL ("Balanced"), not the
 *       raw running model id, once a tier is pinned.
 *
 * The gradient / motion FEEL is owner-validated (not asserted). Run `pnpm build`
 * first.
 */
import { existsSync, mkdtempSync } from 'node:fs';
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
const fixture = path.join(repoRoot, 'packages/engine/tools/mock-pi/fixtures/tool-use.json');

function assert(condition, message) {
  if (!condition) throw new Error(`round14-composer-probe failed: ${message}`);
}

assert(
  existsSync(path.join(appRoot, 'dist/index.html')) &&
    existsSync(path.join(appRoot, 'dist-electron/main.js')),
  'app is not built — run `pnpm build` first',
);

const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'));
const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${userDataDir}`],
  env: { ...process.env, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});

try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 8000 });
  await page.waitForFunction(() => typeof window.__settings_store === 'function', {
    timeout: 8000,
  });
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 8000 });

  // Make sure we start from Auto (the default) so the tier control is present.
  await page.evaluate(() =>
    window
      .__settings_store()
      .getState()
      .update({ modelSelection: { mode: 'auto' } }),
  );

  // ── #3: no stray centre dot, tier control present under Auto ───────────────
  assert(
    (await page.locator('.pd-tier-dot').count()) === 0,
    'the retired decorative .pd-tier-dot must not render anywhere',
  );
  await page.locator('[data-testid="composer-tier"]').waitFor({ timeout: 8000 });
  assert(
    (await page.locator('[data-testid="composer-tier-auto"]').count()) === 1,
    'the Auto segment should render inside the tier control',
  );

  // ── #2: the "Effort" button opens the slider in a popover ──────────────────
  const effortBtn = page.locator('[data-testid="composer-effort"]');
  await effortBtn.waitFor({ timeout: 8000 });
  assert(
    (await page.locator('[data-testid="composer-effort-slider"]').count()) === 0,
    'the effort slider must NOT be inline — it lives behind the Effort button',
  );
  await effortBtn.click();
  const slider = page.locator('[data-testid="composer-effort-slider"]');
  await slider.waitFor({ state: 'visible', timeout: 8000 });
  assert(
    (await slider.locator('[role="slider"]').count()) >= 1,
    'the popover should mount the real EffortSlider (role="slider" track)',
  );
  await page.keyboard.press('Escape');
  await slider.waitFor({ state: 'detached', timeout: 8000 });

  // ── #3: a tier segment opens the shared tier picker (Auto + the tier rows) ──
  await page.click('[data-testid="composer-tier-auto"]');
  await page.locator('[data-testid="footer-auto"]').first().waitFor({ timeout: 8000 });
  await page.locator('[data-testid="footer-tier"]').first().waitFor({ timeout: 8000 });

  // ── #3 + #4: pin a tier → the bar tier control (and its open menu) unmount,
  // and the chip names the tier instead of the raw model id.
  await page.evaluate(() =>
    window
      .__settings_store()
      .getState()
      .update({ modelSelection: { mode: 'tier', tier: 'balanced' } }),
  );
  await page.locator('[data-testid="composer-tier"]').waitFor({ state: 'detached', timeout: 8000 });
  await page
    .locator('[data-testid="footer-auto"]')
    .first()
    .waitFor({ state: 'detached', timeout: 8000 });
  await page.waitForFunction(
    () => {
      const chip = document.querySelector('[data-testid="footer-model-chip"]');
      return (chip?.textContent ?? '').includes('Balanced');
    },
    undefined,
    { timeout: 8000 },
  );
  const chipText = (await page.locator('[data-testid="footer-model-chip"]').innerText()).trim();
  assert(
    /Balanced/.test(chipText),
    `the chip should show the tier label "Balanced", got ${JSON.stringify(chipText)}`,
  );

  // Restore Auto so the shared state is clean; the tier control returns.
  await page.evaluate(() =>
    window
      .__settings_store()
      .getState()
      .update({ modelSelection: { mode: 'auto' } }),
  );
  await page.locator('[data-testid="composer-tier"]').waitFor({ timeout: 8000 });

  console.log(
    'round14-composer-probe OK — no .pd-tier-dot; Effort button reveals the slider popover; ' +
      'tier segments open the shared picker; pinning a tier hides the bar control + the chip shows "Balanced" (not the raw model name)',
  );
} finally {
  await app.close();
}
