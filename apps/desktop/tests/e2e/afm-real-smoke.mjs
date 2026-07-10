/**
 * Real Apple Foundation Models smoke (env-guarded — skips cleanly when the
 * on-device model isn't available, so CI is unaffected). Drives the FULL
 * on-device stack end-to-end through the built app: afm:check gates, afm:set-active
 * writes pi's models.json, pi restarts to pick it up, then a real prompt streams
 * through pi → provider-afm (afm-stream) → streamAfm → the pi-afm Swift helper →
 * the on-device model, landing in the renderer thread. Reports observed text.
 *
 * Uses an isolated HOME so pi reads/writes a throwaway ~/.pi (the app's afm:set-active
 * writes models.json under the same HOME). Run `pnpm build` first, then
 * `node tests/e2e/afm-real-smoke.mjs`.
 */
import { execFileSync } from 'node:child_process';
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
const helper = path.join(repoRoot, 'packages/afm/swift/.build/release/pi-afm');

if (!existsSync(path.join(appRoot, 'dist/index.html'))) {
  console.error('afm-real-smoke: app not built — run `pnpm build` first');
  process.exit(1);
}
if (!existsSync(helper)) {
  console.log(`afm-real-smoke: SKIP — pi-afm helper not built at ${helper}`);
  process.exit(0);
}
// Gate on real availability so non-Apple-Intelligence machines skip cleanly.
try {
  const out = execFileSync(helper, ['--check'], { encoding: 'utf8' });
  const parsed = JSON.parse(out.trim().split('\n').at(-1));
  if (parsed.available !== true) {
    console.log(`afm-real-smoke: SKIP — on-device model unavailable (${parsed.reason})`);
    process.exit(0);
  }
} catch (err) {
  console.log(`afm-real-smoke: SKIP — helper --check failed: ${err}`);
  process.exit(0);
}

const home = mkdtempSync(path.join(tmpdir(), 'pi-afm-home-'));
const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-afm-udd-'));
const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${userDataDir}`],
  // Real pi (no PI_BIN) + the store hook. Isolated HOME → throwaway ~/.pi.
  env: { ...process.env, HOME: home, PI_E2E: '1' },
});

function fail(message) {
  throw new Error(`afm-real-smoke failed: ${message}`);
}

try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 15000 });
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 15000 });

  // 1. Availability gate must report the on-device model as usable.
  const availability = await page.evaluate(() => window.piDesktop.invoke('afm:check', undefined));
  console.log('afm:check →', JSON.stringify(availability));
  if (availability.available !== true) fail(`afm:check not available: ${availability.reason}`);

  // 2. Open the Model Manager (Settings row of the bottom-left profile dropup).
  await page.click('[data-testid="profile-button"]');
  await page.waitForSelector('[data-testid="profile-menu"]', { timeout: 8000 });
  await page.click('[data-testid="open-settings"]');
  await page.waitForSelector('[data-testid="settings-view"]', { timeout: 8000 });
  await page.click('[data-testid="settings-nav-models"]');
  await page.waitForSelector('[data-testid="afm-model-card"]', { timeout: 8000 });
  const cardText = await page.locator('[data-testid="afm-model-card"]').innerText();
  if (!cardText.includes('On-device')) fail(`afm card missing on-device badge: ${cardText}`);
  console.log('Model Manager shows the AFM entry');

  // 3. Click "Set active" — drives the REAL UI flow (afm:set-active → models.json,
  // pi restart, set-model) and waits for pi's active model to become afm.
  await page.click('[data-testid="afm-set-active"]');
  await page.waitForSelector('[data-testid="afm-active-badge"]', { timeout: 30000 });
  await page.click('[data-testid="settings-back"]');
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 8000 });

  // Routing proof: the afm model binds to the custom `afm-stream` api, handled
  // ONLY by provider-afm's streamSimple. Its presence means pi loaded our `-e`
  // extension (not an extension-free self-heal respawn).
  const models = await page.evaluate(() => window.piDesktop.invoke('pi:get-models', undefined));
  const target = models.models.find((m) => m.provider === 'afm');
  if (target === undefined) fail(`no afm model after set-active: ${JSON.stringify(models)}`);
  console.log('pi model:', target.provider, target.id, '(api:', target.api, ')');
  if (target.api !== 'afm-stream') {
    fail(`model api is "${target.api}", expected "afm-stream" — not routing through provider-afm`);
  }

  // 4. Drive a real prompt and wait for streamed text in the thread.
  const t0 = Date.now();
  const ack = await page.evaluate(() =>
    window.piDesktop.invoke('pi:prompt', { message: 'Say hi in one short sentence.' }),
  );
  if (!ack.success) fail(`prompt: ${ack.error}`);

  await page.waitForFunction(
    () => {
      const { messages, agent } = window.__pi_store().getState();
      const assistant = [...messages].reverse().find((m) => m.kind === 'assistant');
      const text = assistant?.blocks
        ?.filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
      return !agent.isStreaming && typeof text === 'string' && text.length > 0;
    },
    { timeout: 120000 },
  );
  const elapsedMs = Date.now() - t0;

  const result = await page.evaluate(() => {
    const { messages } = window.__pi_store().getState();
    const assistant = [...messages].reverse().find((m) => m.kind === 'assistant');
    return {
      text: assistant?.blocks
        ?.filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join(''),
      model: assistant?.model,
      stopReason: assistant?.stopReason,
    };
  });
  // Footer chip label: pi's agent.model.name from the afm block.
  const chip = await page.evaluate(() => window.__pi_store().getState().agent.model);

  console.log('\n=== afm real smoke result ===');
  console.log('assistant text:', JSON.stringify(result.text));
  console.log('model:', result.model, '| stopReason:', result.stopReason);
  console.log('footer model chip:', JSON.stringify(chip));
  console.log('elapsed ms:', elapsedMs);

  if (typeof result.text !== 'string' || result.text.length === 0) {
    fail('no streamed text from the on-device model');
  }
  if (chip?.name !== 'Apple Intelligence') {
    fail(`footer chip is "${chip?.name}", expected "Apple Intelligence"`);
  }
  console.log('afm-real-smoke OK — on-device model streamed a live response via provider-afm');
} finally {
  await app.close();
}
