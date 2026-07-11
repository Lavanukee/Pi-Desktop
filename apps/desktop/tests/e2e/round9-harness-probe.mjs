/**
 * Round-9 adversarial E2E — HARNESS SURFACES (failure points #6, #7, #8), driven
 * end-to-end through mock-pi's setStatus / ask_user sentinel channels
 * (fixtures/round9-harness.json):
 *
 *  #8 STATUS CLUSTER + REPAIR: the active task-class chip ("coding"), the live
 *     running timer, and the auto-repair indicator (repairFailures total = 3) all
 *     render; the live plan checklist renders.
 *  #7 SUBAGENT TAB: a spawn wave (harness-subagents status) surfaces a live canvas
 *     subagent tab listing each subagent + its current step; a later status
 *     advances a subagent's status/step in place.
 *  #6 ASK-USER: a MULTI-SELECT and a SLIDER question each round-trip an answer
 *     back to pi via pi:respond-ui (asserted against MOCK_PI_LOG), unblocking the
 *     fixture to finish the plan.
 *
 * Run `pnpm build` first.
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
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
const fixture = path.join(repoRoot, 'packages/engine/tools/mock-pi/fixtures/round9-harness.json');

function assert(condition, message) {
  if (!condition) throw new Error(`round9-harness-probe failed: ${message}`);
}

assert(
  existsSync(path.join(appRoot, 'dist/index.html')) &&
    existsSync(path.join(appRoot, 'dist-electron/main.js')),
  'app is not built — run `pnpm build` first',
);
assert(existsSync(fixture), `fixture not found at ${fixture}`);

const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'));
const mockLog = path.join(mkdtempSync(path.join(tmpdir(), 'pi-e2e-log-')), 'mock-pi.log');
const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${userDataDir}`],
  env: {
    ...process.env,
    PI_BIN: mockPi,
    MOCK_PI_FIXTURE: fixture,
    MOCK_PI_LOG: mockLog,
    PI_E2E: '1',
  },
});

/** Parse the mock-pi log for the ui_response of a given request id. */
function uiResponseValue(id) {
  if (!existsSync(mockLog)) return null;
  for (const line of readFileSync(mockLog, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.kind === 'ui_response' && rec.response?.id === id) return rec.response.value ?? null;
  }
  return null;
}

try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 8000 });
  await page.waitForFunction(() => typeof window.__pi_canvas === 'function', { timeout: 8000 });
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 8000 });

  await page.click('[data-testid="composer-input"]');
  await page.keyboard.type('round9 please');
  await page.keyboard.press('Enter');

  // ── #8 STATUS CLUSTER + REPAIR ───────────────────────────────────────────────
  // (round-15: the center composer-bar tier control was removed.) Wait for the
  // harness to publish its status, then assert it carries the "coding" active
  // class (read from the store — robust vs a tooltip).
  await page.waitForFunction(
    () => {
      const raw = window.__pi_store().getState().extensionStatus.harness;
      if (raw === undefined || raw.length === 0) return false;
      try {
        return /coding/i.test(JSON.parse(raw).activeClass ?? '');
      } catch {
        return false;
      }
    },
    undefined,
    { timeout: 10000 },
  );
  const clsRaw = await page.evaluate(
    () => window.__pi_store().getState().extensionStatus.harness ?? '{}',
  );
  assert(
    /coding/i.test(JSON.parse(clsRaw).activeClass ?? ''),
    `harness status active class should be "coding", got ${clsRaw}`,
  );
  await page.locator('[data-testid="harness-timer"]').waitFor({ timeout: 8000 });
  await page.locator('[data-testid="harness-repairs"]').waitFor({ timeout: 8000 });
  const repairs = (await page.locator('[data-testid="harness-repairs"]').innerText()).trim();
  assert(
    /3/.test(repairs),
    `repair indicator should total 3 (bash:2 + write:1), got ${JSON.stringify(repairs)}`,
  );
  // The live plan checklist renders its steps.
  const checklist = page.locator('[data-testid="harness-checklist"]');
  await checklist.waitFor({ state: 'visible', timeout: 8000 });
  for (const step of ['Read the module', 'Apply the change', 'Run the tests']) {
    await checklist.locator(`text=${step}`).first().waitFor({ timeout: 8000 });
  }

  // ── #7 SUBAGENT TAB ──────────────────────────────────────────────────────────
  await page.waitForSelector('[data-testid="canvas-tabs-panel"] .pd-subagent-row', {
    timeout: 10000,
  });
  await page.waitForFunction(
    () => {
      const rows = [
        ...document.querySelectorAll('[data-testid="canvas-tabs-panel"] .pd-subagent-row'),
      ];
      const running = rows.find((r) => r.getAttribute('data-status') === 'running');
      const queued = rows.find((r) => r.getAttribute('data-status') === 'queued');
      return (
        running !== undefined &&
        (running.querySelector('.pd-subagent-name')?.textContent ?? '').includes('Research') &&
        (running.querySelector('.pd-subagent-step')?.textContent ?? '').includes('Reading files') &&
        queued !== undefined &&
        (queued.querySelector('.pd-subagent-name')?.textContent ?? '').includes('Tests')
      );
    },
    undefined,
    { timeout: 8000 },
  );

  // ── #6a ASK-USER MULTI-SELECT ────────────────────────────────────────────────
  const card = page.locator('[data-testid="question-card"]');
  await card.waitFor({ state: 'visible', timeout: 10000 });
  await card.locator('text=Pick the areas to refactor').first().waitFor({ timeout: 8000 });
  await card.locator('[role="option"]', { hasText: 'API layer' }).click();
  await card.locator('[role="option"]', { hasText: 'Database' }).click();
  await card.locator('button', { hasText: 'Submit' }).click();
  await card.waitFor({ state: 'detached', timeout: 8000 });

  // The subagent list advances in place after the multi answer (live refresh).
  await page.waitForFunction(
    () => {
      const rows = [
        ...document.querySelectorAll('[data-testid="canvas-tabs-panel"] .pd-subagent-row'),
      ];
      const done = rows.find((r) => r.getAttribute('data-status') === 'done');
      return (
        done !== undefined &&
        (done.querySelector('.pd-subagent-name')?.textContent ?? '').includes('Research')
      );
    },
    undefined,
    { timeout: 8000 },
  );

  // ── #6b ASK-USER SLIDER ──────────────────────────────────────────────────────
  await page.waitForSelector('[data-testid="question-card"] input[type="range"]', {
    timeout: 10000,
  });
  const slider = page.locator('[data-testid="question-card"] input[type="range"]');
  await slider.evaluate((el, val) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, String(val));
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, 40);
  await page
    .locator('[data-testid="question-card"] .pd-question-value')
    .filter({ hasText: '40' })
    .waitFor({ timeout: 6000 });
  await page.locator('[data-testid="question-card"] button', { hasText: 'Submit' }).click();
  await page.locator('[data-testid="question-card"]').waitFor({ state: 'detached', timeout: 8000 });

  // The plan finishes once both questions are answered.
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

  // ── Answers round-tripped to pi (asserted against the mock-pi log) ───────────
  const multiVal = uiResponseValue('ask-multi-1');
  assert(multiVal !== null, 'no ui_response recorded for the multi question');
  const multiParsed = JSON.parse(multiVal);
  assert(
    multiParsed.mode === 'choice' &&
      Array.isArray(multiParsed.values) &&
      multiParsed.values.includes('api') &&
      multiParsed.values.includes('db'),
    `multi answer should carry the selected values [api, db], got ${multiVal}`,
  );
  const sliderVal = uiResponseValue('ask-slider-1');
  assert(sliderVal !== null, 'no ui_response recorded for the slider question');
  const sliderParsed = JSON.parse(sliderVal);
  assert(
    sliderParsed.mode === 'slider' && sliderParsed.value === 40,
    `slider answer should be 40, got ${sliderVal}`,
  );

  console.log(
    'round9-harness-probe OK — status cluster showed class "coding" + live timer + repair indicator (3) + plan checklist; a subagent wave opened a live canvas subagent tab (Research running / Tests queued) and advanced in place; a multi-select answer [api,db] and a slider answer (40) round-tripped to pi and finished the plan',
  );
} finally {
  await app.close();
}
