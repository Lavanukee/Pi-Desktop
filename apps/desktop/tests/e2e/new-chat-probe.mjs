#!/usr/bin/env node
/**
 * New-chat probe: proves the New-chat action starts a fresh session INSIDE the
 * running pi (new_session RPC) instead of disposing + respawning it — the bug
 * where every new chat killed pi, popped a "Pi stopped / pi exited" crash toast,
 * and bounced a fresh process in the dock.
 *
 * Drives the built app against PI_BIN=mock-pi and asserts, after clicking the
 * real "New chat" row (SessionSidebar → onNewChat → newSession()):
 *   (a) NO _bridge_exit / error toast fires (bridgeExited === null, 0 errors),
 *   (b) pi's pid is UNCHANGED — the same live process (nothing new in the dock),
 *   (c) the rendered thread/messages reset to empty.
 * Then it checks the model-switch/restart seam: a DELIBERATE restart (the flag
 * restartPi() sets before disposing pi) is suppressed, while an unflagged
 * dispose still surfaces the crash toast — so real crashes are unaffected.
 *
 * Run `pnpm build` first, then `node tests/e2e/new-chat-probe.mjs`.
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
  if (!condition) throw new Error(`new-chat-probe failed: ${message}`);
}

assert(
  existsSync(path.join(appRoot, 'dist/index.html')) &&
    existsSync(path.join(appRoot, 'dist-electron/main.js')),
  'app is not built — run `pnpm build` first',
);
assert(existsSync(mockPi), `mock-pi not found at ${mockPi}`);

const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'));
const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${userDataDir}`],
  env: {
    ...process.env,
    PI_BIN: mockPi,
    MOCK_PI_FIXTURE: fixture,
    PI_E2E: '1',
  },
});

try {
  const page = await app.firstWindow();
  await page.waitForSelector('text=Pi Desktop');
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 8000 });

  // The chat UI auto-starts pi on mount; grab the live pid.
  const started = await page.evaluate(() => window.piDesktop.invoke('pi:start', {}));
  assert(
    started.pid > 0 && started.alreadyRunning === true,
    `pi not auto-started: ${JSON.stringify(started)}`,
  );
  const pidBefore = started.pid;

  // Drive one turn so the thread is non-empty before New chat.
  await page.evaluate(() =>
    window.piDesktop.invoke('pi:prompt', { message: 'hello from the probe' }),
  );
  await page.waitForFunction(
    () =>
      window
        .__pi_store()
        .getState()
        .messages.some((m) => m.kind === 'assistant' && m.isStreaming === false),
    { timeout: 10000 },
  );

  // Ensure the sidebar (hence the New chat row) is visible; it auto-collapses
  // on narrow windows (default window is 1080px wide, so it should be open).
  const newChat = page.locator('[data-testid="new-chat"]');
  if (!(await newChat.isVisible().catch(() => false))) {
    await page.click('[aria-label="Open sidebar"]').catch(() => {});
  }
  await newChat.waitFor({ state: 'visible', timeout: 5000 });

  // Clear any stray notifications so the post-click assertion is crisp.
  await page.evaluate(() => window.__pi_store().setState({ notifications: [] }));

  // ── Click the REAL New chat row (onNewChat → newSession()). ──
  await newChat.click();

  // (c) thread/messages reset.
  await page.waitForFunction(() => window.__pi_store().getState().messages.length === 0, {
    timeout: 8000,
  });

  // (b) same pid — no dispose/respawn, so nothing new bounces in the dock.
  const after = await page.evaluate(() => window.piDesktop.invoke('pi:start', {}));
  assert(after.alreadyRunning === true, 'New chat respawned pi (alreadyRunning=false)');
  assert(
    after.pid === pidBefore,
    `pi pid changed on New chat: ${pidBefore} → ${after.pid} (a respawn happened)`,
  );

  // (a) no crash toast / bridge exit fired.
  const clean = await page.evaluate(() => {
    const s = window.__pi_store().getState();
    return {
      bridgeExited: s.bridgeExited,
      errors: s.notifications.filter((n) => n.level === 'error').length,
    };
  });
  assert(clean.bridgeExited === null, 'New chat set bridgeExited — pi was disposed/crashed');
  assert(clean.errors === 0, `New chat surfaced ${clean.errors} error toast(s)`);
  console.log(
    'new-chat-probe: New chat kept pi alive (same pid), reset the thread, no crash toast — OK',
  );

  // ── Model-switch / restart seam: a DELIBERATE restart must not toast. ──
  // restartPi() sets intentionalRestart before dispatching pi:restart; mirror
  // that here (the wrapper isn't reachable from window). The sink consumes the
  // flag ONLY on the (suppressed) bridge-exit, so waiting for it to flip back to
  // false proves the exit WAS routed and suppressed.
  await page.evaluate(() =>
    window
      .__pi_store()
      .setState({ bridgeExited: null, notifications: [], intentionalRestart: true }),
  );
  await page.evaluate(() => window.piDesktop.invoke('pi:restart', {}));
  await page.waitForFunction(() => window.__pi_store().getState().intentionalRestart === false, {
    timeout: 8000,
  });
  const afterRestart = await page.evaluate(() => {
    const s = window.__pi_store().getState();
    return {
      bridgeExited: s.bridgeExited,
      errors: s.notifications.filter((n) => n.level === 'error').length,
    };
  });
  assert(afterRestart.bridgeExited === null, 'intentional restart surfaced the "Pi stopped" toast');
  assert(
    afterRestart.errors === 0,
    `intentional restart surfaced ${afterRestart.errors} error toast(s)`,
  );

  // Contrast: the SAME dispose WITHOUT the flag still toasts, proving a genuine
  // crash is unaffected by the suppression.
  await page.evaluate(() =>
    window
      .__pi_store()
      .setState({ bridgeExited: null, notifications: [], intentionalRestart: false }),
  );
  await page.evaluate(() => window.piDesktop.invoke('pi:restart', {}));
  await page.waitForFunction(() => window.__pi_store().getState().bridgeExited !== null, {
    timeout: 8000,
  });
  console.log(
    'new-chat-probe: intentional restart suppressed the crash toast; an unflagged exit still shows it — OK',
  );

  console.log('new-chat-probe OK');
} finally {
  await app.close();
}
