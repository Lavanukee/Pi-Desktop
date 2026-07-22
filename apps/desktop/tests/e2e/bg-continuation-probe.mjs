/**
 * Single-chat background continuation (step 4). A chat that is generating must keep
 * running when you click off it — spinner on its sidebar row — and you must return
 * "as if you never left." Drives the real switchSession via sidebar clicks + injects
 * the streaming state via __pi_store:
 *   1. Chat A is streaming; click chat B → A goes to the BACKGROUND (bgRun, still
 *      streaming), B is shown, A's row keeps a spinner, and B's composer is NOT busy.
 *   2. Simulate A's reply continuing off-screen, then finishing → a "Response
 *      finished" notice pops on A's row (not B's).
 *   3. Click back to A → its CONTINUED reply is there; the bg run is cleared.
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

const OUT_DIR = process.env.BG_PROBE_OUT ?? path.join(tmpdir(), 'bg-continuation-shots');
mkdirSync(OUT_DIR, { recursive: true });
const assert = (c, m) => {
  if (!c) throw new Error(`bg-continuation-probe failed: ${m}`);
};

const home = mkdtempSync(path.join(tmpdir(), 'pi-e2e-home-'));
const sessionsDir = path.join(home, '.pi', 'agent', 'sessions', 'proj');
mkdirSync(sessionsDir, { recursive: true });
const linify = (o) => JSON.stringify(o);
const seed = (name, id, u, a) =>
  writeFileSync(
    path.join(sessionsDir, `${name}.jsonl`),
    [
      linify({ type: 'session', version: 3, id, timestamp: 't', cwd: '/tmp' }),
      linify({
        type: 'message',
        id: 'u1',
        parentId: null,
        timestamp: 't',
        message: { role: 'user', content: u, timestamp: 1 },
      }),
      linify({
        type: 'message',
        id: 'a1',
        parentId: 'u1',
        timestamp: 't',
        message: { role: 'assistant', content: [{ type: 'text', text: a }], timestamp: 1 },
      }),
    ].join('\n'),
  );
seed('alpha', 'sess-alpha', 'chat about rivers', 'Rivers flow.');
seed('beta', 'sess-beta', 'chat about bananas', 'Bananas are great.');

const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'))}`],
  env: { ...process.env, HOME: home, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});

const PARTIAL = 'RIVERS-REPLY-7a3 a river is a flowing';
const CONTINUED = 'CONTINUED-b9 body of fresh water';

try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 8000 });

  // Open A, then inject a mid-stream turn (A is generating).
  await page.click('text=chat about rivers');
  await page.waitForSelector('text=Rivers flow.', { timeout: 8000 });
  await page.evaluate((partial) => {
    window.__pi_store().setState((s) => ({
      agent: { ...s.agent, isStreaming: true },
      windowTitle: 'chat about rivers',
      messages: [
        { kind: 'user', id: 'u1', text: 'tell me about rivers', timestamp: 1 },
        {
          kind: 'assistant',
          id: 'a1',
          blocks: [{ type: 'text', text: partial }],
          timestamp: 2,
          isStreaming: true,
        },
      ],
    }));
  }, PARTIAL);

  // (1) Click B → A backgrounds.
  await page.click('text=chat about bananas');
  await page.waitForSelector('text=Bananas are great.', { timeout: 8000 });
  const afterSwitch = await page.evaluate(() => {
    const st = window.__pi_store().getState();
    return {
      bgFile: st.bgRun?.sessionFile ?? null,
      bgStreaming: st.bgRun?.streaming ?? false,
      viewed: st.session?.sessionFile ?? null,
      viewHasBananas: st.messages.some((m) => JSON.stringify(m).includes('Bananas are great.')),
      viewLeakedPartial: st.messages.some((m) => JSON.stringify(m).includes('RIVERS-REPLY-7a3')),
    };
  });
  assert(
    afterSwitch.bgFile !== null && afterSwitch.bgFile.includes('alpha'),
    `A should be backgrounded; got ${afterSwitch.bgFile}`,
  );
  assert(afterSwitch.bgStreaming === true, 'the backgrounded chat should still be streaming');
  assert(afterSwitch.viewed.includes('beta'), 'should be viewing B');
  assert(afterSwitch.viewHasBananas, 'B content should be shown');
  assert(!afterSwitch.viewLeakedPartial, "A's partial reply must NOT leak into B's view");
  // The viewed chat B is NOT busy — no Stop button.
  const hasStop = await page.evaluate(
    () => document.querySelector('[data-testid="composer-stop"]') !== null,
  );
  assert(
    !hasStop,
    'the viewed (idle) chat must not show a Stop button while A runs in the background',
  );
  await page.screenshot({ path: path.join(OUT_DIR, '01-A-backgrounded-viewing-B.png') });

  // (2) Simulate A's reply CONTINUING off-screen, then finishing.
  await page.evaluate((continued) => {
    window.__pi_store().setState((s) => ({
      bgRun:
        s.bgRun === null
          ? null
          : {
              ...s.bgRun,
              messages: s.bgRun.messages.map((m) =>
                m.kind === 'assistant'
                  ? { ...m, blocks: [{ type: 'text', text: continued }], isStreaming: false }
                  : m,
              ),
              streaming: false,
            },
      agent: { ...s.agent, isStreaming: false },
    }));
  }, CONTINUED);
  await page.waitForSelector('[data-testid="chat-notice"]', { timeout: 8000 });
  const noticeText = await page.textContent('[data-testid="chat-notice"]');
  assert(
    noticeText.includes('rivers') && noticeText.includes('Response finished'),
    `the finished notice should name chat A (rivers); got: ${noticeText}`,
  );
  await page.screenshot({ path: path.join(OUT_DIR, '02-A-finished-notice.png') });

  // (3) Return to A → the continued reply is there; bg run cleared.
  await page.click('text=chat about rivers');
  await page.waitForSelector(`text=${CONTINUED}`, { timeout: 8000 });
  const back = await page.evaluate(() => {
    const st = window.__pi_store().getState();
    return {
      bgRun: st.bgRun,
      hasContinued: st.messages.some((m) => JSON.stringify(m).includes('CONTINUED-b9')),
      viewed: st.session?.sessionFile ?? null,
    };
  });
  assert(back.bgRun === null, 'the background run should be cleared on return');
  assert(back.hasContinued, "A's continued reply should be restored on return");
  assert(back.viewed.includes('alpha'), 'should be viewing A again');
  await page.screenshot({ path: path.join(OUT_DIR, '03-back-in-A-continued.png') });

  console.log(
    `bg-continuation-probe OK — A kept running off-screen + restored on return; ${OUT_DIR}`,
  );
} finally {
  await app.close();
}
