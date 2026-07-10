/**
 * Canvas E2E (THEME 1 + 2 rework): launches the built app (mock-pi) and drives
 * the tabbed multi-surface canvas + inline↔canvas routing end to end:
 *   (a) a LARGE svg artifact auto-routes to a CANVAS TAB (shouldGoToCanvas) —
 *       the tabbed rail opens and renders the live SVG in the active tab;
 *   (b) a SMALL svg stays INLINE as a size-capped widget in the thread, and its
 *       "Move to canvas" button promotes it to a new canvas tab;
 *   (c) A1: an svg authored BETWEEN two text runs renders inline BETWEEN them
 *       (not bunched at the thread foot);
 *   (d) B1: an image tab with a data-URI PNG renders (loaded), not a dead spinner.
 * Exercises CanvasProvider + CanvasTabs mount, artifact detection, upsert-by-key
 * routing, the InlineWidget move affordance, source-position interleaving, and
 * the self-managed media surface. Run `pnpm build` first.
 *
 * NOTE: pop-out is re-wired to the active canvas tab (tab-bar control →
 * `canvas:popout`); the standalone-window round-trip is not exercised here.
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
  if (!condition) throw new Error(`canvas-probe failed: ${message}`);
}

assert(
  existsSync(path.join(appRoot, 'dist/index.html')) &&
    existsSync(path.join(appRoot, 'dist-electron/main.js')),
  'app is not built — run `pnpm build` first',
);

const BIG = 'PI-CANVAS-BIG';
const SMALL = 'PI-CANVAS-SMALL';
// A padded SVG whose source exceeds the inline char budget (2000) → routes to
// the canvas. The marker text stays renderable.
const bigPad = '<rect x="0" y="0" width="1" height="1" fill="#000"/>'.repeat(60);
const bigSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><circle cx="60" cy="60" r="48" fill="#ff6347"/>${bigPad}<text x="60" y="66" font-size="11" text-anchor="middle" fill="#fff">${BIG}</text></svg>`;
const smallSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><circle cx="60" cy="60" r="48" fill="#4a90d9"/><text x="60" y="66" font-size="11" text-anchor="middle" fill="#fff">${SMALL}</text></svg>`;

const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'));
const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${userDataDir}`],
  env: { ...process.env, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});

const injectSvg = (page, id, svg) =>
  page.evaluate(
    ({ id, svg }) => {
      window.__pi_store().setState({
        messages: [
          {
            kind: 'assistant',
            id,
            blocks: [{ type: 'text', text: `Here is a drawing:\n\n\`\`\`svg\n${svg}\n\`\`\`` }],
            timestamp: Date.now(),
            isStreaming: false,
          },
        ],
      });
    },
    { id, svg },
  );

try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 8000 });
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 8000 });

  // (a) A big svg artifact auto-opens the TABBED canvas and renders in a tab.
  await injectSvg(page, 'canvas-probe-big', bigSvg);
  const panel = page.locator('[data-testid="canvas-tabs-panel"]');
  await panel.waitFor({ state: 'visible', timeout: 8000 });
  await page.waitForSelector('[data-testid="canvas-tabs-panel"] .pd-canvas-tabs', {
    timeout: 8000,
  });
  await page.waitForFunction(
    (marker) => {
      const el = document.querySelector('[data-testid="canvas-tabs-panel"] .pd-canvas-svg');
      return el?.querySelector('svg') !== null && (el?.textContent ?? '').includes(marker);
    },
    BIG,
    { timeout: 8000 },
  );
  assert(
    (await page.locator('[data-testid="canvas-tabs-panel"] .pd-canvas-tab').count()) >= 1,
    'expected at least one canvas tab in the tab bar',
  );

  // (b) A small svg stays INLINE as a size-capped widget in the thread.
  await injectSvg(page, 'canvas-probe-small', smallSvg);
  const widget = page.locator('[data-testid="inline-artifacts"] .pd-inline-widget');
  await widget.waitFor({ state: 'visible', timeout: 8000 });
  await page.waitForFunction(
    (marker) => {
      const el = document.querySelector('[data-testid="inline-artifacts"] .pd-canvas-svg');
      return el?.querySelector('svg') !== null && (el?.textContent ?? '').includes(marker);
    },
    SMALL,
    { timeout: 8000 },
  );

  // Its "Move to canvas" button promotes it to a NEW canvas tab; the inline
  // widget then drops out of the thread (the tab now owns it).
  await widget.locator('button[aria-label="Move to canvas"]').click();
  await page.waitForFunction(
    (marker) => {
      const el = document.querySelector('[data-testid="canvas-tabs-panel"] .pd-canvas-tabpanel');
      return (el?.textContent ?? '').includes(marker);
    },
    SMALL,
    { timeout: 8000 },
  );
  await page.waitForFunction(
    () => document.querySelector('[data-testid="inline-artifacts"]') === null,
    undefined,
    { timeout: 8000 },
  );

  // (c) A1: an svg authored BETWEEN two text runs renders inline BETWEEN them.
  const BEFORE = 'PI-INLINE-BEFORE';
  const AFTER = 'PI-INLINE-AFTER';
  const MID = 'PI-INLINE-MID';
  const midSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><circle cx="60" cy="60" r="40" fill="#8a2be2"/><text x="60" y="66" font-size="10" text-anchor="middle" fill="#fff">${MID}</text></svg>`;
  await page.evaluate(
    ({ before, after, svg }) => {
      window.__pi_store().setState({
        messages: [
          {
            kind: 'assistant',
            id: 'canvas-probe-interleave',
            blocks: [{ type: 'text', text: `${before}\n\n\`\`\`svg\n${svg}\n\`\`\`\n\n${after}` }],
            timestamp: Date.now(),
            isStreaming: false,
          },
        ],
      });
    },
    { before: BEFORE, after: AFTER, svg: midSvg },
  );
  await page.waitForFunction(
    (marks) => {
      const wrap = document.querySelector('[data-testid="inline-artifacts"]');
      if (wrap === null) return false;
      const svg = wrap.querySelector('.pd-canvas-svg svg');
      if (svg === null || !(wrap.textContent ?? '').includes(marks.mid)) return false;
      const prev = wrap.previousElementSibling?.textContent ?? '';
      const next = wrap.nextElementSibling?.textContent ?? '';
      // The widget sits BETWEEN the two prose runs — proof it is not at the foot.
      return prev.includes(marks.before) && next.includes(marks.after);
    },
    { before: BEFORE, mid: MID, after: AFTER },
    { timeout: 8000 },
  );

  // (d) B1: an image tab with a data-URI PNG renders (loaded), not a spinner.
  const PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
  await page.evaluate((src) => {
    window.__pi_canvas().openTab({ kind: 'image', title: 'PNG', mediaSrc: src, mediaType: 'PNG' });
  }, PNG);
  await page.waitForFunction(
    () => {
      const scope = '[data-testid="canvas-tabs-panel"] ';
      const img = document.querySelector(`${scope}.pd-media-image`);
      const spinner = document.querySelector(`${scope}.pd-media-status`);
      return (
        img !== null &&
        img.getAttribute('data-status') === 'loaded' &&
        !img.hasAttribute('hidden') &&
        spinner === null
      );
    },
    undefined,
    { timeout: 8000 },
  );

  console.log(
    'canvas-probe OK — big artifact → canvas TAB; small artifact stayed inline + moved to a tab; an inline svg rendered BETWEEN its text runs (A1); a data-URI PNG rendered loaded, not a spinner (B1)',
  );
} finally {
  await app.close();
}
