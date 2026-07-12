/**
 * Round-14 E2E (#7): the collapsed left rail no longer "grows + snaps right".
 *
 * The objectively-testable half of the anti-jank fix (the motion itself is
 * owner-validated FEEL): a collapsed RAIL glyph renders at the SAME size as its
 * expanded ROW glyph — both are 16px SVGs riding in an --pd-icon-size centering
 * box — so nothing resizes on collapse. We assert:
 *
 *   1. Every `.pd-rail-btn` wraps its glyph in a `.pd-rail-btn-icon` box (the
 *      keystone contract that makes glyph-x identical by construction).
 *   2. A rail icon's SVG `width`/`height` equal the expanded row icon's (16),
 *      i.e. the collapse no longer changes icon size (was 18 in the rail).
 *
 * Run `pnpm build` first.
 */
import { existsSync, mkdtempSync } from 'node:fs';
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

function assert(condition, message) {
  if (!condition) throw new Error(`round14-sidebar-rail-probe failed: ${message}`);
}

assert(
  existsSync(path.join(appRoot, 'dist/index.html')) &&
    existsSync(path.join(appRoot, 'dist-electron/main.js')),
  'app is not built — run `pnpm build` first',
);

const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'));
const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${userDataDir}`],
  env: { ...process.env, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});

/** The `width` attr of the first SVG under a selector, or null if absent. */
const iconSize = (page, selector) =>
  page.evaluate((sel) => {
    const svg = document.querySelector(`${sel} svg`);
    return svg ? svg.getAttribute('width') : null;
  }, selector);

try {
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 8000 });

  // Expanded: the "New chat" ROW icon size (a SidebarRow → .pd-sidebar-row-icon).
  await page.waitForSelector('[data-testid="new-chat"] svg', { timeout: 8000 });
  const expandedSize = await iconSize(page, '[data-testid="new-chat"]');
  assert(expandedSize === '16', `expanded row icon should be 16px, got ${expandedSize}`);

  // Collapse to the rail.
  await page.click('[data-testid="collapse-sidebar"]');
  await page.waitForSelector('[data-testid="expand-sidebar"]', { timeout: 8000 });
  // Let the width transition settle so measurements are stable.
  await page.waitForFunction(
    () => {
      const el = document.querySelector('.pd-sidebar-slot');
      const w = el ? el.getBoundingClientRect().width : 999;
      return w > 40 && w < 130;
    },
    undefined,
    { timeout: 4000 },
  );

  // 0. The collapsed rail HUGS its icon cluster — it ends well above the window
  //    foot instead of running the full height (canvas/sidebar wave). The panel
  //    (.pd-sidebar[data-open="false"]) is now content-height, not 100%.
  const { railH, winH } = await page.evaluate(() => {
    const el = document.querySelector('.pd-sidebar[data-open="false"]');
    return { railH: el ? el.getBoundingClientRect().height : 0, winH: window.innerHeight };
  });
  assert(railH > 0, 'collapsed rail panel (.pd-sidebar[data-open="false"]) not found');
  assert(
    railH < winH - 120,
    `collapsed rail should be SHORTER than the window (hug its content), got ${Math.round(
      railH,
    )}px of a ${winH}px window`,
  );

  // 1. Every rail button wraps its glyph in the .pd-rail-btn-icon centering box.
  const { total, wrapped } = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('.pd-rail-btn'));
    return {
      total: btns.length,
      wrapped: btns.filter((b) => b.querySelector(':scope > .pd-rail-btn-icon') !== null).length,
    };
  });
  assert(total > 0, 'no .pd-rail-btn found in the collapsed rail');
  assert(
    wrapped === total,
    `every rail button must wrap its glyph in .pd-rail-btn-icon (${wrapped}/${total})`,
  );

  // 2. The rail glyph size equals the expanded row glyph size (16) — no GROW.
  const railSize = await iconSize(page, '.pd-rail [data-testid="new-chat"] .pd-rail-btn-icon');
  assert(railSize === '16', `collapsed rail icon should be 16px, got ${railSize}`);
  assert(
    railSize === expandedSize,
    `rail icon (${railSize}) must equal the expanded row icon (${expandedSize}) — collapse must not resize`,
  );

  console.log('round14-sidebar-rail-probe: OK');
} finally {
  await app.close();
}
