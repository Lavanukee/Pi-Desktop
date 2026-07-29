/**
 * agent-activity-probe.mjs — what a corp run looks like from the user's chair,
 * in the real app, without waiting on a model.
 *
 * The four things jedd asked for after watching one:
 *   1. ONE tab, "Agent activity", not a tab per file and per node;
 *   2. it MORPHS to whatever the agent is doing (file → terminal → page);
 *   3. clicking a subagent row LEAVES YOU IN THE SITUATION ROOM;
 *   4. the terminal APPENDS as output arrives, keeping its scrollback, instead
 *      of resetting and rewriting the buffer on every tick.
 *
 * Worker activity is folded straight into the corp store, which is exactly what
 * the engine's event drain does — so this exercises the real routing, the real
 * controller and the real xterm, and only skips the language model.
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(appRoot, '../../.corp-runs', 'agent-activity');
mkdirSync(OUT, { recursive: true });

const app = await electron.launch({
  executablePath: require('electron'),
  args: [appRoot],
  // ?corphud exposes __corpStore; PI_E2E exposes the canvas controller.
  env: { ...process.env, PI_E2E: '1', PI_E2E_BACKGROUND: '1', PI_DESKTOP_CORP_HUD: '1' },
});

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__corpStore === 'function', { timeout: 30_000 });

  const tabs = () =>
    page.evaluate(() =>
      window.__pi_canvas().getState().tabs.map((t) => ({
        key: t.key,
        kind: t.kind,
        title: t.title,
        subtitle: t.subtitle,
        active: t.id === window.__pi_canvas().getState().activeTabId,
        mirror: t.data?.mirrorText ?? null,
      })),
    );

  // A run starts: a team forms and the situation room opens (what ChatApp does
  // on promotion), then the user pins an engineer.
  await page.evaluate(() => {
    const corp = window.__corpStore;
    const canvas = window.__pi_canvas();
    corp.getState().setTask('t1');
    canvas.upsertTab('situation:t1', {
      kind: 'situation',
      title: 'Situation room',
      situationTaskId: 't1',
    });
    corp.getState().foldEvent({
      type: 'org-chart',
      chart: {
        taskId: 't1',
        nodes: [
          { id: 'ceo', role: 'ceo', name: 'Pi', state: 'working' },
          { id: 'eng-1', role: 'engineer', name: 'Engineer 1', parentId: 'ceo', state: 'working' },
        ],
        edges: [{ from: 'ceo', to: 'eng-1' }],
      },
    });
    corp.getState().selectNode({ id: 'eng-1', role: 'engineer', name: 'Engineer 1', state: 'working' });
  });
  await page.waitForTimeout(400);

  const roomFirst = (await tabs()).find((t) => t.key === 'situation:t1');
  check('clicking a subagent leaves the situation room in front', roomFirst?.active === true,
    JSON.stringify((await tabs()).map((t) => `${t.key}${t.active ? '*' : ''}`)));

  // It writes a file.
  await page.evaluate(() => {
    window.__corpStore.getState().foldWorkerActivity({
      type: 'worker-activity',
      nodeId: 'eng-1',
      kind: 'file',
      path: 'src/engine.py',
      label: 'Writing',
      content: 'def run():\n    return 1\n',
      addedLines: 2,
    });
  });
  await page.waitForTimeout(400);
  let all = await tabs();
  const asFile = all.find((t) => t.key === 'corp:activity');
  check('ONE "Agent activity" tab, showing the file', asFile?.kind === 'file', JSON.stringify(asFile));
  check('its title is stable and the subtitle says what is inside',
    asFile?.title === 'Agent activity' && asFile?.subtitle === 'engine.py',
    `${asFile?.title} / ${asFile?.subtitle}`);
  check('it did NOT steal focus from the room',
    all.find((t) => t.key === 'situation:t1')?.active === true);
  check('no per-file tab appeared alongside it',
    all.filter((t) => t.key?.startsWith('corpfile:')).length === 0,
    JSON.stringify(all.map((t) => t.key)));

  // Then it runs a command — the SAME tab becomes a terminal.
  await page.evaluate(() => {
    window.__corpStore.getState().foldWorkerActivity({
      type: 'worker-activity', nodeId: 'eng-1', kind: 'tool', toolName: 'bash',
      detail: 'python3 -m pytest -q',
    });
  });
  await page.waitForTimeout(400);
  all = await tabs();
  const asTerm = all.find((t) => t.key === 'corp:activity');
  check('the SAME tab morphed into a terminal', asTerm?.kind === 'terminal', JSON.stringify(asTerm?.kind));
  check('a running command shows its prompt line, nothing invented',
    asTerm?.mirror === '$ python3 -m pytest -q\n\n', JSON.stringify(asTerm?.mirror));
  check('still exactly two tabs (room + activity)', all.length === 2,
    JSON.stringify(all.map((t) => t.key)));

  // Output arrives: the mirror must GROW, so the xterm can append it.
  const before = asTerm?.mirror ?? '';
  await page.evaluate(() => {
    window.__corpStore.getState().foldWorkerActivity({
      type: 'worker-activity', nodeId: 'eng-1', kind: 'tool', toolName: 'bash',
      detail: 'python3 -m pytest -q', output: '..\n2 passed in 0.10s',
    });
  });
  await page.waitForTimeout(400);
  const grown = (await tabs()).find((t) => t.key === 'corp:activity')?.mirror ?? '';
  check('output EXTENDS the mirror (so the terminal appends, keeping scrollback)',
    grown.startsWith(before) && grown.length > before.length,
    JSON.stringify(grown));

  // Focus the activity tab and confirm the xterm actually painted the output.
  await page.evaluate(() => {
    const canvas = window.__pi_canvas();
    const tab = canvas.getState().tabs.find((t) => t.key === 'corp:activity');
    if (tab) canvas.focusTab(tab.id);
  });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(OUT, 'activity-terminal.png') });
  // `.xterm` includes the renderer's injected <style>, which contains anything —
  // read the ROWS, which is what is actually on screen.
  const painted = await page.evaluate(
    () => document.querySelector('.xterm-rows')?.textContent ?? '',
  );
  check('the live terminal is actually showing the run', painted.includes('2 passed'),
    painted.slice(0, 120));

  console.log(`\nScreenshots: ${OUT}`);
} finally {
  await app.close().catch(() => {});
}
process.exit(failures === 0 ? 0 : 1);
