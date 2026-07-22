/**
 * MP6 — running corp/hierarchy roles surface in the SAME nested sidebar dropdown
 * under the chat hosting the run (SessionSidebar reads corp-store nodes and renders
 * them beside the child-agent rows; clicking one pins the node so corp's inline
 * view shows it).
 *
 * The rows are gated on `effectiveCurrentFile === s.file` (the same gate as chat-row
 * selection). mock-pi doesn't echo a matching sessionFile and clobbers a pinned one on
 * its next event (the "mock-pi can't verify switching" limitation), so we pin the
 * session AND inject the corp run in ONE tick to beat the clobber, with `taskId: null`
 * so corp's INLINE thread view (which needs a full SituationState) doesn't render.
 * Then the corp rows render, and clicking one pins the node. `npm run build` first.
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

const assert = (c, m) => {
  if (!c) throw new Error(`corp-dropdown-probe failed: ${m}`);
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
      message: { role: 'user', content: 'build the app', timestamp: 1 },
    }),
    l({
      type: 'message',
      id: 'a1',
      parentId: 'u1',
      timestamp: 't',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Assembling a team.' }],
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
  await page.waitForFunction(() => window.__corp_store !== undefined, { timeout: 8000 });
  await page.click('text=build the app');
  await page.waitForSelector('text=Assembling a team.', { timeout: 8000 });

  // Pin the viewed chat's session + inject the corp run in ONE tick, so the pin
  // (needed for effectiveCurrentFile === s.file) isn't clobbered by a mock-pi event
  // before the corp rows render. `taskId: null` keeps corp's INLINE thread view from
  // rendering (it needs a full SituationState) — we only exercise the sidebar rows.
  await page.evaluate(async () => {
    const listed = await window.piDesktop.invoke('fs:list-sessions', undefined);
    const ps = window.__pi_store().getState();
    window.__pi_store().setState({
      session: { ...(ps.session ?? {}), sessionFile: listed[0]?.file },
    });
    window.__corp_store.setState({
      taskId: null,
      corpRunning: true,
      situation: {
        taskId: 't',
        chart: {
          nodes: [
            { id: 'ceo', role: 'ceo', name: 'CEO', state: 'working' },
            { id: 'fe', role: 'engineer', name: 'Frontend', parentId: 'ceo', state: 'working' },
            { id: 'be', role: 'engineer', name: 'Backend', parentId: 'ceo', state: 'done' },
          ],
        },
      },
    });
  });

  // MP6: the corp roles appear in the SAME nested dropdown under the hosting chat.
  await page.waitForSelector('[data-testid="corp-row-fe"]', { timeout: 8000 });
  await page.waitForSelector('[data-testid="corp-row-be"]', { timeout: 8000 });
  const feText = await page.textContent('[data-testid="corp-row-fe"]');
  assert(feText.includes('Frontend'), `corp role row shows its name: ${feText}`);
  await page.screenshot({
    path: path.join(process.env.CORP_DROPDOWN_OUT ?? tmpdir(), '01-corp-roles-dropdown.png'),
  });

  // Clicking a role pins it (corp's inline view then shows that role).
  await page.click('[data-testid="corp-row-fe"]');
  await page.waitForFunction(() => window.__corp_store.getState().pinnedNode?.id === 'fe', {
    timeout: 8000,
  });
  await page.screenshot({
    path: path.join(process.env.CORP_DROPDOWN_OUT ?? tmpdir(), '02-corp-role-pinned.png'),
  });

  console.log(
    'corp-dropdown-probe OK — running corp roles listed in the nested dropdown (MP6); clicking a role pins it for viewing',
  );
} finally {
  await app.close();
}
