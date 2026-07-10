/**
 * Round-7 E2E: the app-integration wave. Launches the built app (mock-pi) and
 * drives the new canvas + UI wiring end to end:
 *
 *   1. SEARCH GLASS: the sidebar "Search chats" field is a SearchInput with a
 *      leading magnifying-glass icon.
 *   2. LIGHT/DARK toggle relocated to the BOTTOM-LEFT (near the profile), and it
 *      still flips the theme.
 *   3. PERSISTENT CANVAS TOGGLE (top-right) opens an EMPTY canvas (no artifact)
 *      and closes it again.
 *   4. PER-TAB OPERATION BAR renders by kind: a FILE tab (breadcrumb + file-tree
 *      + Open ▾), a BROWSER tab (URL bar + open-external), an IMAGE tab
 *      (Download as …).
 *   5. open-with / reveal / open-external shell-out IPC channels fire with the
 *      right args (invoke is wrapped + stubbed so no real app launches).
 *   6. FILE WRITE → live canvas FILE tab: a mock `write` tool call opens a file
 *      tab keyed by its path, streaming, showing the written content.
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
const fixture = path.join(repoRoot, 'packages/engine/tools/mock-pi/fixtures/simple-chat.json');

function assert(condition, message) {
  if (!condition) throw new Error(`round7-probe failed: ${message}`);
}

assert(
  existsSync(path.join(appRoot, 'dist/index.html')) &&
    existsSync(path.join(appRoot, 'dist-electron/main.js')),
  'app is not built — run `pnpm build` first',
);

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'));
const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${userDataDir}`],
  env: { ...process.env, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});

const opbar = (kind) => `[data-testid="canvas-tabs-panel"] .pd-canvas-opbar[data-kind="${kind}"]`;

try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__pi_canvas === 'function', { timeout: 8000 });
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 8000 });

  const viewport = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));

  // ── 1. Search glass (round-8: CollapsibleSearch — a glass + label until clicked)
  await page.waitForSelector('[data-testid="sidebar-search"]', { timeout: 8000 });
  const hasGlass = await page.evaluate(() => {
    const wrap = document.querySelector('[data-testid="sidebar-search"]');
    // The magnifying glass is always visible (collapsed trigger or expanded field).
    return wrap?.querySelector('svg') !== null;
  });
  assert(hasGlass, 'the sidebar search field has no leading magnifying-glass icon');

  // ── 2. Light/dark toggle is bottom-left + flips the theme ────────────────────
  const modeBtn = page.locator('[data-testid="toggle-mode"]');
  assert((await modeBtn.count()) === 1, 'expected exactly one light/dark toggle');
  const modeBox = await modeBtn.boundingBox();
  assert(modeBox !== null, 'light/dark toggle has no bounding box');
  assert(
    modeBox.y > viewport.h * 0.5,
    `light/dark toggle should be in the BOTTOM half (y=${Math.round(modeBox.y)}/${viewport.h})`,
  );
  assert(
    modeBox.x < viewport.w * 0.4,
    `light/dark toggle should be on the LEFT (x=${Math.round(modeBox.x)}/${viewport.w})`,
  );
  const beforeMode = await page.evaluate(() => document.documentElement.getAttribute('data-mode'));
  await modeBtn.click();
  await page.waitForFunction(
    (before) => document.documentElement.getAttribute('data-mode') !== before,
    beforeMode,
    { timeout: 8000 },
  );

  // ── 3. Persistent top-right canvas toggle opens/closes an EMPTY canvas ────────
  const canvasToggle = page.locator('[data-testid="canvas-toggle"]');
  const toggleBox = await canvasToggle.boundingBox();
  assert(toggleBox !== null, 'canvas toggle has no bounding box');
  assert(
    toggleBox.x > viewport.w * 0.6 && toggleBox.y < viewport.h * 0.2,
    `canvas toggle should be TOP-RIGHT (x=${Math.round(toggleBox.x)}, y=${Math.round(toggleBox.y)})`,
  );
  assert(
    (await page.locator('[data-testid="canvas-tabs-panel"]').count()) === 0,
    'canvas panel should be absent before it is opened',
  );
  await canvasToggle.click();
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="canvas-tabs-panel"]');
      return el?.getAttribute('data-open') === 'true' && el.getBoundingClientRect().width > 100;
    },
    undefined,
    { timeout: 8000 },
  );
  await page.waitForSelector('[data-testid="canvas-tabs-panel"] .pd-canvas-empty', {
    timeout: 8000,
  });
  // Round-8 #11/#16: while OPEN, the toggle lives in the CANVAS top-right (an X),
  // and the chat top-right toggle hides. Closing via that X removes the rail
  // (empty + closed → nothing).
  assert(
    (await page.locator('[data-testid="canvas-toggle"]').count()) === 0,
    'the chat top-right canvas toggle must hide while the canvas is open',
  );
  await page.click('[data-testid="canvas-tabs-panel"] button[aria-label="Close canvas panel"]');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="canvas-tabs-panel"]') === null,
    undefined,
    { timeout: 8000 },
  );

  // Under ?piE2E=1 the app records canvas shell-out invokes to
  // window.__pi_canvas_ipc and skips the real shell-out (native-surfaces.ts), so
  // the probe reads that array — `window.piDesktop` is a frozen contextBridge
  // object we cannot wrap from the page.

  // ── 4a. FILE tab operation bar + 5a. reveal / open-with IPC ──────────────────
  await page.evaluate(() => {
    window.__pi_canvas().openTab({
      kind: 'file',
      title: 'notes.md',
      filePath: '/tmp/pi-rt7/notes.md',
      artifact: { id: 'f1', filename: 'notes.md', content: { kind: 'markdown', text: '# Hi rt7' } },
    });
  });
  await page.waitForSelector(opbar('file'), { timeout: 8000 });
  const crumbText = await page.locator(`${opbar('file')} .pd-canvas-crumbs`).innerText();
  assert(
    /notes\.md/.test(crumbText),
    `file breadcrumb missing filename: ${JSON.stringify(crumbText)}`,
  );
  await page.waitForSelector(`${opbar('file')} button[aria-label="Toggle file tree"]`, {
    timeout: 8000,
  });

  // Round-8 #14: the split "Open" primary opens with the DEFAULT app
  // (canvas:open-with { appId: 'default' }); the ▾ caret's menu carries
  // "Open in folder" (canvas:reveal). (The richer app-list is covered in round8.)
  await page.click(`${opbar('file')} .pd-canvas-split-main`);
  await page.click(`${opbar('file')} .pd-canvas-split-caret`);
  await page.click(`${opbar('file')} .pd-canvas-popmenu button:has-text("Open in folder")`);

  const fileCalls = await page.evaluate(() => window.__pi_canvas_ipc ?? []);
  const reveal = fileCalls.find((c) => c.channel === 'canvas:reveal');
  assert(
    reveal?.req?.path === '/tmp/pi-rt7/notes.md',
    'canvas:reveal not invoked with the file path',
  );
  const openDefault = fileCalls.find((c) => c.channel === 'canvas:open-with');
  assert(
    openDefault?.req?.appId === 'default' && openDefault?.req?.path === '/tmp/pi-rt7/notes.md',
    'canvas:open-with not invoked with { path, appId: default }',
  );

  // ── 4b. BROWSER tab operation bar + 5b. open-external IPC ────────────────────
  await page.evaluate(() =>
    window
      .__pi_canvas()
      .openTab({ kind: 'browser', title: 'Example', url: 'https://example.com/' }),
  );
  await page.waitForSelector(opbar('browser'), { timeout: 8000 });
  const urlVal = await page.locator(`${opbar('browser')} .pd-browser-url`).inputValue();
  assert(urlVal === 'https://example.com/', `browser URL bar missing the url: ${urlVal}`);
  await page.click(`${opbar('browser')} button[aria-label="Open in external browser"]`);
  const extCall = await page.evaluate(() =>
    (window.__pi_canvas_ipc ?? []).find((c) => c.channel === 'canvas:open-external'),
  );
  assert(
    extCall?.req?.url === 'https://example.com/',
    'canvas:open-external not invoked with the url',
  );

  // ── 4c. IMAGE tab operation bar ──────────────────────────────────────────────
  await page.evaluate(
    (src) =>
      window
        .__pi_canvas()
        .openTab({ kind: 'image', title: 'pic.png', mediaSrc: src, mediaType: 'PNG' }),
    PNG,
  );
  await page.waitForSelector(opbar('image'), { timeout: 8000 });
  const dl = await page.locator(`${opbar('image')} .pd-media-download`).innerText();
  assert(/download as png/i.test(dl), `image bar missing "Download as PNG": ${JSON.stringify(dl)}`);

  // ── 6. File write → live canvas FILE tab ─────────────────────────────────────
  await page.evaluate(() => {
    window.__pi_store().setState({
      messages: [
        {
          kind: 'assistant',
          id: 'rt7-write',
          blocks: [
            {
              type: 'toolCall',
              id: 'call_rt7_write',
              name: 'write',
              arguments: { path: '/tmp/pi-rt7/live.txt', content: 'LIVE-CONTENT-RT7' },
            },
          ],
          timestamp: Date.now(),
          isStreaming: true,
        },
      ],
    });
  });
  // A file tab keyed by the write's path opens, streaming, showing the content.
  await page.waitForFunction(
    () => {
      const bar = document.querySelector(
        '[data-testid="canvas-tabs-panel"] .pd-canvas-opbar[data-kind="file"]',
      );
      const crumbs = bar?.querySelector('.pd-canvas-crumbs')?.textContent ?? '';
      const body =
        document.querySelector('[data-testid="canvas-tabs-panel"] .pd-canvas-tabpanel')
          ?.textContent ?? '';
      return crumbs.includes('live.txt') && body.includes('LIVE-CONTENT-RT7');
    },
    undefined,
    { timeout: 8000 },
  );
  const streaming = await page.evaluate(() => {
    const tab = window
      .__pi_canvas()
      .getState()
      .tabs.find((t) => t.key === 'file:/tmp/pi-rt7/live.txt');
    return {
      found: tab !== undefined,
      streaming: tab?.streaming === true,
      filePath: tab?.filePath,
    };
  });
  assert(streaming.found, 'no live file tab opened for the write tool call');
  assert(streaming.streaming, 'the live file tab should be streaming while the write is in flight');
  assert(streaming.filePath === '/tmp/pi-rt7/live.txt', 'the live file tab has the wrong filePath');

  console.log(
    'round7-probe OK — search glass; light/dark bottom-left flips theme; top-right toggle opens/closes an empty canvas; file/browser/image operation bars render; reveal/open-with/open-external IPC fired; a file-write tool call opened a live streaming file tab',
  );
} finally {
  await app.close();
}
