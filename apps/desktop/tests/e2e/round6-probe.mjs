/**
 * Round-6 E2E: launches the built app against mock-pi and verifies the
 * streaming-aware thought/tool collapse + the round-6 small fixes.
 *
 *  1. STREAMING THOUGHT (the big one): a thinking run is EXPANDED + live while it
 *     streams (chain data-expanded="true", present-tense "Thinking…", the thought
 *     text visible), then COLLAPSES to its "Thought…" summary the moment the
 *     response text begins.
 *  2. THINKING-ONLY TURN (the significant bug): a turn with ONLY thinking renders
 *     through the ActivityChain chrome — a clock-icon "Thought" step on the
 *     connector line + a "Done" terminal — collapsed by default, expandable.
 *  3. SETTINGS GEAR: the sidebar Settings nav uses the proper cog (IconSettings),
 *     not the sun-like glyph (asserted via the long gear-rim path).
 *  4. SETTINGS TRANSITION: opening Settings mounts with the `.pd-settings-enter`
 *     slide/fade class.
 *  5. BACK-TO-CHAT: a real <button> pinned to the BOTTOM-LEFT of the settings nav.
 *
 * Run `pnpm build` first.
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
const fixture = path.join(appRoot, 'tests/e2e/fixtures/thinking-stream.json');

function assert(condition, message) {
  if (!condition) throw new Error(`round6-probe failed: ${message}`);
}

assert(
  existsSync(path.join(appRoot, 'dist/index.html')) &&
    existsSync(path.join(appRoot, 'dist-electron/main.js')),
  'app is not built — run `pnpm build` first',
);
assert(existsSync(mockPi), `mock-pi not found at ${mockPi}`);
assert(existsSync(fixture), `fixture not found at ${fixture}`);

const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'));
const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${userDataDir}`],
  env: { ...process.env, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});

const send = async (page, text) => {
  await page.click('[data-testid="composer-input"]');
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
};
const streamingDone = (page) =>
  page.waitForFunction(
    () => window.__pi_store().getState().agent.isStreaming === false,
    undefined,
    {
      timeout: 12000,
    },
  );

try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 8000 });
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 8000 });

  // ── (3) Settings gear cog — check BEFORE opening settings (sidebar visible) ──
  const gearD = await page.getAttribute('[data-testid="nav-settings"] svg path', 'd');
  assert(
    typeof gearD === 'string' && gearD.length > 150,
    `Settings nav icon is not the gear cog (path d length ${gearD?.length ?? 0})`,
  );

  // ── (1) Streaming thought: expanded + live, then collapse on response text ──
  await send(page, 'reason about the answer');

  // While streaming the chain is FORCE-EXPANDED, reads present tense, and shows
  // the live thought text.
  await page.waitForFunction(
    () => {
      const chain = document.querySelector('[data-testid="activity-chain"]');
      if (chain === null || chain.getAttribute('data-expanded') !== 'true') return false;
      const summary = chain.querySelector('.pd-chain-summary-text')?.textContent ?? '';
      const hasThinkingStep = chain.querySelector('.pd-chain-step[data-kind="thinking"]') !== null;
      return /thinking/i.test(summary) && hasThinkingStep;
    },
    undefined,
    { timeout: 8000 },
  );
  await page.waitForSelector('text=Let me reason about this carefully.', { timeout: 8000 });

  // The response text begins → the chain COLLAPSES to its past-tense summary.
  await page.waitForSelector('text=Here is my answer: 42.', { timeout: 8000 });
  await streamingDone(page);
  await page.waitForFunction(
    () => {
      const chain = document.querySelector('[data-testid="activity-chain"]');
      if (chain === null || chain.getAttribute('data-expanded') !== 'false') return false;
      const summary = chain.querySelector('.pd-chain-summary-text')?.textContent ?? '';
      return /thought/i.test(summary) && !/thinking/i.test(summary);
    },
    undefined,
    { timeout: 8000 },
  );

  // ── (2) Thinking-only turn → ActivityChain chrome (clock/line/Done) ──────────
  await send(page, 'ponder in silence');
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="activity-chain"]').length === 2,
    undefined,
    { timeout: 8000 },
  );
  await streamingDone(page);

  const lastChain = page.locator('[data-testid="activity-chain"]').last();
  // Collapsed by default with a "Thought…" summary (no tools ran).
  await page.waitForFunction(
    () => {
      const chain = document.querySelectorAll('[data-testid="activity-chain"]')[1];
      const summary = chain?.querySelector('.pd-chain-summary-text')?.textContent ?? '';
      return chain?.getAttribute('data-expanded') === 'false' && /thought/i.test(summary);
    },
    undefined,
    { timeout: 8000 },
  );

  // Expand it → the chain chrome is present: a clock-icon thinking step threaded
  // on the connector line (.pd-chain-steps), plus the "Done" terminal row.
  await lastChain.locator('.pd-chain-summary').click();
  await lastChain
    .locator('.pd-chain-step[data-kind="thinking"]')
    .first()
    .waitFor({ timeout: 8000 });
  assert(
    (await lastChain.locator('.pd-chain-steps').count()) === 1,
    'thinking-only chain is missing the connector-line step list',
  );
  const doneRow = lastChain.locator('.pd-chain-done');
  await doneRow.waitFor({ timeout: 8000 });
  assert(
    /done/i.test((await doneRow.innerText()) ?? ''),
    'thinking-only chain is missing the "Done" terminal',
  );
  // The thinking step carries an icon (the clock glyph) on the connector.
  assert(
    (await lastChain
      .locator('.pd-chain-step[data-kind="thinking"] .pd-chain-step-icon svg')
      .count()) >= 1,
    'thinking step is missing its clock icon',
  );

  // ── (4) Settings open transition + (5) bottom-left Back to chat ──────────────
  await page.click('[data-testid="open-settings"]');
  await page.waitForSelector('[data-testid="settings-view"]', { timeout: 8000 });
  const settingsClass = await page.getAttribute('[data-testid="settings-view"]', 'class');
  assert(
    (settingsClass ?? '').includes('pd-settings-enter'),
    'settings view has no open transition (missing pd-settings-enter)',
  );

  const back = page.locator('[data-testid="settings-back"]');
  await back.waitFor({ timeout: 8000 });
  const tag = await back.evaluate((el) => el.tagName);
  assert(tag === 'BUTTON', `Back-to-chat should be a <button>, got <${tag.toLowerCase()}>`);
  const box = await back.boundingBox();
  const vp = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  assert(box !== null, 'Back-to-chat has no bounding box');
  assert(
    box.y > vp.h * 0.5,
    `Back-to-chat should sit in the BOTTOM half (y=${Math.round(box.y)} of ${vp.h})`,
  );
  assert(
    box.x < vp.w * 0.4,
    `Back-to-chat should sit on the LEFT (x=${Math.round(box.x)} of ${vp.w})`,
  );

  // It returns to chat.
  await back.click();
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 8000 });

  console.log(
    'round6-probe OK — streaming thought expanded→collapsed on response; thinking-only turn shows chain chrome (clock/line/Done); settings gear cog + open transition; Back-to-chat is a bottom-left button',
  );
} finally {
  await app.close();
}
