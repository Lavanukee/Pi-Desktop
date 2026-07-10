/**
 * Round-9 adversarial E2E — SINGLE-INSTANCE LOCK (failure point #14).
 *
 * A second app launch sharing the same userData dir must NOT double-spawn: the
 * single-instance lock (app.requestSingleInstanceLock in electron/main.ts) makes
 * the second process quit, and the first app's `second-instance` handler focuses
 * the existing window. We assert the second launch opens NO window while the
 * first stays alive with its window. Run `pnpm build` first.
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
  if (!condition) throw new Error(`round9-single-instance-probe failed: ${message}`);
}

assert(existsSync(path.join(appRoot, 'dist/index.html')), 'app is not built — run `pnpm build`');

// One SHARED userData dir → the single-instance lock keys off it.
const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'));
const launch = () =>
  electron.launch({
    executablePath: electronBinary,
    args: [appRoot, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
  });

const app1 = await launch();
let app2 = null;
try {
  const page1 = await app1.firstWindow();
  await page1.waitForSelector('[data-testid="composer-input"]', { timeout: 12000 });
  assert(app1.windows().length === 1, 'the first app should have exactly one window');

  // Second launch with the SAME userData dir.
  let secondOpenedWindow = false;
  try {
    app2 = await launch();
    // If the lock holds, the second process quits before opening a window.
    const win2 = await app2.firstWindow({ timeout: 4000 }).catch(() => null);
    secondOpenedWindow = win2 !== null;
  } catch {
    // launch/attach failing because the process quit immediately is also the
    // single-instance lock doing its job — not a second window.
    secondOpenedWindow = false;
  }

  assert(
    !secondOpenedWindow,
    'a second app instance opened its OWN window (single-instance lock failed → double-spawn)',
  );

  // The first app must still be alive with its single window (it was focused, not
  // replaced).
  assert(
    app1.windows().length === 1,
    `the first app should still have exactly one window, got ${app1.windows().length}`,
  );
  await page1.waitForSelector('[data-testid="composer-input"]', { timeout: 8000 });

  console.log(
    'round9-single-instance-probe OK — a second launch sharing the userData dir did not open a second window; the first app stayed alive with its single window (single-instance lock held)',
  );
} finally {
  if (app2 !== null) await app2.close().catch(() => {});
  await app1.close();
}
