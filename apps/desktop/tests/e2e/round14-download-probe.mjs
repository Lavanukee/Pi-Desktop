/**
 * Round-14 WAVE-DOWNLOAD E2E (issue 5): the auto-download prompt is now a
 * CENTERED Dialog, not the old floating dark pill. Lands in chat (mock pi),
 * parks a `pendingDownload` through the model-selection store hook (enriching
 * the loaded catalog with a verified + recommended + vision entry), and asserts
 * the Dialog:
 *   - is a real `.pd-dialog` with a scrim overlay (centered, not chip-anchored);
 *   - renders Verified + Recommended chips, a size pill, a Vision pill, and the
 *     speedometer speed word ("slow" for the intelligent tier);
 *   - shows a full-width Download button that swaps to "Downloading… N%" +
 *     reveals a Cancel button mid-flight, whose click fires `cancelDownload`;
 *   - dismisses via the corner X (clears `pendingDownload`).
 * Layout / zoom-in motion are owner-validated FEEL — not asserted here. No real
 * download (driven through the store hooks, like model-manager-probe). Run
 * `pnpm build` first.
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
const fixture = path.join(repoRoot, 'packages/engine/tools/mock-pi/fixtures/simple-chat.json');

function assert(condition, message) {
  if (!condition) throw new Error(`round14-download-probe failed: ${message}`);
}

assert(existsSync(path.join(appRoot, 'dist/index.html')), 'app is not built — run `pnpm build`');

const home = mkdtempSync(path.join(tmpdir(), 'pi-e2e-home-'));
const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'));
const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${userDataDir}`],
  env: { ...process.env, HOME: home, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});

// The tier pick the router would park (intelligent → "slow"), plus a catalog
// entry carrying the trust/modality attributes the Dialog cross-looks-up.
const MODEL_ID = 'probe-intelligent-70b';
const pick = {
  modelId: MODEL_ID,
  displayName: 'Probe Intelligent 70B',
  quant: 'Q4_K_M',
  launchMode: 'fast-text',
  spec: 'mtp',
  vision: true,
  bytes: 40e9,
  downloaded: false,
};
const entry = {
  id: MODEL_ID,
  displayName: 'Probe Intelligent 70B',
  quants: [{ quant: 'Q4_K_M', bytes: 40e9 }],
  minRamGB: 48,
  contextWindow: 32768,
  input: ['text', 'image'],
  license: 'apache-2.0',
  mtp: true,
  spec: 'mtp',
  vision: true,
  downloaded: false,
  recommended: true,
  publisher: { handle: 'unsloth', reliable: true },
  verified: true,
};

try {
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 12000 });

  // ── Park a pending download (enrich the catalog first) ──────────────────────
  await page.evaluate(
    ({ entry, pick }) => {
      const llm = window.__llm_store();
      llm.setState({ catalog: [entry], recommendedModelId: entry.id });
      window.__model_selection_store().getState().setPendingDownload({ tier: 'intelligent', pick });
    },
    { entry, pick },
  );

  // ── It is a CENTERED Dialog (scrim overlay + .pd-dialog card) ───────────────
  await page.waitForSelector('[data-testid="auto-download-prompt"]', { timeout: 8000 });
  await page.waitForSelector('.pd-dialog-overlay', { timeout: 8000 });
  const dialogClass = await page.getAttribute('[data-testid="auto-download-prompt"]', 'class');
  assert(
    dialogClass !== null && dialogClass.includes('pd-dialog'),
    `expected the prompt to be a .pd-dialog, got class="${dialogClass}"`,
  );

  const scope = page.locator('[data-testid="auto-download-prompt"]');

  // ── Verified + Recommended chips ────────────────────────────────────────────
  assert(
    (await scope.locator('[data-pill-kind="reliable"]').count()) >= 1,
    'expected a Verified (reliable-hue) chip',
  );
  assert(
    (await scope.locator('[data-pill-kind="recommended"]').count()) >= 1,
    'expected a Recommended chip',
  );

  // ── Size pill + Vision modality pill ────────────────────────────────────────
  assert((await scope.locator('[data-pill-kind="size"]').count()) >= 1, 'expected a size pill');
  assert(
    (await scope.locator('[data-pill-kind="vision"]').count()) >= 1,
    'expected a Vision modality pill',
  );

  // ── Speedometer speed word (intelligent tier → "slow") ──────────────────────
  const speedText = await scope.locator('[data-testid="download-speed"]').innerText();
  assert(/slow/i.test(speedText), `expected the speed word "slow", got: "${speedText}"`);

  // ── Big Download button, not yet downloading ────────────────────────────────
  await page.waitForSelector('[data-testid="auto-download-btn"]', { timeout: 8000 });
  const idleBtn = await page.locator('[data-testid="auto-download-btn"]').innerText();
  assert(/download/i.test(idleBtn), `expected a Download button, got: "${idleBtn}"`);
  assert(
    (await scope.locator('[data-testid="auto-download-cancel"]').count()) === 0,
    'Cancel must NOT show before a download is in-flight',
  );

  // ── Drive a mid-flight download → Download swaps + Cancel appears ────────────
  await page.evaluate((id) => {
    window.__llm_store().getState().applyDownloadProgress({
      modelId: id,
      file: 'model.gguf',
      received: 1e10,
      total: 4e10,
      fraction: 0.25,
    });
  }, MODEL_ID);
  await page.waitForSelector('[data-testid="auto-download-cancel"]', { timeout: 8000 });
  await page.waitForFunction(
    () =>
      /Downloading/i.test(
        document.querySelector('[data-testid="auto-download-btn"]')?.textContent ?? '',
      ),
    undefined,
    { timeout: 8000 },
  );
  const busyBtn = await page.locator('[data-testid="auto-download-btn"]').innerText();
  assert(busyBtn.includes('25%'), `expected the download %, got: "${busyBtn}"`);

  // ── Cancel fires the real cancelDownload (clears the store bar) ──────────────
  await page.click('[data-testid="auto-download-cancel"]');
  await page.waitForFunction(() => window.__llm_store().getState().download === null, undefined, {
    timeout: 8000,
  });
  // Back to the idle Download button, Cancel gone (Dialog stays open).
  await page.waitForSelector('[data-testid="auto-download-prompt"]', { timeout: 8000 });
  assert(
    (await scope.locator('[data-testid="auto-download-cancel"]').count()) === 0,
    'Cancel should disappear once the download is cleared',
  );

  // ── Corner X dismisses (clears pendingDownload) ─────────────────────────────
  await page.click('[data-testid="auto-download-prompt"] button[aria-label="Close"]');
  await page.waitForSelector('[data-testid="auto-download-prompt"]', {
    state: 'detached',
    timeout: 8000,
  });
  await page.waitForFunction(
    () => window.__model_selection_store().getState().pendingDownload === null,
    undefined,
    { timeout: 8000 },
  );

  console.log(
    'round14-download-probe OK — auto-download prompt is a centered Dialog (scrim + .pd-dialog); ' +
      'Verified + Recommended chips, size + Vision pills, speedometer "slow" word; ' +
      'Download → Downloading N% + Cancel mid-flight (cancelDownload clears the bar); corner-X dismisses',
  );
} finally {
  await app.close();
}
