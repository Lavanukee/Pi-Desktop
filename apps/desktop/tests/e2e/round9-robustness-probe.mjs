/**
 * Round-9 adversarial E2E — ROBUSTNESS (failure points #12, #13).
 *
 *  #12 CORRUPT / TRUNCATED SESSION JSONL: a session file with a valid header +
 *      turns but a TRUNCATED trailing line (as if the app died mid-write) must
 *      degrade gracefully — the sidebar still lists it, fs:list-sessions doesn't
 *      throw, and switching to it rehydrates the valid turns without crashing
 *      (no white screen).
 *  #13 TINY WINDOW + THEME FLIP MID-STREAM: shrink to a tiny window while an
 *      assistant message is streaming, flip the theme — no layout break (no
 *      horizontal overflow) and no crash (composer stays mounted).
 *
 * Run `pnpm build` first.
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
  if (!condition) throw new Error(`round9-robustness-probe failed: ${message}`);
}

assert(existsSync(path.join(appRoot, 'dist/index.html')), 'app is not built — run `pnpm build`');

// Isolated HOME with a seeded GOOD session + a TRUNCATED (corrupt) session.
const home = mkdtempSync(path.join(tmpdir(), 'pi-e2e-home-'));
const sessionsDir = path.join(home, '.pi', 'agent', 'sessions', 'proj');
mkdirSync(sessionsDir, { recursive: true });
const line = (o) => JSON.stringify(o);
const msg = (id, parentId, role, text) =>
  line({
    type: 'message',
    id,
    parentId,
    timestamp: '2026-07-08T00:00:00.000Z',
    message:
      role === 'user'
        ? { role, content: text, timestamp: 1 }
        : { role, content: [{ type: 'text', text }], timestamp: 1 },
  });

writeFileSync(
  path.join(sessionsDir, 'good.jsonl'),
  [
    line({ type: 'session', version: 3, id: 'good-1', timestamp: 't', cwd: '/tmp' }),
    msg('g1', null, 'user', 'a healthy prior session'),
    msg('g2', 'g1', 'assistant', 'All good here.'),
  ].join('\n'),
);

// A truncated session: valid header + one full turn, then a line cut off
// mid-JSON (as if pi/the app crashed while appending) + trailing garbage.
writeFileSync(
  path.join(sessionsDir, 'corrupt.jsonl'),
  [
    line({ type: 'session', version: 3, id: 'corrupt-1', timestamp: 't', cwd: '/tmp' }),
    msg('c1', null, 'user', 'corrupt marker session'),
    msg('c2', 'c1', 'assistant', 'A partial answer that was'),
    '{"type":"message","id":"c3","parentId":"c2","message":{"role":"assistant","content":[{"type":"text","text":"cut off mid-write',
    '%%% not even json %%%',
  ].join('\n'),
);

const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'));
const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${userDataDir}`],
  env: { ...process.env, HOME: home, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});

try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 8000 });
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 8000 });

  // ── #12 Corrupt session degrades gracefully ─────────────────────────────────
  // fs:list-sessions returns without throwing and includes BOTH sessions.
  const listed = await page.evaluate(() => window.piDesktop.invoke('fs:list-sessions', {}));
  assert(
    Array.isArray(listed),
    'fs:list-sessions did not return an array for a corrupt-session dir',
  );
  assert(listed.length >= 2, `expected both sessions listed, got ${listed.length}`);
  // Both surface in the sidebar; the truncated one is still selectable.
  await page.waitForSelector('text=a healthy prior session', { timeout: 8000 });
  await page.waitForSelector('text=corrupt marker session', { timeout: 8000 });
  // Switching to the truncated session rehydrates the valid turns, no crash.
  await page.click('text=corrupt marker session');
  await page.waitForSelector('text=A partial answer that was', { timeout: 8000 });
  assert(
    (await page.locator('[data-testid="composer-input"]').count()) === 1,
    'app crashed rehydrating a truncated session (composer gone)',
  );

  // ── #13 Tiny window + theme flip mid-stream ─────────────────────────────────
  await page.evaluate(() => {
    const big = Array.from(
      { length: 60 },
      (_, i) => `streaming line ${i} while the window is tiny`,
    ).join('\n');
    window.__pi_store().setState({
      messages: [
        {
          kind: 'assistant',
          id: 'r9-tiny',
          blocks: [{ type: 'text', text: big }],
          timestamp: Date.now(),
          isStreaming: true,
        },
      ],
    });
  });
  const win = await app.browserWindow(page);
  await win.evaluate((w) => w.setBounds({ width: 380, height: 640 }));
  await page.waitForTimeout(300);
  const beforeMode = await page.evaluate(() => document.documentElement.getAttribute('data-mode'));
  // Keep streaming while flipping the theme.
  await page.evaluate(() => {
    const store = window.__pi_store();
    const prev = store.getState().messages[0];
    store.setState({
      messages: [
        {
          ...prev,
          blocks: [{ type: 'text', text: `${prev.blocks[0].text}\nmore mid-stream text` }],
        },
      ],
    });
  });
  // Round-12 #4: the mode toggle lives in the bottom-left profile dropup now.
  await page.click('[data-testid="profile-button"]');
  await page.waitForSelector('[data-testid="profile-menu"]', { timeout: 6000 });
  await page.click('[data-testid="toggle-mode"]');
  await page.waitForFunction(
    (before) => document.documentElement.getAttribute('data-mode') !== before,
    beforeMode,
    { timeout: 6000 },
  );
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  assert(
    overflow <= 2,
    `tiny window overflowed horizontally after theme flip mid-stream, got ${overflow}px`,
  );
  assert(
    (await page.locator('[data-testid="composer-input"]').count()) === 1,
    'app crashed on tiny window + theme flip (composer gone)',
  );

  console.log(
    'round9-robustness-probe OK — a truncated session JSONL degraded gracefully (listed + rehydrated its valid turns, no crash); a tiny window + theme flip mid-stream did not overflow or crash',
  );
} finally {
  await app.close();
}
