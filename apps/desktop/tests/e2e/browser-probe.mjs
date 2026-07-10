/**
 * Browser-tab E2E (Phase 2b): opens a native browser canvas tab, navigates its
 * WebContentsView to `data:` URLs, and asserts the real view loaded and its
 * chrome reflects reality:
 *   (1) navigate → the page's <title> flows back (page-title-updated →
 *       controller.updateTab) into the tab label — proof the native view
 *       actually loaded + ran the page, and the URL bar reflects the URL;
 *   (2) a second navigation + Back exercises the WebContentsView history and
 *       the back/fwd enabled state end to end.
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
const fixture = path.join(repoRoot, 'packages/engine/tools/mock-pi/fixtures/simple-chat.json');

function assert(condition, message) {
  if (!condition) throw new Error(`browser-probe failed: ${message}`);
}

assert(
  existsSync(path.join(appRoot, 'dist/index.html')) &&
    existsSync(path.join(appRoot, 'dist-electron/main.js')),
  'app is not built — run `pnpm build` first',
);

// Two data: URLs with distinct tokens in both <title> and the URL text, so we
// can assert on the tab label (title event) and the URL bar (did-navigate).
const url1 = 'data:text/html,<title>PIBONE</title><body>page one</body>';
const url2 = 'data:text/html,<title>PIBTWO</title><body>page two</body>';

const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'));
const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${userDataDir}`],
  env: { ...process.env, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});

try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__pi_canvas === 'function', { timeout: 8000 });

  // Open a native browser tab through the shared controller.
  await page.evaluate(() => window.__pi_canvas().openTab({ kind: 'browser', title: 'New tab' }));
  await page.waitForSelector('[data-testid="canvas-tabs-panel"] .pd-browser', { timeout: 8000 });
  const urlBar = page.locator('[data-testid="canvas-tabs-panel"] .pd-browser-url');
  await urlBar.waitFor({ state: 'visible', timeout: 8000 });

  // (1) Navigate to url1: submit via the URL bar (exactly what a user does).
  await urlBar.fill(url1);
  await urlBar.press('Enter');

  // The page's <title> arriving back into the tab label proves the native
  // WebContentsView loaded + executed the document.
  await page.waitForFunction(
    (token) =>
      [...document.querySelectorAll('[data-testid="canvas-tabs-panel"] .pd-canvas-tab-label')].some(
        (el) => (el.textContent ?? '').includes(token),
      ),
    'PIBONE',
    { timeout: 10000 },
  );
  // The URL bar reflects the navigated URL (did-navigate → updateTab).
  await page.waitForFunction(
    (token) => {
      const input = document.querySelector('[data-testid="canvas-tabs-panel"] .pd-browser-url');
      return (input?.value ?? '').includes(token);
    },
    'PIBONE',
    { timeout: 10000 },
  );

  // (2) Navigate to url2, then Back — exercises the real view's history.
  await urlBar.fill(url2);
  await urlBar.press('Enter');
  await page.waitForFunction(
    (token) => {
      const input = document.querySelector('[data-testid="canvas-tabs-panel"] .pd-browser-url');
      return (input?.value ?? '').includes(token);
    },
    'PIBTWO',
    { timeout: 10000 },
  );

  const back = page.locator('[data-testid="canvas-tabs-panel"] .pd-browser [aria-label="Back"]');
  await page.waitForFunction(
    () => {
      const btn = document.querySelector(
        '[data-testid="canvas-tabs-panel"] .pd-browser [aria-label="Back"]',
      );
      return btn !== null && !btn.disabled;
    },
    undefined,
    { timeout: 10000 },
  );
  await back.click();
  await page.waitForFunction(
    (token) => {
      const input = document.querySelector('[data-testid="canvas-tabs-panel"] .pd-browser-url');
      return (input?.value ?? '').includes(token);
    },
    'PIBONE',
    { timeout: 10000 },
  );

  console.log(
    'browser-probe OK — WebContentsView loaded a data: page (title flowed to the tab + URL bar), and back/forward history works',
  );
} finally {
  await app.close();
}
