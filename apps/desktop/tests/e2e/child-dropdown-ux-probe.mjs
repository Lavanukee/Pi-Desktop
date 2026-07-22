/**
 * A3 + A4 — the child-dropdown UX pass.
 *  - A4: a chat that hosts agents shows NO caret at rest; on hover its bubble is
 *    REPLACED (not shifted) by a fold caret (.pd-chat-icon-swap). Clicking the
 *    ALREADY-focused chat folds/unfolds the dropdown.
 *  - A3: a child that finishes while unviewed shows a blue "finished" dot on its
 *    row; opening the child clears it.
 * Injects a child via __child_store and pins the pi session pointer (mock-pi can't
 * set focus reliably) so the focus-aware toggle is exercised. `npm run build` first.
 */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
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
const OUT_DIR = process.env.CHILD_UX_OUT ?? path.join(tmpdir(), 'child-ux-shots');
mkdirSync(OUT_DIR, { recursive: true });
const assert = (c, m) => {
  if (!c) throw new Error(`child-dropdown-ux-probe failed: ${m}`);
};

const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'pi-e2e-home-')));
const sessionsDir = path.join(home, '.pi', 'agent', 'sessions', 'proj');
mkdirSync(sessionsDir, { recursive: true });
const l = (o) => JSON.stringify(o);
writeFileSync(
  path.join(sessionsDir, 'alpha.jsonl'),
  [
    l({ type: 'session', version: 3, id: 'sess-alpha', timestamp: 't', cwd: '/tmp' }),
    l({
      type: 'message',
      id: 'u1',
      parentId: null,
      timestamp: 't',
      message: { role: 'user', content: 'plan a launch', timestamp: 1 },
    }),
  ].join('\n'),
);

const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'))}`],
  env: { ...process.env, HOME: home, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});

const caretOpacity = () =>
  page.locator('.pd-chat-icon-caret').evaluate((el) => getComputedStyle(el).opacity);

let page;
try {
  page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 8000 });
  await page.waitForFunction(() => window.__child_store !== undefined, { timeout: 8000 });
  // Let mock-pi's launch stream settle, THEN pin the session pointer to the alpha
  // chat + inject a RUNNING child under it (one tick, no further prompts so the pin
  // holds). parentId must be the canonical listed path.
  await page.waitForTimeout(800);
  const parentFile = await page.evaluate(() => {
    return window.piDesktop.invoke('fs:list-sessions', undefined).then((listed) => {
      const file = listed[0]?.file;
      const ps = window.__pi_store().getState();
      window.__pi_store().setState({ session: { ...(ps.session ?? {}), sessionFile: file } });
      const store = window.__child_store.getState();
      store.ensureChild('sub-1', file, 'Research subagent');
      store.replaceMessages('sub-1', [
        { kind: 'user', id: 'g', text: 'Research quantum error correction', timestamp: 1 },
        {
          kind: 'assistant',
          id: 'a1',
          timestamp: 2,
          isStreaming: false,
          blocks: [{ type: 'text', text: 'Surface codes look most promising.' }],
        },
      ]);
      store.setRunning('sub-1', true);
      return file;
    });
  });
  assert(
    typeof parentFile === 'string' && parentFile.length > 0,
    'a listed session to host the child',
  );

  // The dropdown shows the child (running → spinner, no dot yet).
  await page.waitForSelector('[data-testid="child-row-sub-1"]', { timeout: 8000 });
  assert(
    (await page.locator('[data-testid="child-row-sub-1"] .pd-chat-dot--finished').count()) === 0,
    'A3: a still-running child has no finished dot',
  );

  // A4: the hosting chat row has the icon-swap (bubble ↔ caret), caret hidden at rest.
  assert(
    (await page.locator('.pd-chat-icon-swap').count()) === 1,
    'A4: the agent-hosting chat row renders the bubble/caret swap',
  );
  assert(
    (await caretOpacity()) === '0',
    'A4: the fold caret is hidden at rest (no arrow by default)',
  );
  await page.locator('.pd-chat-icon-swap').hover();
  await page.waitForTimeout(220);
  assert(
    (await caretOpacity()) === '1',
    'A4: hovering the row reveals the caret (replacing the bubble)',
  );
  await page.screenshot({ path: path.join(OUT_DIR, '01-hover-caret.png') });

  // A3: the child FINISHES while unviewed → a blue finished dot appears on its row.
  await page.evaluate(() => window.__child_store.getState().setRunning('sub-1', false));
  await page.waitForSelector('[data-testid="child-row-sub-1"] .pd-chat-dot--finished', {
    timeout: 8000,
  });
  // Let the pop-in animation settle so the dot is at full opacity in the shot AND
  // assert it actually rendered visible (not stuck at the animation's opacity-0 start).
  await page.waitForTimeout(400);
  const dotVisible = await page
    .locator('[data-testid="child-row-sub-1"] .pd-chat-dot--finished')
    .evaluate((el) => {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return Number(s.opacity) > 0.9 && r.width > 4 && r.height > 4;
    });
  assert(
    dotVisible,
    'A3: the finished dot is actually visible (opacity + size), not mid-animation',
  );
  await page.screenshot({ path: path.join(OUT_DIR, '02-finished-dot.png') });

  // A4: clicking the ALREADY-focused chat folds the dropdown; clicking again unfolds.
  // (Move off the row first so the earlier hover doesn't confound the click target.)
  const parentRow = page.locator('.pd-sidebar-row', {
    has: page.locator('.pd-chat-icon-swap'),
  });
  await parentRow.click();
  await page.waitForSelector('[data-testid="child-row-sub-1"]', {
    state: 'detached',
    timeout: 8000,
  });
  await parentRow.click();
  await page.waitForSelector('[data-testid="child-row-sub-1"]', { timeout: 8000 });

  // A3: opening the child clears its finished dot.
  await page.click('[data-testid="child-row-sub-1"]');
  await page.waitForSelector('[data-testid="child-chat-view"]', { timeout: 8000 });
  await page.click('[data-testid="child-chat-back"]');
  await page.waitForSelector('[data-testid="child-row-sub-1"]', { timeout: 8000 });
  assert(
    (await page.locator('[data-testid="child-row-sub-1"] .pd-chat-dot--finished').count()) === 0,
    'A3: viewing the child clears its finished dot',
  );

  console.log(
    'child-dropdown-ux-probe OK — A4 hover-caret swap + focused-chat fold toggle; A3 finished dot on a child that completed unviewed, cleared on open',
  );
} finally {
  await app.close();
}
