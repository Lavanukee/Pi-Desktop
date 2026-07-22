/**
 * Per-chat canvas continuity (step 3): opening a filetree/browser tab in chat A,
 * switching to another chat, then back to A must PRESERVE those tabs. Previously
 * every user-openable tab kind (browser/filetree/terminal/subagent) was stripped
 * from the per-chat snapshot, so they always vanished.
 *
 * This drives the real CanvasController via __pi_canvas + real switchSession via
 * sidebar clicks: opens a filetree tab (distinctive root label) and a browser tab
 * (distinctive URL) in A, switches to B, switches back to A, and asserts both tabs
 * survived. Run `npm run build` first. Screenshots in OUT_DIR.
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

const OUT_DIR = process.env.CANVAS_PROBE_OUT ?? path.join(tmpdir(), 'canvas-continuity-shots');
mkdirSync(OUT_DIR, { recursive: true });
const assert = (c, m) => {
  if (!c) throw new Error(`canvas-continuity-probe failed: ${m}`);
};

const home = mkdtempSync(path.join(tmpdir(), 'pi-e2e-home-'));
const sessionsDir = path.join(home, '.pi', 'agent', 'sessions', 'proj');
mkdirSync(sessionsDir, { recursive: true });
const linify = (o) => JSON.stringify(o);
const seed = (name, id, u, a) => {
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
};
seed('alpha', 'sess-alpha', 'chat about apples', 'Apples are great.');
seed('beta', 'sess-beta', 'chat about bananas', 'Bananas are great.');

const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'))}`],
  env: { ...process.env, HOME: home, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});

const ROOT = 'ROOTLABEL-9c2';
const URL = 'https://example.com/docs-9c2';

try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 8000 });

  // Open chat A.
  await page.click('text=chat about apples');
  await page.waitForSelector('text=Apples are great.', { timeout: 8000 });

  // Open a filetree tab + a browser tab in A's canvas via the real controller.
  await page.waitForFunction(() => typeof window.__pi_canvas === 'function', { timeout: 8000 });
  await page.evaluate(
    ({ root, url }) => {
      const c = window.__pi_canvas();
      c.openTab({ kind: 'filetree', title: 'Files', fileTreeRootLabel: root, fileTree: [] });
      c.openTab({ kind: 'browser', title: 'Docs', url });
    },
    { root: ROOT, url: URL },
  );
  const opened = await page.evaluate(() =>
    window
      .__pi_canvas()
      .getState()
      .tabs.map((t) => t.kind),
  );
  assert(opened.includes('filetree') && opened.includes('browser'), `tabs not opened: ${opened}`);
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(OUT_DIR, '01-tabs-open-in-A.png') });

  // Switch to B → A's canvas is captured + reset.
  await page.click('text=chat about bananas');
  await page.waitForSelector('text=Bananas are great.', { timeout: 8000 });

  // Switch back to A → the snapshot restores. Both tabs must return.
  await page.click('text=chat about apples');
  await page.waitForSelector('text=Apples are great.', { timeout: 8000 });
  await page.waitForFunction(
    ({ root, url }) => {
      const tabs = window.__pi_canvas().getState().tabs;
      const hasTree = tabs.some((t) => t.kind === 'filetree' && t.fileTreeRootLabel === root);
      const hasBrowser = tabs.some((t) => t.kind === 'browser' && t.url === url);
      return hasTree && hasBrowser;
    },
    { root: ROOT, url: URL },
    { timeout: 8000 },
  );
  const restored = await page.evaluate(() =>
    window
      .__pi_canvas()
      .getState()
      .tabs.map((t) => ({ kind: t.kind, url: t.url, root: t.fileTreeRootLabel })),
  );
  assert(
    restored.some((t) => t.kind === 'filetree' && t.root === ROOT),
    `filetree tab not restored: ${JSON.stringify(restored)}`,
  );
  assert(
    restored.some((t) => t.kind === 'browser' && t.url === URL),
    `browser tab (with URL) not restored: ${JSON.stringify(restored)}`,
  );
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(OUT_DIR, '02-tabs-restored-in-A.png') });

  console.log(
    `canvas-continuity-probe OK — filetree + browser tabs preserved across switch; ${OUT_DIR}`,
  );
} finally {
  await app.close();
}
