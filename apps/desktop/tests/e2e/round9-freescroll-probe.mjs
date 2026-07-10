/**
 * Round-9 adversarial E2E — FREE SCROLL DURING GENERATION (failure point #4).
 *
 * Scrolling UP mid-stream must NOT snap back to the bottom on either surface,
 * even under rapid deltas; returning to the bottom re-arms autoscroll.
 *
 *  A. CHAT THREAD ([data-testid="chat-scroll"]): park up, fire 6 rapid streamed
 *     deltas → the viewport stays where the user left it (no snap-back). Then pin
 *     to the bottom + a delta → autoscroll re-arms (view rides the bottom).
 *  B. LIVE CANVAS FILE TAB (.cm-scroller in a streaming file surface): same test
 *     against useStickToBottom — wheel-up releases the pin, rapid updateTab deltas
 *     don't yank it down; scrolling back to the bottom re-arms it.
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
  if (!condition) throw new Error(`round9-freescroll-probe failed: ${message}`);
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
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 8000 });
  await page.waitForFunction(() => typeof window.__pi_canvas === 'function', { timeout: 8000 });
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 8000 });

  // ── A. CHAT THREAD free-scroll under rapid deltas ────────────────────────────
  const baseLines = (n) =>
    Array.from({ length: n }, (_, i) => `chat line ${i} of a long streaming answer`).join('\n');
  const streamChat = (text) =>
    page.evaluate((text) => {
      window.__pi_store().setState({
        messages: [
          {
            kind: 'assistant',
            id: 'r9-scroll',
            blocks: [{ type: 'text', text }],
            timestamp: Date.now(),
            isStreaming: true,
          },
        ],
      });
    }, text);

  await streamChat(baseLines(80));
  await page.waitForSelector('[data-testid="chat-scroll"]', { timeout: 8000 });

  const chatResult = await page.evaluate(async () => {
    const el = document.querySelector('[data-testid="chat-scroll"]');
    el.scrollTop = el.scrollHeight; // pin to bottom first
    await new Promise((r) => requestAnimationFrame(r));
    // User scrolls UP: real wheel-up (releases the stick) + move the viewport up.
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: -600, bubbles: true, cancelable: true }));
    el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - 600);
    const parked = el.scrollTop;
    // 6 RAPID streamed deltas.
    const store = window.__pi_store();
    for (let i = 0; i < 6; i++) {
      const prev = store.getState().messages[0];
      store.setState({
        messages: [
          { ...prev, blocks: [{ type: 'text', text: `${prev.blocks[0].text}\nrapid delta ${i}` }] },
        ],
      });
      await new Promise((r) => requestAnimationFrame(r));
    }
    await new Promise((r) => setTimeout(r, 80));
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    return { parked, after: el.scrollTop, distFromBottom };
  });
  assert(
    chatResult.distFromBottom > 100,
    `chat thread SNAPPED back to the bottom during rapid streaming (${JSON.stringify(chatResult)})`,
  );

  // Return to the bottom → autoscroll re-arms (rides the bottom on the next delta).
  const chatRearmed = await page.evaluate(async () => {
    const el = document.querySelector('[data-testid="chat-scroll"]');
    el.scrollTop = el.scrollHeight;
    el.dispatchEvent(new Event('scroll', { bubbles: true }));
    await new Promise((r) => requestAnimationFrame(r));
    const store = window.__pi_store();
    const prev = store.getState().messages[0];
    store.setState({
      messages: [
        { ...prev, blocks: [{ type: 'text', text: `${prev.blocks[0].text}\nfinal bottom line` }] },
      ],
    });
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => setTimeout(r, 80));
    return el.scrollHeight - el.scrollTop - el.clientHeight;
  });
  assert(chatRearmed < 60, `chat autoscroll did not re-arm at the bottom (dist=${chatRearmed})`);

  // ── B. LIVE CANVAS FILE TAB free-scroll under rapid deltas ───────────────────
  const codeLines = (n, tag) =>
    Array.from({ length: n }, (_, i) => `// ${tag} line ${i}`).join('\n');
  const filePath = '/tmp/pi-rt9/scroll.ts';
  const tabId = await page.evaluate(
    ({ filePath, text }) =>
      window.__pi_canvas().openTab({
        kind: 'file',
        key: `file:${filePath}`,
        title: 'scroll.ts',
        filePath,
        streaming: true,
        artifact: {
          id: `file:${filePath}`,
          filename: 'scroll.ts',
          content: { kind: 'code', text, language: 'typescript' },
        },
      }),
    { filePath, text: codeLines(200, 'a') },
  );
  await page.waitForSelector(`${PANEL} .pd-canvas-code .cm-scroller`, { timeout: 8000 });

  const fileResult = await page.evaluate(async (tabId) => {
    const scroller = document.querySelector(
      '[data-testid="canvas-tabs-panel"] .pd-canvas-code .cm-scroller',
    );
    scroller.scrollTop = scroller.scrollHeight; // pin to bottom
    await new Promise((r) => requestAnimationFrame(r));
    // Wheel-up releases the stick (bubbles to the surface's body listener).
    scroller.dispatchEvent(
      new WheelEvent('wheel', { deltaY: -600, bubbles: true, cancelable: true }),
    );
    scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight - 500);
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    const parked = scroller.scrollTop;
    // 6 RAPID content deltas via updateTab (streaming appends).
    const cv = window.__pi_canvas();
    let text = cv.getState().tabs.find((t) => t.id === tabId).artifact.content.text;
    for (let i = 0; i < 6; i++) {
      text += `\n// rapid delta ${i}`;
      cv.updateTab(tabId, {
        streaming: true,
        artifact: {
          id: `file:/tmp/pi-rt9/scroll.ts`,
          filename: 'scroll.ts',
          content: { kind: 'code', text, language: 'typescript' },
        },
      });
      await new Promise((r) => requestAnimationFrame(r));
    }
    await new Promise((r) => setTimeout(r, 80));
    const distFromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    return { parked, after: scroller.scrollTop, distFromBottom };
  }, tabId);
  assert(
    fileResult.distFromBottom > 100,
    `live canvas file tab SNAPPED back to the bottom during rapid streaming (${JSON.stringify(fileResult)})`,
  );

  // Scroll back to the bottom → re-arm; the next delta rides the bottom again.
  const fileRearmed = await page.evaluate(async (tabId) => {
    const scroller = document.querySelector(
      '[data-testid="canvas-tabs-panel"] .pd-canvas-code .cm-scroller',
    );
    scroller.scrollTop = scroller.scrollHeight;
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    await new Promise((r) => requestAnimationFrame(r));
    const cv = window.__pi_canvas();
    let text = cv.getState().tabs.find((t) => t.id === tabId).artifact.content.text;
    text += `\n// final bottom line`;
    cv.updateTab(tabId, {
      streaming: true,
      artifact: {
        id: `file:/tmp/pi-rt9/scroll.ts`,
        filename: 'scroll.ts',
        content: { kind: 'code', text, language: 'typescript' },
      },
    });
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => setTimeout(r, 80));
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
  }, tabId);
  assert(
    fileRearmed < 60,
    `live canvas file autoscroll did not re-arm at the bottom (dist=${fileRearmed})`,
  );

  console.log(
    'round9-freescroll-probe OK — chat thread held its scroll position through 6 rapid deltas then re-armed at the bottom; the live canvas file tab did the same (wheel-up released the stick, rapid deltas did not snap back, returning to the bottom re-armed autoscroll)',
  );
} finally {
  await app.close();
}
