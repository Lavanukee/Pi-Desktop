/**
 * Message-branch switching E2E (round-3 #P3 follow-up): launches the built app
 * against mock-pi's fork-aware DAG and drives the full edit → fork → switch
 * flow through the real IPC path.
 *
 *   1. Send a prompt; the mock streams the ORIGINAL branch's response.
 *   2. Edit that user message + Save → forks a new pi branch (pi:fork /
 *      pi:get-fork-messages), streaming the EDITED branch's response.
 *   3. A BranchSwitcher shows ‹ 2 / 2 ›; ‹ / › swaps the visible assistant
 *      response between the two branches (snapshot-driven, switch_session-synced).
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
const fixture = path.join(repoRoot, 'packages/engine/tools/mock-pi/fixtures/branch-chat.json');

function assert(condition, message) {
  if (!condition) throw new Error(`branch-switch-probe failed: ${message}`);
}

assert(
  existsSync(path.join(appRoot, 'dist/index.html')) &&
    existsSync(path.join(appRoot, 'dist-electron/main.js')),
  'app is not built — run `pnpm build` first',
);
assert(existsSync(fixture), `branch-chat fixture missing at ${fixture}`);

const ORIGINAL = 'Original branch: counting one, two, three.';
const EDITED = 'Edited branch: counting one, two, three, four, five.';

const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'));
const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${userDataDir}`],
  env: { ...process.env, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});

const branchCount = () =>
  app
    .firstWindow()
    .then((p) => p.locator('[data-testid="branch-switcher"] .pd-branch-count').innerText())
    .then((t) => t.replace(/\s+/g, ' ').trim());

try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 8000 });
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 8000 });

  // 1. Send a prompt → the mock streams the ORIGINAL branch response.
  await page.click('[data-testid="composer-input"]');
  await page.keyboard.type('please count to three');
  await page.keyboard.press('Enter');
  await page.waitForSelector(`text=${ORIGINAL}`, { timeout: 10000 });

  // No switcher yet — a single branch.
  assert(
    (await page.locator('[data-testid="branch-switcher"]').count()) === 0,
    'branch switcher should be absent before any fork',
  );

  // 2. Edit the user message and Save → fork a new branch.
  const userRow = page.locator('.pd-msg--user').first();
  await userRow.hover();
  await page.click('button[aria-label="Edit message"]');
  const editing = page.locator('[data-testid="editing-message"]');
  await editing.waitFor({ state: 'visible', timeout: 4000 });
  await editing.locator('textarea').fill('please count to five');
  await editing.locator('button:has-text("Save")').click();

  // The EDITED branch streams in and becomes the active alternate (‹ 2 / 2 ›).
  await page.waitForSelector(`text=${EDITED}`, { timeout: 10000 });
  await page.waitForSelector('[data-testid="branch-switcher"]', { timeout: 4000 });
  assert(
    (await branchCount()) === '2 / 2',
    `expected "2 / 2" after fork, got "${await branchCount()}"`,
  );
  // Forking trimmed the old turn: the original response is gone from the thread.
  assert(
    (await page.locator(`text=${ORIGINAL}`).count()) === 0,
    'original branch response should be replaced by the forked turn',
  );

  // Store-level: one branch group at ordinal 0 with two branches, active = 1.
  const group = await page.evaluate(() => window.__pi_store().getState().branches[0]);
  assert(
    group !== undefined && group.files.length === 2,
    `expected 2 branches, got ${JSON.stringify(group)}`,
  );
  assert(group.active === 1, `new branch should be active (1), got ${group.active}`);

  // 3a. ‹ Previous → the ORIGINAL branch's response returns.
  await page.click('button[aria-label="Previous version"]');
  await page.waitForSelector(`text=${ORIGINAL}`, { timeout: 6000 });
  assert(
    (await branchCount()) === '1 / 2',
    `expected "1 / 2" after prev, got "${await branchCount()}"`,
  );
  assert(
    (await page.locator(`text=${EDITED}`).count()) === 0,
    'edited branch response should be hidden on branch 1/2',
  );

  // 3b. › Next → back to the EDITED branch's response.
  await page.click('button[aria-label="Next version"]');
  await page.waitForSelector(`text=${EDITED}`, { timeout: 6000 });
  assert(
    (await branchCount()) === '2 / 2',
    `expected "2 / 2" after next, got "${await branchCount()}"`,
  );
  assert(
    (await page.locator(`text=${ORIGINAL}`).count()) === 0,
    'original branch response should be hidden on branch 2/2',
  );

  console.log(
    'branch-switch-probe OK — edit forked a branch (‹2/2›) and ‹/› swaps the visible response',
  );
} finally {
  await app.close();
}
