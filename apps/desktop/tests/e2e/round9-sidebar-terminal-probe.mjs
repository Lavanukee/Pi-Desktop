/**
 * Round-9 adversarial E2E — SIDEBAR + TERMINAL FOCUS + RESULTS (failure point #5).
 *
 *  A. Open the canvas + a TERMINAL tab: xterm mounts, the terminal is FOCUSED
 *     (its helper textarea is the active element), and an interactive command
 *     round-trips its OUTPUT (`echo hi=$((6*7))` → renders "hi=42").
 *  B. SIDEBAR collapse → NARROW ICON RAIL (~64px, icons kept) → expand round-trip.
 *
 * Tool-call output in a terminal is covered by round9-terminal-mirror-probe.mjs
 * (a single mirror terminal); switching between two terminals is covered by
 * round9-canvas-tab-switch-probe.mjs. Run `pnpm build` first.
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
  if (!condition) throw new Error(`round9-sidebar-terminal-probe failed: ${message}`);
}

assert(
  existsSync(path.join(appRoot, 'dist/index.html')) &&
    existsSync(path.join(appRoot, 'dist-electron/main.js')),
  'app is not built — run `pnpm build` first',
);

const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'));
const PANEL = '[data-testid="canvas-tabs-panel"]';
const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${userDataDir}`],
  env: { ...process.env, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});

try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__pi_canvas === 'function', { timeout: 8000 });
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 8000 });

  // ── A. Open the canvas + a terminal tab → focus + interactive output ─────────
  await page.evaluate(() => window.__pi_canvas().openTab({ kind: 'terminal', title: 'Terminal' }));
  await page.waitForSelector(`${PANEL}`, { timeout: 8000 });
  await page.waitForSelector(`${PANEL} .pd-terminal .xterm-rows`, { timeout: 10000 });

  // The terminal takes focus on mount (its helper textarea is the active element).
  await page.waitForFunction(
    () => {
      const ae = document.activeElement;
      return ae?.classList?.contains('xterm-helper-textarea') === true;
    },
    undefined,
    { timeout: 8000 },
  );

  // The command's own text contains $((6*7)); the rendered token hi=42 can only
  // come from the shell executing → proves the terminal shows real output.
  await page.keyboard.type('echo hi=$((6*7))');
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    (token) =>
      (
        document.querySelector('[data-testid="canvas-tabs-panel"] .pd-terminal .xterm-rows')
          ?.textContent ?? ''
      ).includes(token),
    'hi=42',
    { timeout: 12000 },
  );

  // ── B. Sidebar collapse → icon rail → expand round-trip ──────────────────────
  await page.waitForSelector('[data-testid="collapse-sidebar"]', { timeout: 8000 });
  await page.click('[data-testid="collapse-sidebar"]');
  await page.waitForSelector('[data-testid="expand-sidebar"]', { timeout: 8000 });
  await page.waitForFunction(
    () => {
      const el = document.querySelector('.pd-sidebar-slot');
      const w = el ? el.getBoundingClientRect().width : 999;
      return w > 40 && w < 130;
    },
    undefined,
    { timeout: 4000 },
  );
  const railW = await page.evaluate(
    () => document.querySelector('.pd-sidebar-slot')?.getBoundingClientRect().width ?? 0,
  );
  assert(
    railW > 40 && railW < 130,
    `collapsed sidebar should be a ~64px icon rail, got ${railW}px`,
  );
  assert(
    (await page.locator('[data-testid="new-chat"]').count()) >= 1,
    'the icon rail should keep its nav icons (New chat)',
  );
  await page.click('[data-testid="expand-sidebar"]');
  await page.waitForSelector('[data-testid="sidebar-search"]', { timeout: 8000 });
  // Wait for the width transition to settle back to the full sidebar.
  await page.waitForFunction(
    () => (document.querySelector('.pd-sidebar-slot')?.getBoundingClientRect().width ?? 0) > 180,
    undefined,
    { timeout: 4000 },
  );

  console.log(
    'round9-sidebar-terminal-probe OK — terminal tab mounted + FOCUSED and executed a command (rendered "hi=42"); sidebar collapsed to a ~64px icon rail and expanded back',
  );
} finally {
  await app.close();
}
