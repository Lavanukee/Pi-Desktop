/**
 * Chat UI E2E: launches the built app against mock-pi, types a prompt into the
 * REAL Lexical composer, presses Enter, and asserts the streamed assistant text
 * plus the THEME 3 rework: a multi-tool turn renders ONE collapsed ActivityChain
 * (past-tense summary) that expands on click into a stacked step list, and a
 * step expands to its content (the bash command). Plus the store shape. Run
 * `pnpm build` first.
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
const fixture = path.join(repoRoot, 'packages/engine/tools/mock-pi/fixtures/tool-use.json');

function assert(condition, message) {
  if (!condition) throw new Error(`chat-ui-probe failed: ${message}`);
}

assert(
  existsSync(path.join(appRoot, 'dist/index.html')) &&
    existsSync(path.join(appRoot, 'dist-electron/main.js')),
  'app is not built — run `pnpm build` first',
);

// Isolated userData so the probe never contends with an installed Pi Desktop
// (single-instance lock lives in userData).
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

  // Type into the real Lexical editor and submit with Enter.
  await page.click('[data-testid="composer-input"]');
  await page.keyboard.type('look around the repo');
  await page.keyboard.press('Enter');

  // Streamed assistant text renders in the thread.
  await page.waitForSelector('text=Let me look around.', { timeout: 10000 });
  // Final streamed text after the tool sequence (turn complete).
  await page.waitForSelector('text=Done — hello.txt now greets the world.', { timeout: 10000 });

  // THEME 3: the bash + edit calls collapse into ONE ActivityChain. It renders
  // COLLAPSED (data-expanded="false") with a dim past-tense summary — the raw
  // command is NOT visible until a step is expanded.
  const chain = page.locator('[data-testid="activity-chain"]');
  await chain.waitFor({ state: 'visible', timeout: 10000 });
  assert((await chain.count()) === 1, `expected exactly one chain, got ${await chain.count()}`);
  assert(
    (await chain.getAttribute('data-expanded')) === 'false',
    'chain should render collapsed by default',
  );
  const summary = await chain.locator('.pd-chain-summary-text').innerText();
  assert(
    /ran a command/i.test(summary) && /edited a file/i.test(summary),
    `unexpected collapsed summary: ${JSON.stringify(summary)}`,
  );
  // The round-3 chain keeps its steps MOUNTED while collapsed (the reveal rolls
  // open via grid-rows: 0fr → 1fr for the collapse animation), so the reliable
  // "hidden" signal is the chain-level reveal container being closed.
  assert(
    (await chain.locator('.pd-chain-reveal').first().getAttribute('data-open')) === 'false',
    'the step list should be collapsed (reveal closed) by default',
  );

  // Click the summary → the chain expands into a stacked step list.
  await chain.locator('.pd-chain-summary').click();
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="activity-chain"]')?.getAttribute('data-expanded') ===
      'true',
    undefined,
    { timeout: 8000 },
  );
  await chain.locator('.pd-chain-step[data-kind="bash"]').first().waitFor({ timeout: 8000 });
  await chain.locator('.pd-chain-step[data-kind="edit"]').first().waitFor({ timeout: 8000 });

  // Click the bash STEP → it expands one level to reveal the command.
  await chain.locator('.pd-chain-step[data-kind="bash"] .pd-chain-step-row').first().click();
  await page.waitForSelector('text=ls -la /tmp/demo', { timeout: 8000 });

  // Store shape: a user echo, an assistant with a toolCall block, a tool result.
  const shape = await page.evaluate(() => {
    const { messages } = window.__pi_store().getState();
    const assistant = messages.find(
      (m) => m.kind === 'assistant' && m.blocks.some((b) => b.type === 'toolCall'),
    );
    return {
      hasUser: messages.some((m) => m.kind === 'user'),
      hasToolCall: assistant !== undefined,
      hasToolResult: messages.some((m) => m.kind === 'toolResult'),
    };
  });
  assert(shape.hasUser, 'no user echo in the store');
  assert(shape.hasToolCall, 'no assistant tool-call block in the store');
  assert(shape.hasToolResult, 'no tool result in the store');

  // B2: with a live session, typing `/` opens the command autocomplete. The
  // built-ins are always available, so `/` must show something (the original
  // mount-only fetch lost the race with the RPC and showed nothing).
  await page.click('[data-testid="composer-input"]');
  await page.keyboard.type('/');
  const ac = page.locator('[data-testid="composer-autocomplete"]');
  await ac.waitFor({ state: 'visible', timeout: 8000 });
  await ac.locator('[role="option"]').first().waitFor({ timeout: 8000 });
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="composer-autocomplete"]');
      return (el?.textContent ?? '').includes('/help');
    },
    undefined,
    { timeout: 8000 },
  );

  console.log(
    'chat-ui-probe OK — streamed text + a COLLAPSED ActivityChain that expanded on click into steps, a step revealed its command, and `/` opened the command menu (B2)',
  );
} finally {
  await app.close();
}
