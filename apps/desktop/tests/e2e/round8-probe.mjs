/**
 * Round-8 E2E: the SHELL wave. Launches the built app (mock-pi) and drives:
 *
 *   A. SIDEBAR: the collapse toggle sits LEFT of a click-to-expand
 *      CollapsibleSearch; the Workspace nav has "Model management" and NO
 *      Artifacts / redundant Settings row; collapsing shrinks to a NARROW ICON
 *      RAIL (~64px, icons visible) rather than hiding.
 *   B. CANVAS `+` MENU: opens a new file / browser / terminal tab.
 *   C. TOP-RIGHT TOGGLE: the only chat top-right control is the canvas toggle,
 *      and only while CLOSED — once open it moves into the canvas (an X) and the
 *      chat toggle hides.
 *   D. SPLIT "Open": the primary segment opens the DEFAULT app
 *      (canvas:open-with { appId:'default' }); the ▾ menu lists the OTHER apps
 *      (default omitted) + "Open in folder", and picking one fires open-with
 *      with that app id.
 *   E. PROJECT PICKER: selecting a project sets the working folder — the chip
 *      shows it and file tabs root their tree at it (fileTreeRootLabel).
 *   F. FREE SCROLL: scrolling up mid-stream is not yanked back to the bottom.
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
  if (!condition) throw new Error(`round8-probe failed: ${message}`);
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

const panelSel = '[data-testid="canvas-tabs-panel"]';
const opbarFile = `${panelSel} .pd-canvas-opbar[data-kind="file"]`;
const tabKinds = (page) =>
  page.evaluate(() =>
    window
      .__pi_canvas()
      .getState()
      .tabs.map((t) => t.kind),
  );

async function openCanvas(page) {
  await page.click('[data-testid="canvas-toggle"]');
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="canvas-tabs-panel"]');
      return el?.getAttribute('data-open') === 'true' && el.getBoundingClientRect().width > 100;
    },
    undefined,
    { timeout: 8000 },
  );
}

async function pickNewTab(page, label) {
  await page.click(`${panelSel} .pd-canvas-newtab`);
  await page.click(`${panelSel} .pd-canvas-popmenu button:has-text("${label}")`);
}

try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__pi_canvas === 'function', { timeout: 8000 });
  await page.waitForFunction(() => typeof window.__pi_project === 'function', { timeout: 8000 });
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 8000 });

  // ── A. SIDEBAR ───────────────────────────────────────────────────────────
  // A1. collapse toggle is LEFT of the search, on the same row.
  const collapseBox = await page.locator('[data-testid="collapse-sidebar"]').boundingBox();
  const searchBox = await page.locator('[data-testid="sidebar-search"]').boundingBox();
  assert(collapseBox !== null && searchBox !== null, 'collapse toggle / search missing');
  assert(
    collapseBox.x + collapseBox.width <= searchBox.x + 8,
    `collapse toggle should sit LEFT of the search (collapse right=${Math.round(
      collapseBox.x + collapseBox.width,
    )}, search left=${Math.round(searchBox.x)})`,
  );
  assert(Math.abs(collapseBox.y - searchBox.y) < 30, 'collapse toggle + search should share a row');

  // A2. the search is a CollapsibleSearch: a glass, then click-to-expand → input.
  assert(
    await page.evaluate(
      () => document.querySelector('[data-testid="sidebar-search"] svg') !== null,
    ),
    'sidebar search has no magnifying-glass icon',
  );
  assert(
    (await page.locator('[data-testid="sidebar-search"] input').count()) === 0,
    'sidebar search should start collapsed (no live input)',
  );
  await page.click('[data-testid="sidebar-search"] button');
  await page.waitForSelector('[data-testid="sidebar-search"] input', { timeout: 8000 });

  // A3. Model-management entry present; Artifacts + redundant Settings gone.
  assert(
    (await page.locator('[data-testid="nav-model-management"]').count()) === 1,
    'Workspace nav is missing the Model management entry',
  );
  assert(
    (await page.locator('[data-testid="nav-artifacts"]').count()) === 0,
    'Workspace nav should no longer have an Artifacts entry',
  );
  assert(
    (await page.locator('[data-testid="nav-settings"]').count()) === 0,
    'Workspace nav should no longer have a redundant Settings entry',
  );

  // A4. collapse → NARROW ICON RAIL (not hidden): icons stay, width ~64px.
  await page.click('[data-testid="collapse-sidebar"]');
  await page.waitForSelector('[data-testid="expand-sidebar"]', { timeout: 8000 });
  // Wait for the collapse animation (width transition) to settle to the rail.
  await page.waitForFunction(
    () => {
      const el = document.querySelector('.pd-sidebar-slot');
      const w = el ? el.getBoundingClientRect().width : 999;
      return w > 40 && w < 130;
    },
    undefined,
    { timeout: 4000 },
  );
  const railW = await page.evaluate(() => {
    const el = document.querySelector('.pd-sidebar-slot');
    return el ? el.getBoundingClientRect().width : 0;
  });
  assert(railW > 40 && railW < 130, `collapsed sidebar should be a ~64px rail, got ${railW}px`);
  assert(
    (await page.locator('[data-testid="new-chat"]').count()) >= 1,
    'the rail should keep its nav icons visible (New chat)',
  );
  // Expand back to the full sidebar.
  await page.click('[data-testid="expand-sidebar"]');
  await page.waitForSelector('[data-testid="sidebar-search"]', { timeout: 8000 });

  // ── B. CANVAS `+` MENU opens file / browser / terminal ─────────────────────
  await openCanvas(page);
  await page.waitForSelector(`${panelSel} .pd-canvas-empty`, { timeout: 8000 });
  await pickNewTab(page, 'Terminal');
  await page.waitForFunction(
    () =>
      window
        .__pi_canvas()
        .getState()
        .tabs.some((t) => t.kind === 'terminal'),
    undefined,
    { timeout: 8000 },
  );
  await pickNewTab(page, 'Browser');
  await page.waitForFunction(
    () =>
      window
        .__pi_canvas()
        .getState()
        .tabs.some((t) => t.kind === 'browser'),
    undefined,
    { timeout: 8000 },
  );
  await pickNewTab(page, 'Files');
  await page.waitForFunction(
    () =>
      window
        .__pi_canvas()
        .getState()
        .tabs.some((t) => t.kind === 'file'),
    undefined,
    { timeout: 8000 },
  );
  const kinds = await tabKinds(page);
  assert(
    ['terminal', 'browser', 'file'].every((k) => kinds.includes(k)),
    `+ menu did not open all three tab kinds: ${JSON.stringify(kinds)}`,
  );

  // ── C. TOP-RIGHT TOGGLE placement (canvas open → chat toggle hides, X shows) ─
  assert(
    (await page.locator('[data-testid="canvas-toggle"]').count()) === 0,
    'chat top-right canvas toggle must hide while the canvas is open',
  );
  assert(
    (await page.locator(`${panelSel} button[aria-label="Close canvas panel"]`).count()) === 1,
    'the open canvas must carry the close (X) toggle in its top-right',
  );

  // ── D. SPLIT "Open" — default app on the primary, others in the menu ───────
  await page.evaluate(() => {
    window.__pi_canvas().openTab({
      kind: 'file',
      title: 'report.md',
      filePath: '/tmp/pi-rt8/report.md',
      artifact: { id: 'f8', filename: 'report.md', content: { kind: 'markdown', text: '# hi' } },
      defaultApp: { id: 'com.microsoft.VSCodeInsiders', name: 'VS Code Insiders' },
      openApps: [
        { id: 'com.microsoft.VSCodeInsiders', name: 'VS Code Insiders' },
        { id: 'com.apple.Terminal', name: 'Terminal' },
        { id: 'com.apple.dt.Xcode', name: 'Xcode' },
      ],
    });
  });
  await page.waitForSelector(opbarFile, { timeout: 8000 });
  // The primary segment is labelled with the default app.
  assert(
    (await page.locator(`${opbarFile} button[aria-label="Open with VS Code Insiders"]`).count()) ===
      1,
    'the Open primary segment should be labelled with the default app',
  );
  // Clicking it opens with the OS default.
  await page.click(`${opbarFile} .pd-canvas-split-main`);
  // The ▾ menu lists the OTHER apps (default omitted) + "Open in folder".
  await page.click(`${opbarFile} .pd-canvas-split-caret`);
  await page.waitForSelector(`${opbarFile} .pd-canvas-popmenu`, { timeout: 8000 });
  const menuText = await page.locator(`${opbarFile} .pd-canvas-popmenu`).innerText();
  assert(/Terminal/.test(menuText) && /Xcode/.test(menuText), 'Open-with menu missing the apps');
  assert(
    !/VS Code Insiders/.test(menuText),
    'Open-with menu must OMIT the default app (VS Code Insiders)',
  );
  assert(/Open in folder/.test(menuText), 'Open-with menu missing "Open in folder"');
  await page.click(`${opbarFile} .pd-canvas-popmenu button:has-text("Terminal")`);

  const fileCalls = await page.evaluate(() => window.__pi_canvas_ipc ?? []);
  const openDefault = fileCalls.find(
    (c) => c.channel === 'canvas:open-with' && c.req?.appId === 'default',
  );
  assert(
    openDefault?.req?.path === '/tmp/pi-rt8/report.md',
    'primary "Open" did not fire canvas:open-with { appId:default }',
  );
  const openTerminal = fileCalls.find(
    (c) => c.channel === 'canvas:open-with' && c.req?.appId === 'com.apple.Terminal',
  );
  assert(
    openTerminal?.req?.path === '/tmp/pi-rt8/report.md',
    'picking Terminal did not fire canvas:open-with { appId:com.apple.Terminal }',
  );

  // ── E. PROJECT PICKER sets the working folder + file-tree root ─────────────
  await page.evaluate(() => window.__pi_project().getState().selectPath('/tmp/pi-rt8-project'));
  await page.waitForFunction(
    () => window.__pi_project().getState().activePath === '/tmp/pi-rt8-project',
    undefined,
    { timeout: 8000 },
  );
  const chipLabel = await page.locator('.pd-project-chip-label').first().innerText();
  assert(
    chipLabel === 'pi-rt8-project',
    `project chip should show the folder name, got "${chipLabel}"`,
  );

  // A file write roots its tree at the active project (fileTreeRootLabel).
  await page.evaluate(() => {
    window.__pi_store().setState({
      messages: [
        {
          kind: 'assistant',
          id: 'rt8-write',
          blocks: [
            {
              type: 'toolCall',
              id: 'call_rt8_write',
              name: 'write',
              arguments: { path: '/tmp/pi-rt8-project/notes.txt', content: 'HELLO-RT8' },
            },
          ],
          timestamp: Date.now(),
          isStreaming: true,
        },
      ],
    });
  });
  await page.waitForFunction(
    () => {
      const tab = window
        .__pi_canvas()
        .getState()
        .tabs.find((t) => t.key === 'file:/tmp/pi-rt8-project/notes.txt');
      return tab?.fileTreeRootLabel === 'pi-rt8-project';
    },
    undefined,
    { timeout: 8000 },
  );

  // ── F. FREE SCROLL during generation — no snap-back once scrolled up ───────
  await page.evaluate(() => {
    const bigText = Array.from(
      { length: 80 },
      (_, i) => `line ${i} of a long streaming answer`,
    ).join('\n');
    window.__pi_store().setState({
      messages: [
        {
          kind: 'assistant',
          id: 'rt8-scroll',
          blocks: [{ type: 'text', text: bigText }],
          timestamp: Date.now(),
          isStreaming: true,
        },
      ],
    });
  });
  await page.waitForSelector('[data-testid="chat-scroll"]', { timeout: 8000 });
  const stayedPut = await page.evaluate(async () => {
    const el = document.querySelector('[data-testid="chat-scroll"]');
    if (el === null) return false;
    el.scrollTop = el.scrollHeight; // pin to bottom
    await new Promise((r) => requestAnimationFrame(r));
    // User scrolls UP: dispatch a real wheel-up (releases the autoscroll stick)
    // and move the viewport up.
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true, cancelable: true }));
    el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - 400);
    const parked = el.scrollTop;
    // More content streams in.
    const store = window.__pi_store();
    const prev = store.getState().messages[0];
    store.setState({
      messages: [
        { ...prev, blocks: [{ type: 'text', text: `${prev.blocks[0].text}\nmore streamed line` }] },
      ],
    });
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => setTimeout(r, 60));
    // It must NOT have snapped back to the bottom.
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    return { parked, after: el.scrollTop, distFromBottom };
  });
  assert(
    stayedPut && stayedPut.distFromBottom > 100,
    `thread snapped back to the bottom while streaming (dist=${JSON.stringify(stayedPut)})`,
  );

  console.log(
    'round8-probe OK — sidebar collapse-left-of-search + CollapsibleSearch + Model-management + rail-on-collapse; canvas + menu opens file/browser/terminal; top-right toggle hides when canvas open (X in canvas); split Open fires default + lists other apps (default omitted) + fires open-with; project picker sets working folder + file-tree root; free-scroll holds during generation',
  );
} finally {
  await app.close();
}
