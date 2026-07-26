/**
 * The studio must not clip its own columns when the window is narrow or short.
 *
 * jedd: "right side of the app seems cut off when resizing the window. and the
 * same sort of thing happens to the bottom aswell".
 *
 * CAUSE: .tp-body is a flex row of rail (74) + genpanel (302) + viewport +
 * rightpanel (344). The three chrome columns were `flex-shrink: 0`, i.e. 720px
 * that could not give, against a BrowserWindow whose minWidth is 640. The
 * viewport was the only flexible column and it bottoms out at min-width 0, so
 * past that point the RIGHT PANEL was pushed outside the window and clipped —
 * silently, because .tp is `overflow: hidden` so nothing scrolls to reveal it.
 *
 * This asserts geometry, not looks: every column's right edge must stay inside
 * the window, at each width. It fails on the old CSS and passes on the new.
 */
import { mkdtempSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(APP_ROOT, '../..');

// 760 is the window's own minWidth (main.ts) — the app must survive its own
// floor. 900 is where the old un-shrinkable 720px of chrome left almost no
// viewport. Wider sizes confirm nothing regressed at comfortable widths.
const WIDTHS = [760, 820, 900, 1280];
const HEIGHTS = [480, 900];

let failures = 0;
const fail = (m) => {
  failures++;
  console.error(`  FAIL ${m}`);
};

const app = await electron.launch({
  executablePath: electronBinary,
  args: [APP_ROOT, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-resize-udd-'))}`],
  env: {
    ...process.env,
    HOME: realpathSync(mkdtempSync(path.join(tmpdir(), 'pi-resize-home-'))),
    PI_BIN: path.join(repoRoot, 'packages/engine/tools/mock-pi/mock-pi.mjs'),
    PI_E2E: '1',
    PI_DESKTOP_TRIPO: '1',
    GEN3D_PY_DIR: '/nonexistent-gen3d-py-dir',
    GEN3D_CACHE_DIR: realpathSync(mkdtempSync(path.join(tmpdir(), 'gen3d-empty-'))),
  },
});
const page = await app.firstWindow();
await page.waitForSelector('[data-testid="tp-root"]', { timeout: 30_000 });

for (const width of WIDTHS) {
  for (const height of HEIGHTS) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(250);

    const geo = await page.evaluate(() => {
      const pick = (sel) => {
        const el = document.querySelector(sel);
        if (el === null) return null;
        const r = el.getBoundingClientRect();
        return { left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width) };
      };
      return {
        inner: window.innerWidth,
        innerH: window.innerHeight,
        rail: pick('.tp-rail'),
        panel: pick('.tp-genpanel'),
        viewport: pick('.tp-viewport'),
        right: pick('.tp-rightpanel'),
        docScrollW: document.documentElement.scrollWidth,
      };
    });

    const tag = `${width}x${height}`;
    for (const [name, box] of Object.entries(geo)) {
      if (box === null || typeof box !== 'object') continue;
      // 1px of rounding slack; anything past that is a real overflow.
      if (box.right > geo.inner + 1) {
        fail(`${tag}: .tp-${name} right edge ${box.right} exceeds window ${geo.inner}`);
      }
      if (box.w <= 0) fail(`${tag}: .tp-${name} collapsed to ${box.w}px`);
    }
    if (geo.docScrollW > geo.inner + 1) {
      fail(`${tag}: document overflows horizontally (${geo.docScrollW} > ${geo.inner})`);
    }
    if (failures === 0) {
      console.log(
        `  ok ${tag}  rail ${geo.rail?.w} · panel ${geo.panel?.w} · viewport ${geo.viewport?.w} · right ${geo.right?.w}`,
      );
    }
  }
}

await app.close();
if (failures > 0) {
  console.error(`\ntripo-resize-probe FAILED (${failures})`);
  process.exit(1);
}
console.log('\ntripo-resize-probe OK — no column leaves the window at any tested size');
