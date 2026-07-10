/**
 * Round-9 adversarial E2E — TOOL-CALL OUTPUT IN A TERMINAL (failure point #5,
 * the "shows tool-call/command output" half).
 *
 * An interactive bash tool call (`npm run dev`) opens a live read-only "mirror"
 * terminal tab (terminal-routing.ts) that streams the command + its output into
 * an xterm. Here the mirror is the ONLY terminal, so the surface mounts cleanly
 * and its xterm must render both the command and the tool result. Run
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
const fixture = path.join(repoRoot, 'packages/engine/tools/mock-pi/fixtures/simple-chat.json');

function assert(condition, message) {
  if (!condition) throw new Error(`round9-terminal-mirror-probe failed: ${message}`);
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

  // An interactive bash tool call (with its result) → a mirror terminal tab.
  await page.evaluate(() => {
    window.__pi_store().setState({
      messages: [
        {
          kind: 'assistant',
          id: 'r9-mirror',
          blocks: [
            {
              type: 'toolCall',
              id: 'call_mirror',
              name: 'bash',
              arguments: { command: 'npm run dev' },
            },
          ],
          timestamp: Date.now(),
          isStreaming: true,
        },
        {
          kind: 'toolResult',
          id: 'tr-call_mirror',
          toolCallId: 'call_mirror',
          assistantId: 'r9-mirror',
          toolName: 'bash',
          text: 'VITE ready in 312 ms\nLocal: http://localhost:5173/',
          isError: false,
          timestamp: Date.now(),
        },
      ],
    });
  });

  // The mirror terminal tab (keyed by the call id) auto-opens.
  await page.waitForSelector(`${PANEL} .pd-terminal .xterm-rows`, { timeout: 10000 });
  await page.waitForFunction(
    () =>
      window
        .__pi_canvas()
        .getState()
        .tabs.some((t) => t.key === 'term:call_mirror' && t.data?.mirror === true),
    undefined,
    { timeout: 8000 },
  );
  // Its xterm renders the tool call's command + output.
  await page.waitForFunction(
    () => {
      const rows = document.querySelector(
        '[data-testid="canvas-tabs-panel"] .pd-terminal .xterm-rows',
      );
      const t = rows?.textContent ?? '';
      return t.includes('npm run dev') && t.includes('VITE ready');
    },
    undefined,
    { timeout: 10000 },
  );

  console.log(
    'round9-terminal-mirror-probe OK — an interactive bash tool call opened a live mirror terminal tab whose xterm rendered the command ($ npm run dev) and its output (VITE ready)',
  );
} finally {
  await app.close();
}
