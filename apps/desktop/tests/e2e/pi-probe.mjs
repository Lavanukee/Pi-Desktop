/**
 * pi engine probe for the built app: launches Electron with PI_BIN pointed at
 * mock-pi, drives the real IPC path (pi:start → pi:prompt) from the renderer,
 * and asserts the streamed response lands in the renderer store via
 * window.__pi_store — the exact surface W3's chat UI and E2E specs consume.
 *
 * Run `pnpm build` first, then `node tests/e2e/pi-probe.mjs`.
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
  if (!condition) throw new Error(`pi-probe failed: ${message}`);
}

assert(
  existsSync(path.join(appRoot, 'dist/index.html')) &&
    existsSync(path.join(appRoot, 'dist-electron/main.js')),
  'app is not built — run `pnpm build` first',
);
assert(existsSync(mockPi), `mock-pi not found at ${mockPi}`);

// Isolated userData so the probe never contends with an installed Pi Desktop's
// single-instance lock (which would make the second instance quit on launch).
const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'));
const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${userDataDir}`],
  env: {
    ...process.env,
    PI_BIN: mockPi,
    MOCK_PI_FIXTURE: fixture,
    // Opts in to the window.__pi_store hook (main appends ?piE2E=1 to the load).
    PI_E2E: '1',
  },
});

try {
  const page = await app.firstWindow();
  await page.waitForSelector('text=Pi Desktop');

  // The pi-connect module installed the store hook at renderer boot.
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 5000 });

  // 1. The chat UI auto-starts the window's pi session on mount, so a manual
  // pi:start over the real invoke path must report a live, already-running bridge.
  const started = await page.evaluate(() => window.piDesktop.invoke('pi:start', {}));
  assert(started.pid > 0, `expected a live pid, got ${JSON.stringify(started)}`);
  assert(started.alreadyRunning === true, 'expected the app to have auto-started pi');

  // 2. The readiness probe's get_state hydrated model + session in the store.
  await page.waitForFunction(
    () => window.__pi_store().getState().agent.model?.id === 'qwen3.6-27b',
    { timeout: 5000 },
  );
  const session = await page.evaluate(() => window.__pi_store().getState().session);
  assert(
    session?.sessionId === 'mock-session-simple-chat',
    `expected hydrated session, got ${JSON.stringify(session)}`,
  );

  // 3. Send a prompt over the real UI-less IPC path.
  const ack = await page.evaluate(() =>
    window.piDesktop.invoke('pi:prompt', { message: 'hello from the probe' }),
  );
  assert(ack.success === true, `prompt not accepted: ${JSON.stringify(ack)}`);

  // 4. The streamed text must land in the renderer store, then finalize.
  const expected = 'Hello from mock-pi — streaming works.';
  await page.waitForFunction(
    (want) => {
      const { messages, agent } = window.__pi_store().getState();
      const assistant = messages.find((m) => m.kind === 'assistant');
      const text = assistant?.blocks
        ?.filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
      return text === want && assistant.isStreaming === false && agent.isStreaming === false;
    },
    expected,
    { timeout: 10000 },
  );

  const summary = await page.evaluate(() => {
    const { messages, agent } = window.__pi_store().getState();
    return {
      kinds: messages.map((m) => m.kind),
      stopReason: messages.find((m) => m.kind === 'assistant')?.stopReason,
      streaming: agent.isStreaming,
    };
  });
  assert(
    JSON.stringify(summary.kinds) === JSON.stringify(['assistant']) ||
      JSON.stringify(summary.kinds) === JSON.stringify(['user', 'assistant']),
    `unexpected message kinds: ${JSON.stringify(summary.kinds)}`,
  );
  assert(summary.stopReason === 'stop', `expected stopReason stop, got ${summary.stopReason}`);

  console.log('pi-probe OK — mock-pi streamed a prompt end-to-end into the renderer store');
} finally {
  await app.close();
}
