/**
 * Projects #2/#3 — a sidebar project can carry a working folder, and a
 * projectless project's new chats share a sandbox dir named after the project.
 * Drives the REAL UI + real main process:
 *   - the project 3-dot menu offers "Set working folder…",
 *   - `project:project-sandbox` returns/creates `~/.pi/desktop/sandbox/project-<id>`,
 *   - "+ new chat" in a projectless project roots there, the chat groups under
 *     the project, and the composer folder chip shows the PROJECT NAME (not
 *     "Sandbox"). `npm run build` first.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
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
const OUT_DIR = process.env.CHAT_PROJECT_CWD_OUT ?? path.join(tmpdir(), 'chat-project-cwd-shots');
mkdirSync(OUT_DIR, { recursive: true });
const assert = (c, m) => {
  if (!c) throw new Error(`chat-project-cwd-probe failed: ${m}`);
};

const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'pi-e2e-home-')));
mkdirSync(path.join(home, '.pi', 'agent', 'sessions', 'proj'), { recursive: true });

const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'))}`],
  env: { ...process.env, HOME: home, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});

let page;
try {
  page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 10000 });
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 10000 });

  // ── Create a project "Scratchpad" (no working folder) ──────────────────────
  await page.click('[data-testid="new-project"]', { force: true });
  const projInput = page.locator('[data-testid^="project-rename-input-"]');
  await projInput.waitFor({ timeout: 8000 });
  await projInput.fill('Scratchpad');
  await projInput.press('Enter');
  const projectRow = page.locator('[data-testid^="project-row-"]');
  await projectRow.waitFor({ timeout: 8000 });
  const projId = (await projectRow.getAttribute('data-testid')).replace('project-row-', '');

  // ── The 3-dot menu offers "Set working folder…" (projectless → not "Change") ─
  await page.click(`[data-testid="project-menu-${projId}"]`, { force: true });
  await page.waitForSelector('text=Set working folder…', { timeout: 8000 });
  assert(
    (await page.locator('.pd-menu').textContent())?.includes('Set working folder'),
    'project menu offers "Set working folder…"',
  );
  await page.keyboard.press('Escape');

  // ── project:project-sandbox returns + creates ~/.pi/desktop/sandbox/project-<id>
  const sb = await page.evaluate(
    (id) => window.piDesktop.invoke('project:project-sandbox', { id }),
    projId,
  );
  const expected = path.join(home, '.pi', 'desktop', 'sandbox', `project-${projId}`);
  assert(sb?.path === expected, `project sandbox path is ${expected} (got ${sb?.path})`);
  assert(existsSync(sb.path), 'project sandbox dir was created on disk');

  // ── "+ new chat" in the projectless project → roots at the shared sandbox ────
  await page.click(`[data-testid="project-new-chat-${projId}"]`, { force: true });
  // The restart+newSession settles; wait for the composer to be interactive again.
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 10000 });
  await page.waitForTimeout(600);
  await page.click('[data-testid="composer-input"]');
  await page.keyboard.type('scratch note');
  await page.keyboard.press('Enter');

  // The new chat appears UNDER the project (assignment beats sandbox grouping).
  await page.waitForSelector(
    `[data-testid="project-chats-${projId}"] [data-testid^="chat-row-"]`,
    { timeout: 12000 },
  );
  await page.screenshot({ path: path.join(OUT_DIR, '01-projectless-new-chat.png') });

  // ── The composer folder chip shows the PROJECT NAME, not "Sandbox" ──────────
  const chip = await page
    .locator('.pd-project-picker--bar .pd-project-chip-label')
    .first()
    .textContent();
  assert(chip?.trim() === 'Scratchpad', `folder chip shows the project name (got "${chip}")`);

  console.log(
    'chat-project-cwd-probe OK — projectless project offers "Set working folder", its ' +
      'project:project-sandbox dir is created, a new chat roots there + groups under the ' +
      'project, and the composer chip shows the project name (not "Sandbox").',
  );
} finally {
  await app.close();
}
