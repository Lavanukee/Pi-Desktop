/**
 * B1/B2 — projects grouping + the hover 3-dot chat menu (rename / pin / add to
 * project / delete-with-confirm). Drives the REAL UI: create a project, assign a
 * chat into it, rename a chat inline, and delete a chat through the confirm
 * dialog (verifying the session file is actually removed). `npm run build` first.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
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
const OUT_DIR = process.env.CHAT_PROJECTS_OUT ?? path.join(tmpdir(), 'chat-projects-shots');
mkdirSync(OUT_DIR, { recursive: true });
const assert = (c, m) => {
  if (!c) throw new Error(`chat-projects-probe failed: ${m}`);
};

const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'pi-e2e-home-')));
const sessionsDir = path.join(home, '.pi', 'agent', 'sessions', 'proj');
mkdirSync(sessionsDir, { recursive: true });
const l = (o) => JSON.stringify(o);
// Sandbox cwd → these start UNGROUPED (real cwds now auto-fold; this probe covers
// the MANUAL flow, so keep the chats out of auto folders).
const mkSession = (name, text) =>
  writeFileSync(
    path.join(sessionsDir, `${name}.jsonl`),
    [
      l({
        type: 'session',
        version: 3,
        id: `sess-${name}`,
        timestamp: 't',
        cwd: path.join(home, '.pi/desktop/sandbox', `conv-${name}`),
      }),
      l({
        type: 'message',
        id: 'u1',
        parentId: null,
        timestamp: 't',
        message: { role: 'user', content: text, timestamp: 1 },
      }),
    ].join('\n'),
  );
mkSession('alpha', 'plan a launch');
mkSession('beta', 'fix the bug');

const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'))}`],
  env: { ...process.env, HOME: home, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});

let page;
try {
  page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 10000 });
  await page.waitForSelector('[data-testid="chat-row-plan a launch"]', { timeout: 10000 });
  await page.waitForSelector('[data-testid="chat-row-fix the bug"]', { timeout: 10000 });

  // ── Create a project via the "+" (hover-revealed) → inline rename → "Research".
  await page.click('[data-testid="new-project"]', { force: true });
  const projInput = page.locator('[data-testid^="project-rename-input-"]');
  await projInput.waitFor({ timeout: 8000 });
  await projInput.fill('Research');
  await projInput.press('Enter');
  const projectRow = page.locator('[data-testid^="project-row-"]');
  await projectRow.waitFor({ timeout: 8000 });
  assert((await projectRow.textContent())?.includes('Research'), 'project row shows its name');
  const projTestId = await projectRow.getAttribute('data-testid');
  const projId = projTestId.replace('project-row-', '');

  // ── Assign "plan a launch" to the project via its 3-dot menu → Add to project.
  await page.click('[data-testid="chat-menu-plan a launch"]', { force: true });
  await page.click('text=Add to project');
  await page.click('.pd-menu >> text=Research');
  // The chat now lives under the project group, not the ungrouped Chats list.
  await page.waitForSelector(
    `[data-testid="project-chats-${projId}"] [data-testid="chat-row-plan a launch"]`,
    { timeout: 8000 },
  );
  await page.screenshot({ path: path.join(OUT_DIR, '01-project-grouping.png') });

  // ── Rename "fix the bug" via its menu → Rename → inline input → "Debug notes".
  await page.click('[data-testid="chat-menu-fix the bug"]', { force: true });
  await page.click('.pd-menu >> text=Rename');
  const renameInput = page.locator('[data-testid="chat-rename-input-fix the bug"]');
  await renameInput.waitFor({ timeout: 8000 });
  await renameInput.fill('Debug notes');
  await renameInput.press('Enter');
  await page.waitForSelector('[data-testid="chat-row-Debug notes"]', { timeout: 8000 });

  // ── Pin "Debug notes" → it floats to the top of the ungrouped list.
  await page.click('[data-testid="chat-menu-Debug notes"]', { force: true });
  await page.click('.pd-menu >> text=Pin');
  await page.waitForTimeout(200);

  // ── Delete "Debug notes" via the confirm dialog (+ verify the file is gone).
  const betaFile = path.join(sessionsDir, 'beta.jsonl');
  assert(existsSync(betaFile), 'session file exists before delete');
  await page.click('[data-testid="chat-menu-Debug notes"]', { force: true });
  await page.click('.pd-menu >> text=Delete');
  await page.waitForSelector('[data-testid="delete-chat-dialog"]', { timeout: 8000 });
  await page.screenshot({ path: path.join(OUT_DIR, '02-delete-dialog.png') });
  await page.click('[data-testid="delete-chat-confirm"]');
  await page.waitForSelector('[data-testid="chat-row-Debug notes"]', {
    state: 'detached',
    timeout: 8000,
  });
  // Give the fs delete + re-list a beat, then assert the file is actually removed.
  await page.waitForTimeout(300);
  assert(!existsSync(betaFile), 'the session file is deleted from disk');

  console.log(
    'chat-projects-probe OK — created a project, assigned a chat into it (grouping), renamed a chat inline, pinned it, and deleted it through the confirm dialog (file removed)',
  );
} finally {
  await app.close();
}
