/**
 * B1 auto-grouping — chats are IMMEDIATELY sorted into a folder for their working
 * directory (no manual step), EXCEPT sandbox chats which stay ungrouped (jedd).
 * A directory-derived folder has NO rename/delete menu (it re-derives from the
 * dir). `npm run build` first.
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
const OUT_DIR = process.env.AUTO_PROJECTS_OUT ?? path.join(tmpdir(), 'auto-projects-shots');
mkdirSync(OUT_DIR, { recursive: true });
const assert = (c, m) => {
  if (!c) throw new Error(`chat-auto-projects-probe failed: ${m}`);
};

const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'pi-e2e-home-')));
const sessionsDir = path.join(home, '.pi', 'agent', 'sessions', 'proj');
mkdirSync(sessionsDir, { recursive: true });
const l = (o) => JSON.stringify(o);
const mkSession = (name, text, cwd) =>
  writeFileSync(
    path.join(sessionsDir, `${name}.jsonl`),
    [
      l({ type: 'session', version: 3, id: `sess-${name}`, timestamp: 't', cwd }),
      l({
        type: 'message',
        id: 'u1',
        parentId: null,
        timestamp: 't',
        message: { role: 'user', content: text, timestamp: 1 },
      }),
    ].join('\n'),
  );
// One chat in a real project folder → auto-folder "GeometryDash"; one in the
// per-conversation sandbox → stays ungrouped.
mkSession('work', 'build the game', path.join(home, 'work', 'GeometryDash'));
mkSession('sand', 'quick question', path.join(home, '.pi/desktop/sandbox', 'conv-x'));

const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'))}`],
  env: { ...process.env, HOME: home, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});

let page;
try {
  page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 10000 });

  // The real-cwd chat is auto-grouped into a "GeometryDash" folder (no manual step).
  const autoRow = page.locator('[data-testid^="project-row-cwd:"]');
  await autoRow.waitFor({ timeout: 10000 });
  assert(
    (await autoRow.textContent())?.includes('GeometryDash'),
    'the working directory becomes a folder named by its basename',
  );
  await page.waitForSelector(
    '[data-testid^="project-chats-cwd:"] [data-testid="chat-row-build the game"]',
    { timeout: 8000 },
  );

  // A directory-derived folder has NO 3-dot menu (it re-derives from the dir).
  assert(
    (await page.locator('[data-testid^="project-menu-cwd:"]').count()) === 0,
    'auto folders expose no rename/delete menu',
  );

  // The sandbox chat stays UNGROUPED (in the plain Chats list, not a folder).
  await page.waitForSelector('[data-testid="chat-row-quick question"]', { timeout: 8000 });
  const sandInProject = await page
    .locator('[data-testid^="project-chats-"] [data-testid="chat-row-quick question"]')
    .count();
  assert(sandInProject === 0, 'the sandbox chat is not put in any folder');

  await page.screenshot({ path: path.join(OUT_DIR, '01-auto-grouping.png') });
  console.log(
    'chat-auto-projects-probe OK — a working-directory chat auto-folders into "GeometryDash" (no menu, immediate); a sandbox chat stays ungrouped',
  );
} finally {
  await app.close();
}
