/**
 * Round-9 adversarial E2E — CANVAS LIVE-SURFACE TAB SWITCH (bug catcher).
 *
 * Opening a SECOND terminal tab must show the SECOND terminal's content, not the
 * first's. This exercises switching between two same-kind live (native) surfaces.
 *
 * KNOWN APP BUG (this probe currently FAILS): the canvas tabpanel renders the
 * active surface WITHOUT a per-tab React key (packages/canvas/src/tabs/
 * canvas-tabs.tsx — `<DefaultSurface tab={activeTab} …>` is not keyed by
 * activeTab.id). React therefore reuses the surface instance across active-tab
 * changes, and the `useContentSlot` callback ref (packages/canvas/src/surfaces/
 * content-slot.ts) never re-fires `onMount`, so the previously-mounted xterm
 * (or WebContentsView) stays in the slot. Result: terminal B (and browser tabs)
 * display terminal A's content. Run `pnpm build` first.
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
  if (!condition) throw new Error(`round9-canvas-tab-switch-probe failed: ${message}`);
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

const rowsText = (page) =>
  page.evaluate(
    () =>
      document.querySelector('[data-testid="canvas-tabs-panel"] .pd-terminal .xterm-rows')
        ?.textContent ?? '',
  );

try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__pi_canvas === 'function', { timeout: 8000 });
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 8000 });

  // Terminal A: run a command that leaves a distinctive marker.
  await page.evaluate(() =>
    window.__pi_canvas().openTab({ kind: 'terminal', key: 'termA', title: 'A' }),
  );
  await page.waitForSelector(`${PANEL} .pd-terminal .xterm-rows`, { timeout: 10000 });
  await page.keyboard.type('echo AAA_MARKER');
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () =>
      (
        document.querySelector('[data-testid="canvas-tabs-panel"] .pd-terminal .xterm-rows')
          ?.textContent ?? ''
      ).includes('AAA_MARKER'),
    undefined,
    { timeout: 12000 },
  );

  // Terminal B: a fresh terminal, now active. Its slot must NOT show A's marker.
  await page.evaluate(() =>
    window.__pi_canvas().openTab({ kind: 'terminal', key: 'termB', title: 'B' }),
  );
  await page.waitForFunction(
    () =>
      window
        .__pi_canvas()
        .getState()
        .tabs.find((t) => t.id === window.__pi_canvas().getState().activeTabId)?.key === 'termB',
    undefined,
    { timeout: 8000 },
  );
  await page.waitForTimeout(1000);
  const bText = await rowsText(page);
  assert(
    !bText.includes('AAA_MARKER'),
    `terminal B's surface is showing terminal A's content ("AAA_MARKER") — switching between live-surface tabs does not swap the mounted view. APP BUG: the canvas tabpanel does not key the active surface by tab id, so React reuses the surface instance and useContentSlot never re-mounts. Suspected: packages/canvas/src/tabs/canvas-tabs.tsx (DefaultSurface not keyed by activeTab.id) + packages/canvas/src/surfaces/content-slot.ts.`,
  );

  console.log(
    "round9-canvas-tab-switch-probe OK — a second terminal tab showed its own surface, not the first terminal's content",
  );
} finally {
  await app.close();
}
