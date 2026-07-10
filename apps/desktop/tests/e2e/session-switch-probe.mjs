/**
 * Session-switch E2E: seeds a pi v3 session JSONL under an isolated HOME, lists
 * it in the sidebar (fs:list-sessions), clicks it, and asserts the thread
 * rehydrates the historical turns (pi:switch-session + fs:read-session +
 * rehydrateSessionJsonl). Run `pnpm build` first.
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
  if (!condition) throw new Error(`session-switch-probe failed: ${message}`);
}

assert(existsSync(path.join(appRoot, 'dist/index.html')), 'app is not built — run `pnpm build`');

// Isolated HOME so fs-handlers reads our seeded sessions, never the real ~/.pi.
const home = mkdtempSync(path.join(tmpdir(), 'pi-e2e-home-'));
const sessionsDir = path.join(home, '.pi', 'agent', 'sessions', 'proj');
mkdirSync(sessionsDir, { recursive: true });
const sessionFile = path.join(sessionsDir, 'seeded.jsonl');
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
  sessionFile,
  [
    line({ type: 'session', version: 3, id: 'seeded-1', timestamp: 't', cwd: '/tmp' }),
    msg('e1', null, 'user', 'what did we discuss earlier'),
    msg('e2', 'e1', 'assistant', 'We discussed the rehydration path.'),
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

  // The seeded session surfaces in the sidebar (title = first user turn).
  await page.waitForSelector('text=what did we discuss earlier', { timeout: 8000 });
  await page.click('text=what did we discuss earlier');

  // Switching rehydrates both turns into the thread.
  await page.waitForSelector('text=We discussed the rehydration path.', { timeout: 8000 });

  const kinds = await page.evaluate(() =>
    window
      .__pi_store()
      .getState()
      .messages.map((m) => m.kind),
  );
  assert(kinds.includes('user') && kinds.includes('assistant'), `unexpected kinds: ${kinds}`);

  console.log(
    'session-switch-probe OK — sidebar switch rehydrated the seeded session into the thread',
  );
} finally {
  await app.close();
}
