/**
 * Subagent "view work" E2E (UI#12). Drives the harness-subagents status channel
 * to open the subagent surface, clicks a subagent row, and asserts a per-subagent
 * "work" tab opens showing its activity timeline + full output. Run `pnpm build`
 * first. Exit 0 on success, non-zero on any failed assertion.
 */

import { mkdtempSync } from 'node:fs';
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
  if (!condition) throw new Error(`subagent-view-probe failed: ${message}`);
}

const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'))}`],
  env: { ...process.env, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});

const OUTPUT = 'Found 3 issues in the auth flow.';

try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 8000 });
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 8000 });

  // Publish a RUNNING subagent over the harness-subagents status channel — the
  // routing opens the subagent surface on the rising edge of activity.
  await page.evaluate(() => {
    const payload = {
      subagents: [{ id: 's1', name: 'Researcher', status: 'running', step: 'read' }],
    };
    window
      .__pi_store()
      .setState({ extensionStatus: { 'harness-subagents': JSON.stringify(payload) } });
  });
  await page
    .locator('[data-testid="canvas-tabs-panel"]')
    .waitFor({ state: 'visible', timeout: 8000 });
  await page.waitForSelector('[data-testid="canvas-tabs-panel"] .pd-subagent-row', {
    timeout: 8000,
  });

  // Finish it with an activity timeline + full output (quiet refresh in place).
  await page.evaluate((output) => {
    const payload = {
      subagents: [
        {
          id: 's1',
          name: 'Researcher',
          status: 'done',
          step: 'Done',
          activity: ['bash', 'read', 'edit'],
          output,
        },
      ],
    };
    window
      .__pi_store()
      .setState({ extensionStatus: { 'harness-subagents': JSON.stringify(payload) } });
  }, OUTPUT);

  // Click the subagent row → opens its "work" tab.
  await page.click('[data-testid="canvas-tabs-panel"] .pd-subagent-row');

  // The work tab renders the output + a Steps section via the markdown surface.
  await page.waitForFunction(
    (output) => {
      const text = document.querySelector('[data-testid="canvas-tabs-panel"]')?.textContent ?? '';
      return text.includes(output) && text.includes('Steps');
    },
    OUTPUT,
    { timeout: 8000 },
  );

  // A dedicated "Researcher" work tab now exists in the tab bar.
  const tabTitles = await page.$$eval('[data-testid="canvas-tabs-panel"] .pd-canvas-tab', (els) =>
    els.map((e) => e.textContent ?? ''),
  );
  assert(
    tabTitles.some((t) => t.includes('Researcher')),
    `expected a "Researcher" work tab, got ${JSON.stringify(tabTitles)}`,
  );

  console.log(
    'subagent-view-probe OK — clicking a subagent opened its work tab (activity + output).',
  );
} finally {
  await app.close();
}
