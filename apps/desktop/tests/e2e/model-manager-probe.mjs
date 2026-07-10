/**
 * Model Manager E2E: lands in chat (mock pi), opens the manager from the top-bar
 * gear → Models section, and asserts the real catalog renders as cards with RAM
 * badges + a hardware-detected recommendation banner. Then, WITHOUT a real
 * download, drives the download-progress + set-active flow through the llm store
 * hook and asserts the card reflects live progress → running/TPS. Also checks
 * the composer model-chip deep-link into the manager. Run `pnpm build` first.
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
  if (!condition) throw new Error(`model-manager-probe failed: ${message}`);
}

assert(existsSync(path.join(appRoot, 'dist/index.html')), 'app is not built — run `pnpm build`');

const home = mkdtempSync(path.join(tmpdir(), 'pi-e2e-home-'));
const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'));
const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${userDataDir}`],
  env: { ...process.env, HOME: home, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});

try {
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 12000 });

  // ── Open the manager from the bottom-left profile dropup, then Models ────────
  await page.click('[data-testid="profile-button"]');
  await page.waitForSelector('[data-testid="profile-menu"]', { timeout: 8000 });
  await page.click('[data-testid="open-settings"]');
  await page.waitForSelector('[data-testid="settings-view"]', { timeout: 8000 });
  await page.click('[data-testid="settings-nav-models"]');
  await page.waitForSelector('[data-testid="model-manager"]', { timeout: 8000 });

  // Hardware summary + at least one catalog card.
  await page.waitForSelector('[data-testid="hardware-summary"]', { timeout: 8000 });
  await page.waitForSelector('[data-testid^="model-card-"]', { timeout: 8000 });
  const cardCount = await page.locator('[data-testid^="model-card-"]').count();
  assert(cardCount > 0, `expected catalog cards, got ${cardCount}`);

  // Every card carries a RAM badge.
  const ramBadges = await page.locator('[data-testid^="ram-badge-"]').count();
  assert(ramBadges === cardCount, `expected ${cardCount} RAM badges, got ${ramBadges}`);

  // Hardware-detected recommendation (banner + a recommended badge).
  await page.waitForSelector('[data-testid="recommendation-banner"]', { timeout: 8000 });
  const recBadges = await page.locator('[data-testid^="recommended-badge-"]').count();
  assert(recBadges >= 1, 'expected a recommended badge on the recommended card');

  // ── Round-10 #20b: colored capability PILL TAGS render on curated cards ─────
  const pillCount = await page.locator('[data-pill-kind]').count();
  assert(pillCount > 0, `expected colored pill tags on the cards, got ${pillCount}`);
  // Each ModelCard carries a size pill, so there is at least one per card.
  const sizePills = await page.locator('[data-pill-kind="size"]').count();
  assert(
    sizePills >= cardCount,
    `expected a size pill per card, got ${sizePills} for ${cardCount}`,
  );
  // The recommended attribute renders as its own (green) hue pill.
  const recommendedPills = await page.locator('[data-pill-kind="recommended"]').count();
  assert(recommendedPills >= 1, `expected a recommended-hue pill, got ${recommendedPills}`);

  // ── Round-11 Wave C: "Recommended for your Mac" simple set + a speed pill ────
  // A non-power-user pick set (fastest / best-for-images / lightweight helper),
  // hardware-detected, renders with a one-click "Use" per pick.
  await page.waitForSelector('[data-testid="recommended-for-mac"]', { timeout: 8000 });
  const simplePicks = await page.locator('[data-testid^="simple-pick-use-"]').count();
  assert(simplePicks >= 1, `expected >=1 simple pick, got ${simplePicks}`);
  // The catalog now ships speculative-decoding SPEED variants, so a fast pill
  // (MTP blue or EAGLE-3 teal) must render somewhere on the surface.
  const fastPills =
    (await page.locator('[data-pill-kind="mtp"]').count()) +
    (await page.locator('[data-pill-kind="eagle3"]').count());
  assert(fastPills >= 1, `expected a fast (MTP/EAGLE-3) pill, got ${fastPills}`);

  // ── Round-12 W4: de-duplicated cards + variant/quant dropdowns + reliable ────
  // The catalog ships Qwen3.6 27B twice (an MTP repo + an EAGLE-3 repo); the
  // manager must collapse them into ONE card (primary = the MTP entry), so the
  // EAGLE-3 entry never gets its own card.
  const qwenCards = await page.locator('[data-testid="model-card-qwen3.6-27b-mtp"]').count();
  assert(qwenCards === 1, `expected 1 collapsed Qwen3.6 27B card, got ${qwenCards}`);
  const qwenDupCard = await page.locator('[data-testid="model-card-qwen3.6-27b-eagle3"]').count();
  assert(qwenDupCard === 0, 'the EAGLE-3 variant must NOT get its own duplicate card');

  // The collapsed card exposes a VARIANT dropdown [MTP / DFlash / EAGLE-3].
  await page.waitForSelector('[data-testid="variant-qwen3.6-27b-mtp"]', { timeout: 8000 });
  // A multi-quant model exposes a QUANT dropdown.
  await page.waitForSelector('[data-testid="quant-gemma-4-12b-it"]', { timeout: 8000 });

  // Every curated card carries a reliable-publisher badge (all are unsloth-hosted).
  const reliableBadges = await page.locator('[data-testid^="reliable-badge-"]').count();
  assert(reliableBadges >= 1, `expected reliable-publisher badges, got ${reliableBadges}`);

  // Selecting the DFlash variant renders the (new) DFlash speed pill.
  await page.click('[data-testid="variant-qwen3.6-27b-mtp"]');
  await page.getByRole('option', { name: 'DFlash' }).click();
  await page.waitForSelector('[data-pill-kind="dflash"]', { timeout: 8000 });

  // ── Drive download-progress → active WITHOUT a real download ─────────────────
  const modelId = await page.evaluate(() => window.__llm_store().getState().catalog[0].id);

  // Inject a progress event (exercises the real applyDownloadProgress path).
  await page.evaluate((id) => {
    window.__llm_store().getState().applyDownloadProgress({
      modelId: id,
      file: 'model.gguf',
      received: 1e9,
      total: 4e9,
      fraction: 0.25,
    });
  }, modelId);
  await page.waitForSelector(`[data-testid="download-${modelId}"]`, { timeout: 8000 });
  const progressText = await page.locator(`[data-testid="download-${modelId}"]`).innerText();
  assert(progressText.includes('25%'), `expected 25% in download row, got: ${progressText}`);

  // Simulate set-active completion: clear the bar + publish a running status.
  await page.evaluate((id) => {
    const store = window.__llm_store();
    store.setState({ download: null });
    store.getState().applyStatus({
      phase: 'ready',
      serverRunning: true,
      baseUrl: 'http://127.0.0.1:8080/v1',
      model: { id, displayName: 'Test', quant: 'Q4_K_M', contextWindow: 16384 },
      metrics: { avgTps: 42.5 },
      downloadedModelIds: [id],
    });
  }, modelId);
  await page.waitForSelector(`[data-testid="active-badge-${modelId}"]`, { timeout: 8000 });
  const statusText = await page.locator(`[data-testid="status-${modelId}"]`).innerText();
  assert(statusText.includes('Running'), `expected Running status, got: ${statusText}`);
  assert(statusText.includes('42.5'), `expected TPS in status, got: ${statusText}`);
  assert(statusText.includes(':8080'), `expected port in status, got: ${statusText}`);

  // ── Cancel an in-flight download via the ModelCard cancel button ────────────
  // Re-inject a download for the same model, then CLICK the cancel-download
  // testid: the real cancelDownload store action fires llm:cancel-download (the
  // supervisor aborts the transfer + discards its .part) and clears the bar.
  // Mock-driven like the progress path above — no live transfer.
  await page.evaluate((id) => {
    window.__llm_store().getState().applyDownloadProgress({
      modelId: id,
      file: 'model.gguf',
      received: 5e8,
      total: 4e9,
      fraction: 0.125,
    });
  }, modelId);
  await page.waitForSelector(`[data-testid="cancel-download-${modelId}"]`, { timeout: 8000 });
  await page.click(`[data-testid="cancel-download-${modelId}"]`);
  // The download aborts: the store clears the bar and the progress row unmounts.
  await page.waitForFunction(() => window.__llm_store().getState().download === null, undefined, {
    timeout: 8000,
  });
  const downloadRowsAfterCancel = await page.locator(`[data-testid="download-${modelId}"]`).count();
  assert(downloadRowsAfterCancel === 0, 'download row should be gone after cancel');

  // ── Advanced toggle → per-model default effort persists ─────────────────────
  await page.click('[data-testid="mm-advanced-toggle"]');
  await page.waitForSelector(`[data-testid="advanced-${modelId}"]`, { timeout: 8000 });

  // ── Round-12 W4: the "Prefer MLX (experimental)" toggle persists + engine badge
  // Advanced reveals the MLX engine-preference toggle and each card's engine badge.
  await page.waitForSelector('[data-testid="mm-mlx-toggle"]', { timeout: 8000 });
  const engineBadges = await page.locator('[data-testid^="engine-badge-"]').count();
  assert(engineBadges >= 1, `expected engine badges in Advanced, got ${engineBadges}`);
  await page.click('[data-testid="mm-mlx-toggle"]');
  await page.waitForFunction(
    () => window.__settings_store().getState().settings.enginePreference === 'mlx',
    undefined,
    { timeout: 8000 },
  );

  await page.click(`[data-testid="effort-default-${modelId}"]`);
  await page.getByRole('option', { name: 'High' }).click();
  await page.waitForFunction(
    (id) => window.__settings_store().getState().settings.modelEffortDefaults[id] === 'high',
    modelId,
    { timeout: 8000 },
  );

  // ── Favorites: star the curated model, assert it persists ───────────────────
  await page.click(`[data-testid="favorite-${modelId}"]`);
  await page.waitForFunction(
    (id) => window.__settings_store().getState().settings.favoriteModels.includes(id),
    modelId,
    { timeout: 8000 },
  );
  // The Favorites-only filter now appears and narrows the list to the starred card.
  await page.click('[data-testid="mm-favorites-toggle"]');
  await page.waitForSelector(`[data-testid="model-card-${modelId}"]`, { timeout: 8000 });
  await page.click('[data-testid="mm-favorites-toggle"]');

  // ── Browse Hugging Face: mock a search + a repo file listing ────────────────
  await page.click('[data-testid="mm-tab-browse"]');
  await page.waitForSelector('[data-testid="hf-browse"]', { timeout: 8000 });

  // ── Round-10 #20b: TRENDING renders on open + colored pills on HF cards ─────
  // The live on-open trending fetch is skipped under ?piE2E (as with every other
  // HF path), so inject the trending set the loader would produce and assert the
  // "Trending on Hugging Face" header + per-attribute pill hues (gated/vision/audio).
  const trendingHit = {
    id: 'trend-org/Trending-VL-GGUF',
    author: 'trend-org',
    name: 'Trending-VL-GGUF',
    downloads: 999000,
    likes: 4200,
    tags: ['gguf', 'image-text-to-text', 'audio'],
    gated: true,
    pipelineTag: 'image-text-to-text',
    updatedAt: '2026-07-01T00:00:00Z',
  };
  await page.evaluate((hit) => {
    window.__hf_store().setState({ searchStatus: 'done', defaultTrending: true, results: [hit] });
  }, trendingHit);
  await page.waitForSelector('[data-testid="hf-trending-header"]', { timeout: 8000 });
  await page.waitForSelector('[data-pill-kind="gated"]', { timeout: 8000 });
  const trendingPillKinds = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-pill-kind]')).map((el) =>
      el.getAttribute('data-pill-kind'),
    ),
  );
  assert(
    trendingPillKinds.includes('vision'),
    `expected a vision pill on the trending card, got ${trendingPillKinds}`,
  );
  assert(
    trendingPillKinds.includes('audio'),
    `expected an audio pill on the trending card, got ${trendingPillKinds}`,
  );
  assert(
    trendingPillKinds.includes('gated'),
    `expected a gated pill on the trending card, got ${trendingPillKinds}`,
  );

  const hfHit = {
    id: 'probe-org/Probe-Model-GGUF',
    author: 'probe-org',
    name: 'Probe-Model-GGUF',
    downloads: 123456,
    likes: 789,
    tags: ['gguf', 'text-generation'],
    gated: false,
    pipelineTag: 'text-generation',
    updatedAt: '2026-01-01T00:00:00Z',
  };
  // Inject search results (mocks the hf:search IPC at the store boundary — the
  // same technique the download-progress path above uses, no live network).
  await page.evaluate((hit) => {
    window.__hf_store().setState({ searchStatus: 'done', defaultTrending: false, results: [hit] });
  }, hfHit);
  await page.waitForSelector('[data-testid="hf-results"]', { timeout: 8000 });
  const resultCards = await page.locator('[data-testid^="hf-result-"]').count();
  assert(resultCards === 1, `expected 1 HF result card, got ${resultCards}`);
  const resultText = await page
    .locator('[data-testid="hf-result-probe-org/Probe-Model-GGUF"]')
    .innerText();
  assert(resultText.includes('probe-org'), `expected author in result, got: ${resultText}`);

  // Selecting a repo → its GGUF quant list (mock the hf:list-files IPC too).
  await page.evaluate((hit) => {
    window.__hf_store().setState({
      selected: hit,
      filesStatus: 'done',
      files: [
        {
          path: 'Probe-Q4_K_M.gguf',
          sizeBytes: 4e9,
          quant: 'Q4_K_M',
          mmproj: false,
          mtp: false,
          minRamGB: 6,
        },
        {
          path: 'Probe-Q6_K.gguf',
          sizeBytes: 6e9,
          quant: 'Q6_K',
          mmproj: false,
          mtp: false,
          minRamGB: 8,
        },
      ],
    });
  }, hfHit);
  await page.waitForSelector('[data-testid="hf-quant-probe-org/Probe-Model-GGUF-Q4_K_M"]', {
    timeout: 8000,
  });
  const quantRows = await page
    .locator('[data-testid^="hf-quant-probe-org/Probe-Model-GGUF-"]')
    .count();
  assert(quantRows === 2, `expected 2 quant rows, got ${quantRows}`);

  // Favoriting an HF result persists by its repo id.
  await page.click('[data-testid="favorite-probe-org/Probe-Model-GGUF"]');
  await page.waitForFunction(
    () =>
      window
        .__settings_store()
        .getState()
        .settings.favoriteModels.includes('probe-org/Probe-Model-GGUF'),
    undefined,
    { timeout: 8000 },
  );

  // ── Composer model-chip deep-link into the manager ──────────────────────────
  // Back to chat (from the Browse tab of the manager).
  await page.click('[data-testid="settings-back"]');
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 8000 });
  // "More models" in the footer is now a POWER-mode affordance (user mode — the
  // default — shows just Auto + the 3 tiers, no manager push). Switch to power
  // mode via the profile dropup, then the footer → manager deep-link appears.
  await page.click('[data-testid="profile-button"]');
  await page.waitForSelector('[data-testid="profile-menu"]', { timeout: 8000 });
  await page.click('[data-testid="usermode-toggle"] >> text=Power');
  await page.keyboard.press('Escape');
  // Open the footer model menu → "More models…".
  await page.click('[data-testid="footer-model-chip"]');
  await page.waitForSelector('[data-testid="footer-open-manager"]', { timeout: 8000 });
  await page.click('[data-testid="footer-open-manager"]');
  await page.waitForSelector('[data-testid="model-manager"]', { timeout: 8000 });

  console.log(
    `model-manager-probe OK — ${cardCount} de-duplicated cards + RAM badges + recommendation + colored pill tags; ` +
      'Qwen3.6 27B collapsed to ONE card w/ variant+quant dropdowns + DFlash pill + reliable badges; ' +
      'progress→active UI; cancel-download clears the bar; MLX preference toggle + engine badge persist; ' +
      'advanced effort-default + favorite persist; ' +
      'Browse-HF trending-on-open header + capability pills, search→quant-list + HF favorite; ' +
      'footer deep-link verified',
  );
} finally {
  await app.close();
}
