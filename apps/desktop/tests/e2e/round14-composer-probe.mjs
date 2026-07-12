/**
 * Round-14/15 COMPOSER E2E: launches the built app against mock-pi and drives the
 * real composer bar + footer chip. Asserts the objectively TESTABLE halves of the
 * wave:
 *
 *   #2  the effort SLIDER is no longer inline — an "Effort" button
 *       (data-testid=composer-effort) opens it inside a popover, and the button
 *       carries the labeled readout: "Effort · Auto" in the default auto state
 *       (the word "Auto", mirroring the model chip), or "Effort · <Level>" when a
 *       level is pinned.
 *   round-15 the center TierRegion is gone: the bar renders folder-LEFT +
 *       effort-RIGHT only, with an empty flex spacer between them, so the
 *       composer-tier* testids never mount and the stray .pd-tier-dot is gone.
 *   round-A the footer model chip names the ACTUALLY-LOADED model under Auto
 *       ("Auto · <loaded model>", from the resident inference model / pi's active
 *       model — NEVER the routed tier), and the friendly tier LABEL ("Balanced")
 *       when a tier is pinned. The live tok/s readout is gone from the input bar
 *       (#2), and the turn-stats info button is hidden for power users (#1).
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

  // Make sure we start from Auto (the default) so the chip speaks for routing,
  // and reset the effort to auto/medium — settings persist app-globally (not in
  // the throwaway user-data-dir), so a prior pinned (level-mode) effort would
  // otherwise leak in and make the "Effort · Auto" readout non-deterministic.
  await page.evaluate(() =>
    window
      .__settings_store()
      .getState()
      .update({ modelSelection: { mode: 'auto' }, effortMode: 'auto', effort: 'medium' }),
  );

  // ── round-15: the center tier control is gone entirely ─────────────────────
  assert(
    (await page.locator('.pd-tier-dot').count()) === 0,
    'the retired decorative .pd-tier-dot must not render anywhere',
  );
  assert(
    (await page.locator('[data-testid="composer-tier"]').count()) === 0,
    'the center TierRegion must be removed — [data-testid="composer-tier"] must not render',
  );
  assert(
    (await page.locator('[data-testid="composer-tier-auto"]').count()) === 0,
    'the removed Auto segment (composer-tier-auto) must not render',
  );
  // The bar still mounts, with the project chip left and the effort button right
  // pushed apart by the empty center spacer.
  assert(
    (await page.locator('[data-testid="composer-bar"] .pd-composer-bar-center').count()) === 1,
    'the empty center flex spacer must remain (it pushes folder-left / effort-right apart)',
  );

  // ── round-A #3: the footer chip names the ACTUALLY-LOADED model under Auto ──
  // No model resident yet ⇒ the chip reads plain "Auto".
  await page.waitForFunction(
    () => {
      const chip = document.querySelector('[data-testid="footer-model-chip"]');
      return (chip?.textContent ?? '').trim() === 'Auto';
    },
    undefined,
    { timeout: 8000 },
  );
  // Make a model "resident": in this mock env the local supervisor has nothing
  // downloaded (status.model stays null), so the chip falls back to pi's active
  // model name. Set it and the Auto chip must re-render to "Auto · <loaded model>"
  // (proves chipLabel names the LOADED model, not a tier).
  await page.evaluate(() =>
    window.__pi_store().setState((s) => ({
      agent: {
        ...s.agent,
        model: { id: 'gemma-4-e2b-it', name: 'gemma4 e2b', provider: 'llamacpp' },
      },
    })),
  );
  await page.waitForFunction(
    () =>
      (document.querySelector('[data-testid="footer-model-chip"]')?.textContent ?? '').trim() ===
      'Auto · gemma4 e2b',
    undefined,
    { timeout: 8000 },
  );
  const autoChip = (await page.locator('[data-testid="footer-model-chip"]').innerText()).trim();
  assert(
    autoChip === 'Auto · gemma4 e2b',
    `under Auto the chip should name the LOADED model ("Auto · gemma4 e2b"), not the tier, got ${JSON.stringify(autoChip)}`,
  );
  // Publish a harness active tier too (it drives the effort slider POSITION below).
  // It must NOT change the chip — Auto names the loaded model, never the tier.
  await page.evaluate(() =>
    window.__pi_store().setState((s) => ({
      extensionStatus: {
        ...s.extensionStatus,
        harness: JSON.stringify({ activeTier: 'balanced' }),
      },
    })),
  );
  const stillLoaded = (await page.locator('[data-testid="footer-model-chip"]').innerText()).trim();
  assert(
    stillLoaded === 'Auto · gemma4 e2b',
    `publishing a routed tier must not change the Auto chip off the loaded model, got ${JSON.stringify(stillLoaded)}`,
  );

  // ── #2: the "Effort" button opens the slider in a popover ──────────────────
  const effortBtn = page.locator('[data-testid="composer-effort"]');
  await effortBtn.waitFor({ timeout: 8000 });
  // In the default auto state the button reads the literal "Effort · Auto" (the
  // word "Auto", mirroring the model chip) — NOT the resolved level, even though
  // the balanced tier is routed and the slider knob rests at the balanced tick.
  await page.waitForFunction(
    () =>
      (document.querySelector('[data-testid="composer-effort"]')?.textContent ?? '').trim() ===
      'Effort · Auto',
    undefined,
    { timeout: 8000 },
  );
  const effortLabel = (await effortBtn.innerText()).trim();
  assert(
    effortLabel === 'Effort · Auto',
    `the effort button should read "Effort · Auto" in the default auto state, got ${JSON.stringify(effortLabel)}`,
  );
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

  // ── round-A #2: the live tok/s readout is gone from the input bar ──────────
  assert(
    (await page.locator('[data-testid="tps"]').count()) === 0,
    'the tok/s readout must be removed from the input bar (it moved to the message action bar)',
  );
  assert(
    !(await page.locator('.pd-composer-footer').innerText()).includes('tok/s'),
    'no "tok/s" text may remain anywhere in the composer footer',
  );

  // ── round-A #1: the turn-stats info button is hidden for POWER users ───────
  // Visible in the default (user) mode…
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="footer-info"]').length === 1,
    undefined,
    { timeout: 8000 },
  );
  // …hidden once the experience mode is power…
  await page.evaluate(() => window.__settings_store().getState().update({ userMode: 'power' }));
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="footer-info"]').length === 0,
    undefined,
    { timeout: 8000 },
  );
  // …and back once it returns to user (restore the shared mode).
  await page.evaluate(() => window.__settings_store().getState().update({ userMode: 'user' }));
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="footer-info"]').length === 1,
    undefined,
    { timeout: 8000 },
  );

  // ── round-15: pin a tier → the chip names the tier LABEL, not "Auto · …" and
  // not the raw model id. The center control stays absent throughout.
  await page.evaluate(() =>
    window
      .__settings_store()
      .getState()
      .update({ modelSelection: { mode: 'tier', tier: 'balanced' } }),
  );
  await page.waitForFunction(
    () => {
      const t = (
        document.querySelector('[data-testid="footer-model-chip"]')?.textContent ?? ''
      ).trim();
      return t === 'Balanced';
    },
    undefined,
    { timeout: 8000 },
  );
  const chipText = (await page.locator('[data-testid="footer-model-chip"]').innerText()).trim();
  assert(
    chipText === 'Balanced',
    `the pinned-tier chip should show exactly "Balanced" (not "Auto · …" / the raw model name), got ${JSON.stringify(chipText)}`,
  );
  assert(
    (await page.locator('[data-testid="composer-tier"]').count()) === 0,
    'the center tier control must stay absent when a tier is pinned',
  );

  // Restore Auto so the shared state is clean; the chip returns to naming the
  // loaded model ("Auto · gemma4 e2b").
  await page.evaluate(() =>
    window
      .__settings_store()
      .getState()
      .update({ modelSelection: { mode: 'auto' } }),
  );
  await page.waitForFunction(
    () =>
      (document.querySelector('[data-testid="footer-model-chip"]')?.textContent ?? '')
        .trim()
        .startsWith('Auto'),
    undefined,
    { timeout: 8000 },
  );

  console.log(
    'round14-composer-probe OK — no .pd-tier-dot / composer-tier; empty center spacer; ' +
      'the Effort button reads "Effort · Auto" and reveals the slider popover; the footer ' +
      'chip shows "Auto · gemma4 e2b" (the LOADED model, not the tier) under Auto and "Balanced" ' +
      'when a tier is pinned; the tok/s readout is gone from the input bar; and the turn-stats ' +
      'info button is hidden for power users',
  );
} finally {
  await app.close();
}
