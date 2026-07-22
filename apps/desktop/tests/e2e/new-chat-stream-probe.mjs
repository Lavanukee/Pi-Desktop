/**
 * New chat while a reply is still streaming (fix A) + fork/branch dedupe (fix C).
 *
 * A: clicking "New chat" while chat A is mid-reply must NOT dispose A (which popped
 *    a false "Response finished" + a blank reply on return). Instead A goes to the
 *    BACKGROUND (keeps streaming, sidebar spinner), the new chat opens blank, and NO
 *    finished notice fires. The fresh pi session is deferred until the new chat's
 *    first send.
 * C: a fork branch session file must not show as a duplicate sidebar row — the base
 *    chat is the only row (branches live in the in-thread ‹/› switcher).
 * Run `npm run build` first. Screenshot in OUT_DIR.
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

const OUT_DIR = process.env.NEWCHAT_PROBE_OUT ?? path.join(tmpdir(), 'new-chat-stream-shots');
mkdirSync(OUT_DIR, { recursive: true });
const assert = (c, m) => {
  if (!c) throw new Error(`new-chat-stream-probe failed: ${m}`);
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
seed('alpha', 'sess-alpha', 'chat about rivers', 'Rivers flow.');
// A "fork branch" file on disk — must NOT become its own sidebar row (fix C).
seed('alpha-branch', 'sess-alpha-b', 'chat about rivers (edited)', 'Rivers meander.');

const branchFile = path.join(sessionsDir, 'alpha-branch.jsonl');
const baseFile = path.join(sessionsDir, 'alpha.jsonl');

const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'))}`],
  env: { ...process.env, HOME: home, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});

try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 8000 });

  // ── Fix C: register a branch group (base=alpha, branch=alpha-branch). The branch
  // file must be hidden from the sidebar (only the base "chat about rivers" shows).
  await page.evaluate(
    ({ base, branch }) => {
      window.__pi_store().setState({
        branches: { 0: { files: [base, branch], snapshots: [[], []], active: 1 } },
      });
    },
    { base: baseFile, branch: branchFile },
  );
  await page.waitForTimeout(200);
  const branchRowShown = await page.evaluate(() =>
    document.body.textContent.includes('chat about rivers (edited)'),
  );
  assert(!branchRowShown, 'a fork branch file must NOT show as its own sidebar row (fix C)');

  // ── Fix A: open A, inject a mid-stream reply, click New chat.
  await page.click('text=chat about rivers');
  await page.waitForSelector('text=Rivers flow.', { timeout: 8000 });
  await page.evaluate(() => {
    window.__pi_store().setState((s) => ({
      agent: { ...s.agent, isStreaming: true },
      windowTitle: 'chat about rivers',
      messages: [
        { kind: 'user', id: 'u1', text: 'tell me about rivers', timestamp: 1 },
        {
          kind: 'assistant',
          id: 'a1',
          blocks: [{ type: 'text', text: 'A river is a flowing…' }],
          timestamp: 2,
          isStreaming: true,
        },
      ],
    }));
  });

  await page.click('[data-testid="new-chat"]');
  // The new chat is blank; A is backgrounded (still streaming); no finished notice.
  await page.waitForFunction(
    () => {
      const st = window.__pi_store().getState();
      return (
        st.bgRun !== null &&
        st.bgRun.streaming === true &&
        st.bgRun.sessionFile.includes('alpha') &&
        st.messages.length === 0
      );
    },
    { timeout: 8000 },
  );
  const noPrematureFinish = await page.evaluate(
    () => document.querySelector('[data-testid="chat-notice"]') === null,
  );
  assert(
    noPrematureFinish,
    'clicking New chat while streaming must NOT pop a premature "finished" notice (fix A)',
  );
  const hasStop = await page.evaluate(
    () => document.querySelector('[data-testid="composer-stop"]') !== null,
  );
  assert(!hasStop, 'the blank new chat must not show a Stop button while A runs in the background');
  await page.screenshot({ path: path.join(OUT_DIR, '01-new-chat-backgrounds-A.png') });

  console.log(
    'new-chat-stream-probe OK — New chat backgrounds the streaming chat (no dispose, no false finish); branch file hidden',
  );
} finally {
  await app.close();
}
