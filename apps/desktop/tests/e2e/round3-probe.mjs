/**
 * Round-3 app-integration E2E: launches the built app against mock-pi and
 * asserts the visible-polish wave —
 *   #A3  empty state centers the composer vertically (not pinned to the bottom)
 *   #A7  the rule-based suggestion overlay is gone
 *   #A13 assistant text renders through the design-system Markdown (.pd-markdown)
 *   #A10 the thread scroll HARD-STOPS at the edges (overscroll-behavior: none — R14 C2
 *        removed the JS rubber-band; no bounce, no scroll-chaining)
 *   #A9  clicking Edit flips the user bubble into an inline editor (not the composer)
 *   #A8  a file dragged anywhere shows the fullscreen drop overlay + attaches a preview
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
  if (!condition) throw new Error(`round3-probe failed: ${message}`);
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

try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 8000 });
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 8000 });

  // #A3: on the empty state the composer sits in the vertical middle, NOT
  // pinned to the bottom. Assert its center is in the upper-three-quarters.
  {
    const box = await page.locator('[data-testid="composer-input"]').boundingBox();
    const vh = await page.evaluate(() => window.innerHeight);
    assert(box !== null, 'composer input has no box on empty state');
    const centerY = box.y + box.height / 2;
    assert(
      centerY < vh * 0.75,
      `empty composer should be vertically centered, center=${centerY} vh=${vh}`,
    );
    // The thread scroller only exists once there are messages.
    assert(
      (await page.locator('[data-testid="chat-scroll"]').count()) === 0,
      'thread scroller should not exist on the empty state',
    );
  }

  // #A7: the suggestion overlay is removed — typing never surfaces it.
  await page.click('[data-testid="composer-input"]');
  await page.keyboard.type('write a plan to refactor the parser');
  await page.waitForTimeout(200);
  assert(
    (await page.locator('[data-testid="composer-suggestions"]').count()) === 0,
    'suggestion overlay should be gone (#A7)',
  );

  // Send a prompt; the mock streams a markdown reply.
  await page.keyboard.press('Enter');
  await page.waitForSelector('text=Hello from mock-pi — streaming works.', { timeout: 10000 });

  // #A13: assistant text renders through the design-system Markdown container.
  assert(
    (await page.locator('.pd-markdown').count()) >= 1,
    'assistant text should render inside .pd-markdown (#A13)',
  );

  // #A10 / R14 C2: the thread scroller HARD-STOPS at its edges — the JS
  // rubber-band is gone and overscroll-behavior is `none` (no bounce, no
  // scroll-chaining out of the pane).
  {
    const scroll = page.locator('[data-testid="chat-scroll"]');
    await scroll.waitFor({ state: 'visible', timeout: 8000 });
    const behavior = await scroll.evaluate(
      (el) => getComputedStyle(el).overscrollBehaviorY || getComputedStyle(el).overscrollBehavior,
    );
    assert(/none/.test(behavior), `expected hard-stop overscroll:none, got ${behavior}`);
  }

  // #A9: clicking Edit on the user bubble opens an inline editor (NOT the composer).
  {
    const userRow = page.locator('.pd-msg--user').first();
    await userRow.hover();
    await page.click('button[aria-label="Edit message"]');
    const editing = page.locator('[data-testid="editing-message"]');
    await editing.waitFor({ state: 'visible', timeout: 4000 });
    const value = await editing.locator('textarea').inputValue();
    assert(
      /write a plan to refactor/.test(value),
      `inline editor should prefill the message text, got ${JSON.stringify(value)}`,
    );
    await editing.locator('button:has-text("Cancel")').click();
    await editing.waitFor({ state: 'detached', timeout: 4000 });
  }
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([1, 2, 3])], 'pic.png', { type: 'image/png' }));
    window.__pi_dt = dt;
    window.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: dt }));
  });
  await page.locator('[data-testid="window-drop-overlay"]').waitFor({
    state: 'visible',
    timeout: 4000,
  });
  await page.evaluate(() => {
    window.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: window.__pi_dt }));
  });
  await page.locator('[data-testid="window-drop-overlay"]').waitFor({
    state: 'detached',
    timeout: 4000,
  });
  await page.locator('[data-testid="composer-attachments"] img.pd-attach-thumb').waitFor({
    state: 'visible',
    timeout: 4000,
  });

  console.log(
    'round3-probe OK — centered composer, no suggestions, markdown, hard-stop scroll, inline edit, drop overlay',
  );
} finally {
  await app.close();
}
