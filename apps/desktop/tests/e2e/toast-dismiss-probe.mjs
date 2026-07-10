/**
 * Toast dismiss E2E (round-3 bug 2): the "Pi stopped" bridge-exit notification
 * (and error toasts) must actually dismiss when their X is clicked, and stay
 * gone until a new event.
 *
 * The bridge-exit toast rendered with a hardcoded `open` and no onOpenChange, so
 * clicking its X (RadixToast.Close → onOpenChange(false)) did nothing — the
 * controlled `open` stayed true. The fix clears the `bridgeExited` status on
 * close; since only a real bridge exit / agentStart re-emits it, it stays gone.
 *
 * Drives the store via the PI_E2E __pi_store handle to inject the states.
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
  if (!condition) throw new Error(`toast-dismiss-probe failed: ${message}`);
}

assert(existsSync(path.join(appRoot, 'dist/index.html')), 'app is not built — run `pnpm build`');

const home = mkdtempSync(path.join(tmpdir(), 'pi-e2e-home-'));
const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'));

const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${userDataDir}`],
  env: { ...process.env, HOME: home, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});

try {
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 12000 });

  const piStopped = page.locator('li.pd-toast:has-text("Pi stopped")');
  const bridgeExited = () => page.evaluate(() => window.__pi_store().getState().bridgeExited);

  // ── Bridge-exit "Pi stopped" toast: X dismisses + stays gone ────────────────
  await page.evaluate(() =>
    window.__pi_store().setState({ bridgeExited: { code: 1, signal: null } }),
  );
  await piStopped.waitFor({ state: 'visible', timeout: 5000 });

  await piStopped.locator('button[aria-label="Dismiss notification"]').click();
  await piStopped.waitFor({ state: 'detached', timeout: 5000 });
  assert((await bridgeExited()) === null, 'bridgeExited not cleared after dismiss');

  // Doesn't immediately reappear (no re-emit without a new bridge-exit event).
  await new Promise((r) => setTimeout(r, 800));
  assert((await piStopped.count()) === 0, '"Pi stopped" toast reappeared after dismiss');
  assert((await bridgeExited()) === null, 'bridgeExited re-set itself after dismiss');

  // ── Error toast: X dismisses + removes it from the store ────────────────────
  await page.evaluate(() =>
    window.__pi_store().setState({
      notifications: [{ id: 'probe-err', level: 'error', message: 'boom', timestamp: Date.now() }],
    }),
  );
  const errToast = page.locator('li.pd-toast:has-text("boom")');
  await errToast.waitFor({ state: 'visible', timeout: 5000 });
  await errToast.locator('button[aria-label="Dismiss notification"]').click();
  await errToast.waitFor({ state: 'detached', timeout: 5000 });
  const notifCount = await page.evaluate(() => window.__pi_store().getState().notifications.length);
  assert(notifCount === 0, `error notification not removed after dismiss (count ${notifCount})`);

  console.log(
    'toast-dismiss-probe OK — "Pi stopped" X dismisses + stays gone; error toast X removes it',
  );
} finally {
  await app.close();
}
