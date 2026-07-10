/**
 * Task-list + ask-user E2E (round-9 W3): launches the built app against mock-pi
 * with the harness-tasklist fixture, sends a prompt, and asserts:
 *
 *  - the live TaskChecklist renders from the harness `plan` status and advances
 *    pending → in_progress → done as the fixture republishes it,
 *  - the always-visible harness status cluster shows the active class + timer,
 *  - the `ask_user` rich question renders through the QuestionCard (decoded from
 *    the sentinel-tagged `input` request) and its answer round-trips via
 *    pi:respond-ui, unblocking the fixture to finish the plan.
 *
 * Run `pnpm build` first (needs dist/ + dist-electron/). Paired with the unit
 * coverage in packages/harness (plan/ask tools) and packages/engine (router
 * decode). The preset picker → active-class flow is covered by the AgentPanel
 * wiring + applyHarnessPreset unit path, not this mock-pi run (mock-pi acks
 * slash commands without re-emitting status).
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
const fixture = path.join(repoRoot, 'packages/engine/tools/mock-pi/fixtures/harness-tasklist.json');

function assert(condition, message) {
  if (!condition) throw new Error(`tasklist-probe failed: ${message}`);
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

/** Read + parse the published harness status from the renderer store. */
async function harnessStatus(page) {
  return page.evaluate(() => {
    const raw = window.__pi_store().getState().extensionStatus.harness;
    return raw !== undefined ? JSON.parse(raw) : null;
  });
}

try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 8000 });
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 8000 });

  await page.click('[data-testid="composer-input"]');
  await page.keyboard.type('make a plan');
  await page.keyboard.press('Enter');

  // The live checklist panel renders with the three plan steps.
  const checklist = page.locator('[data-testid="harness-checklist"]');
  await checklist.waitFor({ state: 'visible', timeout: 10000 });
  for (const step of ['Read the module', 'Apply the change', 'Run the tests']) {
    await checklist.locator(`text=${step}`).first().waitFor({ timeout: 8000 });
  }

  // The always-visible status cluster surfaces the active class + running timer.
  // Active class moved to the composer-bar tier display (class in its hover);
  // verify the tier display renders + the harness status carries "coding".
  await page.locator('[data-testid="composer-tier"]').waitFor({ timeout: 8000 });
  const clsStatus = await harnessStatus(page);
  assert(
    clsStatus !== null && /coding/i.test(clsStatus.activeClass ?? ''),
    `expected active class "coding", got ${JSON.stringify(clsStatus?.activeClass)}`,
  );
  await page.locator('[data-testid="harness-timer"]').waitFor({ timeout: 8000 });

  // The fixture blocks on ask_user mid-plan → the plan is not yet all done, and
  // at least one item has advanced to in_progress/done. This is the live update.
  const midPlan = await harnessStatus(page);
  assert(midPlan !== null && Array.isArray(midPlan.plan), 'no plan in the harness status');
  assert(
    midPlan.plan.some((p) => p.status !== 'pending'),
    'expected the checklist to have advanced past all-pending',
  );
  assert(
    midPlan.plan.some((p) => p.status !== 'done'),
    'expected the plan to still be in progress while ask_user blocks',
  );

  // The ask_user question renders through the QuestionCard (rich decode of the
  // sentinel input), NOT a plain input box.
  const card = page.locator('[data-testid="question-card"]');
  await card.waitFor({ state: 'visible', timeout: 10000 });
  await card.locator('text=Which approach should I take?').first().waitFor({ timeout: 8000 });
  // Pick an option and submit; the answer round-trips via pi:respond-ui.
  await card.locator('[role="option"]', { hasText: 'Refactor in place' }).click();
  await card.locator('button', { hasText: 'Submit' }).click();

  // Answering unblocks the fixture: the plan finishes (all done) and the dialog
  // closes.
  await card.waitFor({ state: 'detached', timeout: 8000 });
  await page.waitForFunction(
    () => {
      const raw = window.__pi_store().getState().extensionStatus.harness;
      if (raw === undefined) return false;
      const plan = JSON.parse(raw).plan ?? [];
      return plan.length > 0 && plan.every((p) => p.status === 'done');
    },
    undefined,
    { timeout: 10000 },
  );

  // The checklist reflects the completion (a done marker is present).
  await checklist.locator('.pd-task-item--done').first().waitFor({ timeout: 8000 });

  console.log('tasklist-probe: PASS');
} finally {
  await app.close();
}
