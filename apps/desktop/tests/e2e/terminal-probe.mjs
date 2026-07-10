/**
 * Terminal-tab E2E (Phase 2b): opens a terminal canvas tab, which mounts
 * xterm.js into the surface slot backed by a main-process PTY (node-pty, or the
 * piped-shell fallback), types a command, and asserts its OUTPUT renders.
 *
 * The command is `echo hi=$((6*7))`: the typed text contains `$((6*7))`, so the
 * rendered token `hi=42` can ONLY come from the shell actually executing —
 * proving the full round trip (xterm keystroke → pty:write → shell → pty:data →
 * xterm). Assumes a POSIX shell (bash/zsh, the macOS defaults). Run `pnpm build`
 * first.
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
  if (!condition) throw new Error(`terminal-probe failed: ${message}`);
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
  await page.waitForFunction(() => typeof window.__pi_canvas === 'function', { timeout: 8000 });

  // Open a terminal tab; xterm mounts into the slot and the PTY spawns.
  await page.evaluate(() => window.__pi_canvas().openTab({ kind: 'terminal', title: 'Terminal' }));
  await page.waitForSelector('[data-testid="canvas-tabs-panel"] .pd-terminal .xterm-rows', {
    timeout: 10000,
  });

  // Focus the terminal and run the command.
  await page.locator('[data-testid="canvas-tabs-panel"] .pd-terminal .xterm-screen').click();
  await page.keyboard.type('echo hi=$((6*7))');
  await page.keyboard.press('Enter');

  // The executed output `hi=42` renders in the xterm grid.
  await page.waitForFunction(
    (token) => {
      const rows = document.querySelector(
        '[data-testid="canvas-tabs-panel"] .pd-terminal .xterm-rows',
      );
      return (rows?.textContent ?? '').includes(token);
    },
    'hi=42',
    { timeout: 12000 },
  );

  console.log(
    'terminal-probe OK — xterm mounted, PTY spawned, and `echo hi=$((6*7))` executed (rendered "hi=42")',
  );
} finally {
  await app.close();
}
