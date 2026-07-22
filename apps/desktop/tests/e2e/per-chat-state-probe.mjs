/**
 * Per-chat state isolation E2E. Seeds two sessions under an isolated HOME, then:
 *   (a) opens chat A → asserts session.sessionFile is pointed at A's exact file
 *       (so the sidebar row highlights + its spinner attach), and adds a
 *       renderer-only marker message to A;
 *   (b) switches to chat B → asserts A's marker doesn't leak + the pointer is B;
 *   (c) returns to A → asserts A is restored FROM THE IN-MEMORY SNAPSHOT (the
 *       marker — absent from disk — is back) and the pointer is A again.
 * Canvas snapshot/restore is covered by canvas-store.test.ts. Run `pnpm build`
 * first. Exit 0 on success, non-zero on any failed assertion.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
  if (!condition) throw new Error(`per-chat-state-probe failed: ${message}`);
}

const home = mkdtempSync(path.join(tmpdir(), 'pi-e2e-home-'));
const sessionsDir = path.join(home, '.pi', 'agent', 'sessions', 'proj');
mkdirSync(sessionsDir, { recursive: true });
const line = (o) => JSON.stringify(o);
const seed = (name, id, userText, asstText) => {
  const file = path.join(sessionsDir, `${name}.jsonl`);
  writeFileSync(
    file,
    [
      line({ type: 'session', version: 3, id, timestamp: 't', cwd: '/tmp' }),
      line({
        type: 'message',
        id: 'u1',
        parentId: null,
        timestamp: 't',
        message: { role: 'user', content: userText, timestamp: 1 },
      }),
      line({
        type: 'message',
        id: 'a1',
        parentId: 'u1',
        timestamp: 't',
        message: { role: 'assistant', content: [{ type: 'text', text: asstText }], timestamp: 1 },
      }),
    ].join('\n'),
  );
  return file;
};
const fileA = seed('alpha', 'sess-alpha', 'chat about apples', 'Apples are great.');
const fileB = seed('beta', 'sess-beta', 'chat about bananas', 'Bananas are great.');

const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'))}`],
  env: { ...process.env, HOME: home, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});

const MARKER = 'MARKER-9f3c-only-in-memory';

try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 8000 });

  // (a) Open chat A; the sidebar-switch must point the store at A's exact file.
  await page.click('text=chat about apples');
  await page.waitForSelector('text=Apples are great.', { timeout: 8000 });
  const fileAfterA = await page.evaluate(() => window.__pi_store().getState().session?.sessionFile);
  assert(fileAfterA === fileA, `after opening A, sessionFile should be A; got ${fileAfterA}`);

  // Append a RENDERER-ONLY marker message to A (never written to disk). If a
  // later return to A shows it, the restore came from the in-memory snapshot —
  // NOT a disk reload (which wouldn't have the marker).
  await page.evaluate((marker) => {
    window.__pi_store().setState((st) => ({
      messages: [
        ...st.messages,
        {
          kind: 'assistant',
          id: 'marker',
          blocks: [{ type: 'text', text: marker }],
          timestamp: Date.now(),
          isStreaming: false,
        },
      ],
    }));
  }, MARKER);

  // (b) Switch to chat B → its own thread; the marker must not leak here.
  await page.click('text=chat about bananas');
  await page.waitForSelector('text=Bananas are great.', { timeout: 8000 });
  const bLeaked = await page.evaluate(
    (marker) =>
      window
        .__pi_store()
        .getState()
        .messages.some((m) => JSON.stringify(m).includes(marker)),
    MARKER,
  );
  assert(!bLeaked, 'B leaked A’s in-memory message');
  const fileAfterB = await page.evaluate(() => window.__pi_store().getState().session?.sessionFile);
  assert(fileAfterB === fileB, `after opening B, sessionFile should be B; got ${fileAfterB}`);

  // (c) Return to A → messages restored FROM SNAPSHOT (marker present) + pointer A.
  await page.click('text=chat about apples');
  await page.waitForSelector('text=Apples are great.', { timeout: 8000 });
  await page.waitForFunction(
    (marker) =>
      window
        .__pi_store()
        .getState()
        .messages.some((m) => JSON.stringify(m).includes(marker)),
    MARKER,
    { timeout: 8000 },
  );
  const st = await page.evaluate(() => ({
    file: window.__pi_store().getState().session?.sessionFile ?? null,
    hasApples: window
      .__pi_store()
      .getState()
      .messages.some((m) => JSON.stringify(m).includes('Apples are great.')),
  }));
  assert(st.hasApples, 'A’s original messages were not restored');
  assert(st.file === fileA, `session.sessionFile should be A's file; got ${st.file}`);

  console.log(
    'per-chat-state-probe OK — session.sessionFile tracks the switched-to chat; an in-memory message is preserved across a round-trip (snapshot restore) and does not leak to the other chat.',
  );
} finally {
  await app.close();
}
