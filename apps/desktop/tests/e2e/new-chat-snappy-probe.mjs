/**
 * New-chat snappiness (step 2, symptom a): a brand-new chat has no `.jsonl` until
 * its first turn writes one, so it wouldn't list. The optimistic row makes it show
 * IMMEDIATELY from the live session pointer the moment it has a message — with a
 * spinner while it works — and the real disk row replaces it (same file key) later.
 *
 * Drives it via __pi_store: seed one on-disk chat, open it, then point the store at
 * a NEW (not-on-disk) session with a user message + streaming, and assert a second
 * row appears titled from that message. Run `npm run build` first. Screenshot in OUT_DIR.
 *
 * (Symptom b — the wrong-chat association — is fixed by an epoch bump in
 * switch/newSession that drops a parked pre-dispatch send; it needs a real cold-model
 * park window to race, which mock-pi doesn't have, so it's covered by code review +
 * live testing rather than here.)
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

const OUT_DIR = process.env.SNAPPY_PROBE_OUT ?? path.join(tmpdir(), 'new-chat-snappy-shots');
mkdirSync(OUT_DIR, { recursive: true });
const assert = (c, m) => {
  if (!c) throw new Error(`new-chat-snappy-probe failed: ${m}`);
};

const home = mkdtempSync(path.join(tmpdir(), 'pi-e2e-home-'));
const sessionsDir = path.join(home, '.pi', 'agent', 'sessions', 'proj');
mkdirSync(sessionsDir, { recursive: true });
const line = (o) => JSON.stringify(o);
const fileB = path.join(sessionsDir, 'beta.jsonl');
writeFileSync(
  fileB,
  [
    line({ type: 'session', version: 3, id: 'sess-beta', timestamp: 't', cwd: '/tmp' }),
    line({
      type: 'message',
      id: 'u1',
      parentId: null,
      timestamp: 't',
      message: { role: 'user', content: 'chat about bananas', timestamp: 1 },
    }),
    line({
      type: 'message',
      id: 'a1',
      parentId: 'u1',
      timestamp: 't',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Bananas are great.' }],
        timestamp: 1,
      },
    }),
  ].join('\n'),
);

const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'))}`],
  env: { ...process.env, HOME: home, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});

try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 8000 });
  await page.click('text=chat about bananas');
  await page.waitForSelector('text=Bananas are great.', { timeout: 8000 });

  // The seeded chat is the only row so far.
  const before = await page.$$eval('[class*="pd-sidebar-row"]', (els) => els.length);

  // Point the store at a brand-new (not-on-disk) session with a just-sent message,
  // mid-generation — exactly the state right after hitting send in a New chat.
  await page.evaluate(() => {
    const store = window.__pi_store();
    store.setState((s) => ({
      session: {
        sessionFile: '/tmp/new-unwritten-session.jsonl',
        sessionId: 'sess-new',
        cwd: '/tmp',
      },
      windowTitle: null,
      promptInFlight: false,
      agent: { ...s.agent, isStreaming: true },
      messages: [
        { kind: 'user', id: 'u-new', text: 'Draft a short poem about rivers', timestamp: 1 },
      ],
    }));
  });

  // The optimistic row appears immediately, titled from the message, with a spinner.
  await page.waitForSelector('text=Draft a short poem about rivers', { timeout: 8000 });
  const bananasStillThere = await page.evaluate(() =>
    document.body.textContent.includes('chat about bananas'),
  );
  assert(bananasStillThere, 'the existing on-disk chat should still be listed');
  const after = await page.$$eval('[class*="pd-sidebar-row"]', (els) => els.length);
  assert(after > before, `expected an extra optimistic row; before=${before} after=${after}`);
  await page.screenshot({ path: path.join(OUT_DIR, '01-optimistic-new-row.png') });

  console.log(`new-chat-snappy-probe OK — optimistic row shown; screenshot in ${OUT_DIR}`);
} finally {
  await app.close();
}
