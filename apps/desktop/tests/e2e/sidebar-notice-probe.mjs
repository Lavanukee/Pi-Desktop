/**
 * Sidebar running-spinner + finish/needs-input popout (step 1 redesign). Drives
 * the busy→idle edge via __pi_store and screenshots:
 *   (1) a running chat: a real Spinner on the RIGHT of its row;
 *   (2) turn ends → the spinner collapses to a small dot + a rectangular
 *       "Response finished" popout floats to the right with Dismiss/View + a fill bar;
 *   (3) same, but a pending uiRequest → an amber "Needs your input" popout.
 * Asserts the popout + its buttons exist and NO fake "<title> finished" chat row is
 * rendered. Run `npm run build` first. Screenshots land in OUT_DIR (printed).
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

const OUT_DIR = process.env.NOTICE_PROBE_OUT ?? path.join(tmpdir(), 'sidebar-notice-shots');
mkdirSync(OUT_DIR, { recursive: true });
const assert = (c, m) => {
  if (!c) throw new Error(`sidebar-notice-probe failed: ${m}`);
};

const home = mkdtempSync(path.join(tmpdir(), 'pi-e2e-home-'));
const sessionsDir = path.join(home, '.pi', 'agent', 'sessions', 'proj');
mkdirSync(sessionsDir, { recursive: true });
const line = (o) => JSON.stringify(o);
const fileA = path.join(sessionsDir, 'alpha.jsonl');
writeFileSync(
  fileA,
  [
    line({ type: 'session', version: 3, id: 'sess-alpha', timestamp: 't', cwd: '/tmp' }),
    line({
      type: 'message',
      id: 'u1',
      parentId: null,
      timestamp: 't',
      message: { role: 'user', content: 'Tell me about apples', timestamp: 1 },
    }),
    line({
      type: 'message',
      id: 'a1',
      parentId: 'u1',
      timestamp: 't',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Apples are great.' }], timestamp: 1 },
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
  await page.click('text=Tell me about apples');
  await page.waitForSelector('text=Apples are great.', { timeout: 8000 });

  // (1) Running: spinner on the RIGHT of the row.
  await page.evaluate(() => {
    window.__pi_store().setState((s) => ({ agent: { ...s.agent, isStreaming: true } }));
  });
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(OUT_DIR, '01-running-spinner.png') });

  // (2) Turn ends → the finished popout.
  await page.evaluate(() => {
    window.__pi_store().setState((s) => ({ agent: { ...s.agent, isStreaming: false } }));
  });
  await page.waitForSelector('[data-testid="chat-notice"]', { timeout: 8000 });
  const noticeText = await page.textContent('[data-testid="chat-notice"]');
  assert(noticeText.includes('Response finished'), `expected finished label; got: ${noticeText}`);
  await page.waitForSelector('[data-testid="chat-notice-dismiss"]', { timeout: 4000 });
  await page.waitForSelector('[data-testid="chat-notice-view"]', { timeout: 4000 });
  // The old fake "<title> finished" pseudo-row must be gone.
  const fakeRow = await page.evaluate(() => document.body.textContent.includes('apples finished'));
  assert(!fakeRow, 'the old fake "<title> finished" row should not exist');
  await page.screenshot({ path: path.join(OUT_DIR, '02-finished-popout.png') });

  // Dismiss it, then drive a needs-input finish.
  await page.click('[data-testid="chat-notice-dismiss"]');
  await page.waitForSelector('[data-testid="chat-notice"]', { state: 'detached', timeout: 4000 });

  // (3) needs-input: a pending uiRequest present at the busy→idle edge → amber
  // "Needs your input". Set the request + streaming true, then clear streaming and
  // immediately drop the request (the notice keeps the kind captured at the edge).
  await page.evaluate(() => {
    window.__pi_store().setState((s) => ({
      agent: { ...s.agent, isStreaming: true },
      uiRequests: [{ id: 'probe-req', kind: 'confirm', prompt: 'ok?' }],
    }));
  });
  await page.waitForTimeout(120);
  await page.evaluate(() => {
    window.__pi_store().setState((s) => ({ agent: { ...s.agent, isStreaming: false } }));
  });
  await page.waitForSelector('[data-testid="chat-notice"][data-kind="needs-input"]', {
    timeout: 8000,
  });
  // Drop the request so no blocking dialog lingers over the screenshot.
  await page.evaluate(() => window.__pi_store().setState({ uiRequests: [] }));
  const niText = await page.textContent('[data-testid="chat-notice"]');
  assert(niText.includes('Needs your input'), `expected needs-input label; got: ${niText}`);
  await page.screenshot({ path: path.join(OUT_DIR, '03-needs-input-popout.png') });

  console.log(`sidebar-notice-probe OK — screenshots in ${OUT_DIR}`);
} finally {
  await app.close();
}
