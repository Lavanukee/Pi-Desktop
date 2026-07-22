/**
 * MP1 — app-owned child pi instances. Proves the app can spawn a subagent/role
 * as its OWN `pi --mode rpc` instance (not a grandchild of the main pi child) and
 * that its full event stream reaches the renderer tagged with childId — the
 * foundation for rendering it as a nested chat.
 *
 * Uses the real IPC (window.piDesktop.invoke / onEvent) with mock-pi as PI_BIN.
 * `npm run build` first.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
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
  if (!c) throw new Error(`child-agent-probe failed: ${m}`);
};

const home = mkdtempSync(path.join(tmpdir(), 'pi-e2e-home-'));
mkdirSync(path.join(home, '.pi', 'agent', 'sessions', 'proj'), { recursive: true });

const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'))}`],
  env: { ...process.env, HOME: home, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});

try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => window.piDesktop !== undefined, { timeout: 8000 });

  // Subscribe to child events BEFORE spawning.
  await page.evaluate(() => {
    window.__childEvents = [];
    window.piDesktop.onEvent('pi:child-event', (msg) => window.__childEvents.push(msg));
  });

  // Spawn an app-owned child pi instance and drive it with a goal.
  const res = await page.evaluate(() =>
    window.piDesktop.invoke('pi:child-spawn', {
      childId: 'child-1',
      parentId: 'parent-1',
      title: 'Test subagent',
      goal: 'introduce yourself',
    }),
  );
  assert(res.success === true, `spawn should succeed: ${JSON.stringify(res)}`);
  assert(typeof res.pid === 'number', 'spawn should return a real pid (a live pi process)');

  // Its transcript should stream back, tagged with the childId.
  await page.waitForFunction(() => (window.__childEvents ?? []).length > 0, { timeout: 12000 });
  await page.waitForTimeout(800); // let a few events accumulate

  const summary = await page.evaluate(() => {
    const evs = window.__childEvents ?? [];
    return {
      count: evs.length,
      allTaggedC1: evs.every((e) => e.childId === 'child-1' && e.parentId === 'parent-1'),
      types: [...new Set(evs.map((e) => e.event?.type))],
    };
  });
  assert(summary.count > 0, 'child should emit events');
  assert(summary.allTaggedC1, 'every child event must carry its childId/parentId tag');

  // The list endpoint should report the running child.
  const list = await page.evaluate(() => window.piDesktop.invoke('pi:child-list', undefined));
  assert(
    list.children.some((c) => c.childId === 'child-1' && c.title === 'Test subagent'),
    `pi:child-list should report the running child: ${JSON.stringify(list)}`,
  );

  // Dispose it.
  const disposed = await page.evaluate(() =>
    window.piDesktop.invoke('pi:child-dispose', { childId: 'child-1' }),
  );
  assert(disposed.success === true, 'dispose should succeed');

  console.log(
    `child-agent-probe OK — spawned an independent pi (pid ${res.pid}), ${summary.count} tagged events [${summary.types.join(', ')}], listed + disposed`,
  );
} finally {
  await app.close();
}
