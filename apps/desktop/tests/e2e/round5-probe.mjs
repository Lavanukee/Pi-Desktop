/**
 * Round-5 app-integration E2E (mock pi, isolated HOME + udd). Verifies the
 * round-5 app-level polish:
 *   1. sidebar Workspace nav sits ABOVE the Chats list (#22)
 *   2. the top-bar chat title inline-renames (#13)
 *   3. the bottom-bar info button reveals a turn-stats popover on hover (#25)
 *   4. no raw model-id footnote under a response (#11)
 *   5. standalone thoughts default COLLAPSED as a "Thought…" summary and expand
 *      on click (#3; round-6 UNIFY: now via the ActivityChain chrome)
 *   6. a generated image renders INLINE and opens a FULLSCREEN lightbox (#7)
 *   7. the canvas panel toggle SLIDES the panel out, and a restore control
 *      slides it back in (#18/#19)
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
  if (!condition) throw new Error(`round5-probe failed: ${message}`);
}

assert(existsSync(path.join(appRoot, 'dist/index.html')), 'app is not built — run `pnpm build`');

// A 1×1 transparent PNG — enough to prove the inline image renders + lightboxes.
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

// A padded SVG whose source exceeds the inline budget → routes to a canvas tab.
const bigPad = '<rect x="0" y="0" width="1" height="1" fill="#000"/>'.repeat(60);
const bigSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><circle cx="60" cy="60" r="48" fill="#ff6347"/>${bigPad}<text x="60" y="66" font-size="11" text-anchor="middle" fill="#fff">R5-CANVAS</text></svg>`;

const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'));
const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${userDataDir}`],
  env: { ...process.env, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});

const setMessages = (page, messages) =>
  page.evaluate((msgs) => window.__pi_store().setState({ messages: msgs }), messages);

try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 12000 });
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 12000 });

  // ── 1. Sidebar: Workspace nav is ABOVE the Chats list ─────────────────────────
  await page.waitForSelector('[data-testid="nav-model-management"]', { timeout: 8000 });
  const headerOrder = await page.evaluate(() =>
    [...document.querySelectorAll('.pd-sidebar-section-header')].map((el) =>
      (el.textContent ?? '').trim(),
    ),
  );
  const wsIdx = headerOrder.findIndex((t) => t.includes('Workspace'));
  const chatsIdx = headerOrder.findIndex((t) => t.includes('Chats'));
  assert(
    wsIdx >= 0 && chatsIdx >= 0 && wsIdx < chatsIdx,
    `Workspace nav must be above Chats — section order was ${JSON.stringify(headerOrder)}`,
  );

  // ── 2. Top-bar chat title inline-renames ──────────────────────────────────────
  const titleBtn = page.locator('[data-testid="chat-title"]');
  await titleBtn.waitFor({ state: 'visible', timeout: 8000 });
  await titleBtn.click();
  const titleInput = page.locator('[data-testid="chat-title-input"]');
  await titleInput.waitFor({ state: 'visible', timeout: 4000 });
  await titleInput.fill('Renamed by probe');
  await titleInput.press('Enter');
  await page.waitForFunction(
    () =>
      (document.querySelector('[data-testid="chat-title"]')?.textContent ?? '').includes(
        'Renamed by probe',
      ),
    null,
    { timeout: 5000 },
  );

  // ── 3. Bottom-bar info popover: turn stats on hover ───────────────────────────
  await setMessages(page, [
    { kind: 'user', id: 'u-stats', text: 'draw a cat', timestamp: Date.now() - 3200 },
    {
      kind: 'assistant',
      id: 'a-stats',
      blocks: [{ type: 'text', text: 'Here you go.' }],
      usage: {
        input: 1200,
        output: 340,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 1540,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      timestamp: Date.now(),
      isStreaming: false,
    },
  ]);
  await page.hover('[data-testid="footer-info"]');
  // Radix renders the tooltip content twice (visible + an a11y copy); both carry
  // the same text, so read the first match once it appears.
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="turn-stats"]').length > 0,
    null,
    { timeout: 5000 },
  );
  const statsText = await page.evaluate(
    () => document.querySelector('[data-testid="turn-stats"]')?.textContent ?? '',
  );
  for (const needle of ['Input', 'Output', 'Total', 'Tool calls', 'Elapsed']) {
    assert(statsText.includes(needle), `stats popover missing "${needle}" — got: ${statsText}`);
  }
  // Move the pointer off so the tooltip dismisses before the next step.
  await page.mouse.move(0, 0);

  // ── 4. No raw model-id footnote under a response ──────────────────────────────
  await setMessages(page, [
    {
      kind: 'assistant',
      id: 'a-model',
      model: 'gemma-4-e2b-it',
      blocks: [{ type: 'text', text: 'A plain answer.' }],
      timestamp: Date.now(),
      isStreaming: false,
    },
  ]);
  await page.waitForFunction(
    () =>
      (document.querySelector('[data-testid="chat-scroll"]')?.textContent ?? '').includes(
        'A plain answer.',
      ),
    null,
    { timeout: 6000 },
  );
  const hasModelId = await page.evaluate(() =>
    (document.querySelector('[data-testid="chat-scroll"]')?.textContent ?? '').includes(
      'gemma-4-e2b-it',
    ),
  );
  assert(!hasModelId, 'the raw model-id footnote should not appear under a response (#11)');

  // ── 5. Standalone thought: collapsed by default, expands on click ─────────────
  await setMessages(page, [
    {
      kind: 'assistant',
      id: 'a-thought',
      blocks: [
        {
          type: 'thinking',
          thinking: 'Let me reason step by step about the request before answering it clearly.',
        },
        { type: 'text', text: 'Final answer.' },
      ],
      timestamp: Date.now(),
      isStreaming: false,
    },
  ]);
  // Round-6 UNIFY: a thinking-only run now renders through the ActivityChain
  // (clock/line/Done chrome), collapsed to a "Thought" summary by default.
  const thought = page.locator('[data-testid="activity-chain"]').first();
  const thoughtSummary = thought.locator('.pd-chain-summary');
  await thoughtSummary.waitFor({ state: 'visible', timeout: 6000 });
  assert(
    (await thought.getAttribute('data-expanded')) === 'false',
    'a finished standalone thought must default COLLAPSED (#3)',
  );
  assert(
    /Thought/.test((await thought.locator('.pd-chain-summary-text').textContent()) ?? ''),
    'the collapsed thought summary should read "Thought…"',
  );
  await thoughtSummary.click();
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="activity-chain"]')?.getAttribute('data-expanded') ===
      'true',
    null,
    { timeout: 5000 },
  );
  // Expanding reveals the chain chrome — a clock-icon thinking step + Done.
  await thought.locator('.pd-chain-step[data-kind="thinking"]').first().waitFor({ timeout: 5000 });

  // ── 6. Inline generated image renders + opens a fullscreen lightbox ───────────
  await setMessages(page, [
    {
      kind: 'assistant',
      id: 'a-img',
      blocks: [{ type: 'toolCall', id: 'call_img', name: 'generate_image', arguments: {} }],
      timestamp: Date.now(),
      isStreaming: false,
    },
    {
      kind: 'toolResult',
      id: 'tr-a-img-call_img',
      toolCallId: 'call_img',
      assistantId: 'a-img',
      toolName: 'generate_image',
      text: PNG,
      isError: false,
      timestamp: Date.now(),
    },
  ]);
  const thumb = page.locator('[data-testid="thread-image"]');
  await thumb.waitFor({ state: 'visible', timeout: 6000 });
  assert(
    (await page.locator('[data-testid="image-lightbox"]').count()) === 0,
    'lightbox should be closed until the image is clicked',
  );
  await thumb.click();
  await page.locator('[data-testid="image-lightbox"]').waitFor({ state: 'visible', timeout: 4000 });
  await page.locator('[data-testid="image-lightbox"]').click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="image-lightbox"]') === null,
    null,
    { timeout: 4000 },
  );

  // ── 7. Canvas panel slides out on toggle + slides back in on restore ──────────
  await setMessages(page, [
    {
      kind: 'assistant',
      id: 'a-canvas',
      blocks: [{ type: 'text', text: `A drawing:\n\n\`\`\`svg\n${bigSvg}\n\`\`\`` }],
      timestamp: Date.now(),
      isStreaming: false,
    },
  ]);
  const panel = page.locator('[data-testid="canvas-tabs-panel"]');
  await panel.waitFor({ state: 'visible', timeout: 8000 });
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="canvas-tabs-panel"]');
      return el?.getAttribute('data-open') === 'true' && el.getBoundingClientRect().width > 100;
    },
    null,
    { timeout: 8000 },
  );
  // Round-8: the in-canvas toggle (an X while open) slides the panel out
  // (width → 0, data-open false); the tab set is preserved.
  await page.click('[data-testid="canvas-tabs-panel"] [aria-label="Close canvas panel"]');
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="canvas-tabs-panel"]');
      return el?.getAttribute('data-open') === 'false' && el.getBoundingClientRect().width < 2;
    },
    null,
    { timeout: 5000 },
  );
  // Round-8: the chat top-right toggle (visible while closed) slides it back in.
  await page.click('[data-testid="canvas-toggle"]');
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="canvas-tabs-panel"]');
      return el?.getAttribute('data-open') === 'true' && el.getBoundingClientRect().width > 100;
    },
    null,
    { timeout: 5000 },
  );

  console.log(
    'round5-probe OK — workspace nav on top, title rename, info popover, no model footnote, thought collapsed+expands, inline image+lightbox, canvas slide toggle',
  );
} finally {
  await app.close();
}
