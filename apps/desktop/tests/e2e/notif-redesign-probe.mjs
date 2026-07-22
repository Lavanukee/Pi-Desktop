/**
 * Notification redesign + bg fixes (N1-N4):
 *   N1: a finished background chat gets a BLUE unread dot on its row (no popout);
 *       clicking the chat clears it.
 *   N2: a background chat's input request does NOT pop the dialog over the viewed
 *       chat; a top banner shows instead + an ORANGE dot on its row.
 *   N3: a queued message on an otherwise-blank chat renders the thread (queued
 *       bubble), not the empty "Pi Desktop" home.
 *   N4: a backgrounded chat with no disk file stays in the sidebar with a spinner.
 * Run `npm run build` first. Screenshots in OUT_DIR.
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

const OUT_DIR = process.env.NOTIF_PROBE_OUT ?? path.join(tmpdir(), 'notif-redesign-shots');
mkdirSync(OUT_DIR, { recursive: true });
const assert = (c, m) => {
  if (!c) throw new Error(`notif-redesign-probe failed: ${m}`);
};

const home = mkdtempSync(path.join(tmpdir(), 'pi-e2e-home-'));
const sessionsDir = path.join(home, '.pi', 'agent', 'sessions', 'proj');
mkdirSync(sessionsDir, { recursive: true });
const l = (o) => JSON.stringify(o);
const seed = (name, id, u, a) =>
  writeFileSync(
    path.join(sessionsDir, `${name}.jsonl`),
    [
      l({ type: 'session', version: 3, id, timestamp: 't', cwd: '/tmp' }),
      l({
        type: 'message',
        id: 'u1',
        parentId: null,
        timestamp: 't',
        message: { role: 'user', content: u, timestamp: 1 },
      }),
      l({
        type: 'message',
        id: 'a1',
        parentId: 'u1',
        timestamp: 't',
        message: { role: 'assistant', content: [{ type: 'text', text: a }], timestamp: 1 },
      }),
    ].join('\n'),
  );
seed('alpha', 'sess-alpha', 'chat about apples', 'Apples are great.');
seed('beta', 'sess-beta', 'chat about bananas', 'Bananas are great.');
const fileA = path.join(sessionsDir, 'alpha.jsonl');

const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'))}`],
  env: { ...process.env, HOME: home, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});

const dotCount = (page, kind) =>
  page.evaluate((k) => document.querySelectorAll(`.pd-chat-dot--${k}`).length, kind);

try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 8000 });
  await page.click('text=chat about bananas'); // view B; A will run in the background
  await page.waitForSelector('text=Bananas are great.', { timeout: 8000 });

  // ── N1: A runs in the background then finishes → BLUE unread dot on A's row.
  await page.evaluate((a) => {
    window.__pi_store().setState(() => ({
      bgRun: {
        sessionFile: a,
        messages: [
          { kind: 'user', id: 'u1', text: 'about apples', timestamp: 1 },
          {
            kind: 'assistant',
            id: 'a1',
            blocks: [{ type: 'text', text: 'Apples are great.' }],
            timestamp: 2,
            isStreaming: false,
          },
        ],
        streaming: true,
        title: 'chat about apples',
      },
    }));
  }, fileA);
  await page.waitForTimeout(100);
  await page.evaluate(() => {
    window.__pi_store().setState((s) => ({ bgRun: { ...s.bgRun, streaming: false } }));
  });
  await page.waitForFunction(() => document.querySelector('.pd-chat-dot--finished') !== null, {
    timeout: 8000,
  });
  assert((await dotCount(page, 'finished')) >= 1, 'A should show a blue finished dot');
  await page.waitForTimeout(400); // let the pop animation settle before the proof shot
  await page.screenshot({ path: path.join(OUT_DIR, '01-finished-dot.png') });

  // Clicking A clears its unread dot.
  await page.click('text=chat about apples');
  await page.waitForSelector('text=Apples are great.', { timeout: 8000 });
  await page.waitForFunction(() => document.querySelector('.pd-chat-dot--finished') === null, {
    timeout: 8000,
  });

  // ── N2: a background chat's input request → NO dialog over the viewed chat, a top
  // banner + an ORANGE dot instead. (Inject a tagged request as the sink would.)
  await page.click('text=chat about bananas');
  await page.waitForSelector('text=Bananas are great.', { timeout: 8000 });
  await page.evaluate((a) => {
    window.__pi_store().setState((s) => ({
      bgRun: { sessionFile: a, messages: [], streaming: true, title: 'chat about apples' },
      uiRequests: [{ id: 'req-1', method: 'confirm', title: 'Delete file?', sessionFile: a }],
      unread: { ...s.unread, [a]: 'needs-input' },
    }));
  }, fileA);
  await page.waitForSelector('[data-testid="input-needed-banner"]', { timeout: 8000 });
  const bannerText = await page.textContent('[data-testid="input-needed-banner"]');
  assert(bannerText.includes('needs your input'), `banner copy: ${bannerText}`);
  // The confirm dialog must NOT be shown (it's tagged for the background chat).
  const dialogShown = await page.evaluate(() => document.body.textContent.includes('Delete file?'));
  assert(!dialogShown, 'a background chat request must not pop the dialog over the viewed chat');
  assert((await dotCount(page, 'needs-input')) >= 1, 'A should show an orange needs-input dot');
  await page.waitForTimeout(400); // let the pop animation settle before the proof shot
  await page.screenshot({ path: path.join(OUT_DIR, '02-input-banner.png') });

  // Reset for N3/N4.
  await page.evaluate(() =>
    window.__pi_store().setState({ bgRun: null, uiRequests: [], unread: {} }),
  );

  // ── N4: a backgrounded chat with NO disk file stays in the sidebar + spins.
  await page.evaluate(() => {
    window.__pi_store().setState((s) => ({
      bgRun: {
        sessionFile: '/tmp/unwritten-newchat.jsonl',
        messages: [],
        streaming: true,
        title: 'Brainstorm session',
      },
    }));
  });
  await page.waitForFunction(() => document.body.textContent.includes('Brainstorm session'), {
    timeout: 8000,
  });
  await page.screenshot({ path: path.join(OUT_DIR, '03-bg-optimistic-row.png') });
  await page.evaluate(() => window.__pi_store().setState({ bgRun: null }));

  // ── N3: a queued message on a blank chat renders the thread, not the home.
  // A bg run keeps it queued (otherwise the level-triggered drain sends it at once).
  await page.click('[data-testid="new-chat"]');
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    window.__pi_store().setState({
      bgRun: { sessionFile: '/tmp/bg.jsonl', messages: [], streaming: true, title: 'Other' },
      queuedSends: [{ text: 'draft me a poem', images: [], reason: { kind: 'busy-same-model' } }],
    });
  });
  await page.waitForSelector('[data-testid="queued-message"]', { timeout: 8000 });
  const homeShown = await page.evaluate(() =>
    document.body.textContent.includes('How can I help you today?'),
  );
  assert(!homeShown, 'a queued message must show the thread (queued bubble), not the empty home');
  await page.screenshot({ path: path.join(OUT_DIR, '04-queued-thread.png') });

  console.log(
    'notif-redesign-probe OK — unread dots (blue/orange), input banner + dialog gate, bg optimistic row, queued thread',
  );
} finally {
  await app.close();
}
