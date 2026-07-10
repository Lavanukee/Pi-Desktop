/**
 * Round-9 adversarial E2E — PI KILLED MID-STREAM (failure point #11).
 *
 * With a turn streaming, the pi child process is killed. The app must degrade
 * gracefully — surface the "Pi stopped" restart affordance (ToastHost, driven by
 * the store's `bridgeExited`) and keep the UI mounted — NOT hang on a white
 * screen. Run `pnpm build` first.
 */
import { execSync } from 'node:child_process';
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
  if (!condition) throw new Error(`round9-pi-crash-probe failed: ${message}`);
}

assert(existsSync(path.join(appRoot, 'dist/index.html')), 'app is not built — run `pnpm build`');

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

  // Start a turn streaming, then kill pi mid-flight.
  await page.click('[data-testid="composer-input"]');
  await page.keyboard.type('hello there');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);

  // Kill the mock-pi child (the app spawned it as PI_BIN). SIGKILL so it cannot
  // shut down cleanly — the harshest "process vanished" case.
  try {
    execSync('pkill -9 -f mock-pi.mjs');
  } catch {
    // pkill exits non-zero if nothing matched; the process may have already gone.
  }

  // The app surfaces the bridge-exit restart affordance and stays mounted.
  await page.waitForFunction(
    () => window.__pi_store().getState().bridgeExited !== null,
    undefined,
    { timeout: 12000 },
  );
  await page.waitForSelector('text=Pi stopped', { timeout: 6000 });
  await page.waitForSelector('button:has-text("Restart")', { timeout: 6000 });
  assert(
    (await page.locator('[data-testid="composer-input"]').count()) === 1,
    'the composer disappeared after pi died (white-screen / hang)',
  );

  console.log(
    'round9-pi-crash-probe OK — killing pi mid-stream surfaced the "Pi stopped" restart affordance (bridgeExited) and left the UI mounted (no white-screen/hang)',
  );
} finally {
  await app.close();
}
