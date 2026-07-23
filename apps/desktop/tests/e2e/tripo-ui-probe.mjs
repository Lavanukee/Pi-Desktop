/**
 * Tripo 3D workspace UI probe — drives the REAL built app with ?tripo=1
 * (PI_DESKTOP_TRIPO=1 → devQuery pass-through) and walks every major surface:
 * rail tools + their panels, top-bar menus, the Generate Model stack
 * (input-mode tabs, accordion, privacy, AI model dropdown), loading an asset
 * into the three.js viewer (waits for a REAL rendered frame), material/render
 * strip, display + lighting popovers, export dialog + Send To menu, help
 * modal, Assets manage/filter flows, and the Property hierarchy. Screenshots
 * land in TRIPO_UI_OUT (default: $TMPDIR/tripo-ui-shots) across both flavors
 * and both modes. `npm run build` first — the probe loads dist.
 */
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
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
const OUT_DIR = process.env.TRIPO_UI_OUT ?? path.join(tmpdir(), 'tripo-ui-shots');
mkdirSync(OUT_DIR, { recursive: true });

const assert = (c, m) => {
  if (!c) throw new Error(`tripo-ui-probe failed: ${m}`);
};

const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'pi-e2e-home-')));

const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'))}`],
  env: {
    ...process.env,
    HOME: home,
    PI_BIN: mockPi,
    MOCK_PI_FIXTURE: fixture,
    PI_E2E: '1',
    PI_DESKTOP_TRIPO: '1',
  },
});

let page;
const shot = async (name) => {
  // Menus/dialogs fade in over --pd-duration-menu (200ms); settle first so
  // screenshots capture the resting state, not a mid-animation frame.
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`) });
  console.log(`  shot: ${name}.png`);
};
const setTheme = async (flavor, mode) => {
  await page.evaluate(
    ([f, m]) => {
      document.documentElement.setAttribute('data-flavor', f);
      document.documentElement.setAttribute('data-mode', m);
    },
    [flavor, mode],
  );
  await page.waitForTimeout(120);
};

try {
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.waitForSelector('[data-testid="tp-root"]', { timeout: 15000 });
  await setTheme('claude', 'dark');

  // ── (a) default workspace: Model panel + empty viewport ────────────────
  assert(await page.isVisible('[data-testid="tp-empty-state"]'), 'empty viewport state');
  assert(await page.isVisible('[data-testid="tp-panel-model"]'), 'model panel default');
  assert(await page.isVisible('[data-testid="tp-generate-btn"]'), 'generate button');
  await shot('01-default-model-dark');

  // ── top bar menus open/close ────────────────────────────────────────────
  await page.click('[data-testid="tp-workspace-btn"]');
  assert(await page.isVisible('[data-testid="tp-menu-workspace"]'), 'workspace menu opens');
  await shot('02-menu-workspace');
  await page.click('[data-testid="tp-topbar"]', { position: { x: 600, y: 26 } });
  assert(!(await page.isVisible('[data-testid="tp-menu-workspace"]')), 'workspace menu closes');

  await page.click('[data-testid="tp-dcc-btn"]');
  assert(await page.isVisible('[data-testid="tp-menu-dcc"]'), 'dcc menu');
  await shot('03-menu-dcc');
  await page.click('[data-testid="tp-bell-btn"]');
  assert(await page.isVisible('[data-testid="tp-menu-bell"]'), 'bell menu (replaces dcc)');
  assert(!(await page.isVisible('[data-testid="tp-menu-dcc"]')), 'menus are exclusive');
  await shot('04-menu-bell');
  await page.click('[data-testid="tp-avatar-btn"]');
  assert(await page.isVisible('[data-testid="tp-menu-account"]'), 'account menu');
  await shot('05-menu-account');
  await page.keyboard.press('Escape');
  assert(!(await page.isVisible('[data-testid="tp-menu-account"]')), 'escape closes menu');

  // ── Generate Model panel internals ──────────────────────────────────────
  await page.click('[data-testid="tp-geotex-head"]');
  assert(await page.isVisible('[data-testid="tp-geotex-body"]'), 'geometry&texture accordion');
  await page.click('[data-testid="tp-privacy-head"]');
  await page.click('[data-testid="tp-genmodel-btn"]');
  assert(await page.isVisible('[data-testid="tp-menu-genmodel"]'), 'AI model dropdown');
  await shot('06-model-panel-expanded');
  await page.click('[data-testid="tp-genmodel-v2.5"]');
  const modelLabel = await page.textContent('[data-testid="tp-genmodel-btn"]');
  assert(modelLabel.includes('v2.5'), 'AI model selection sticks');
  await page.click('[data-testid="tp-input-tab-text"]');
  assert(await page.isVisible('[data-testid="tp-prompt"]'), 'text prompt mode');
  await page.fill('[data-testid="tp-prompt"]', 'a weathered bronze astrolabe');
  await shot('07-model-text-mode');
  await page.click('[data-testid="tp-input-tab-multiview"]');
  await shot('08-model-multiview-mode');
  await page.click('[data-testid="tp-input-tab-image"]');

  // ── rail tools: every panel exists ──────────────────────────────────────
  await page.click('[data-testid="tp-rail-segment"]');
  assert(await page.isVisible('[data-testid="tp-panel-segment"]'), 'segment panel');
  assert(await page.isVisible('[data-testid="tp-rail-fillparts"]'), 'rail expands Fill Parts');
  await shot('09-segment-panel');
  await page.click('[data-testid="tp-rail-fillparts"]');
  assert(await page.isVisible('[data-testid="tp-panel-fillparts"]'), 'fill parts panel');
  await page.click('[data-testid="tp-rail-retopo"]');
  await shot('10-retopo-panel');
  await page.click('[data-testid="tp-rail-texture"]');
  assert(await page.isVisible('[data-testid="tp-rail-edit"]'), 'rail expands Texture subs');
  await shot('11-texture-panel');
  await page.click('[data-testid="tp-rail-upscale"]');
  assert(await page.isVisible('[data-testid="tp-panel-upscale"]'), 'upscale panel');
  await page.click('[data-testid="tp-rail-image"]');
  await shot('12-image-panel');
  await page.click('[data-testid="tp-rail-animate"]');
  assert(await page.isVisible('[data-testid="tp-anim-grid"]'), 'animate grid');
  await shot('13-animate-panel');
  await page.click('[data-testid="tp-anim-wave"]');
  await page.fill('[data-testid="tp-anim-search"]', 'ang');
  assert(await page.isVisible('[data-testid="tp-anim-angry_01"]'), 'anim search filters');
  assert(!(await page.isVisible('[data-testid="tp-anim-wave"]')), 'anim search hides misses');
  await page.fill('[data-testid="tp-anim-search"]', '');

  // ── load an asset into the 3D viewer ────────────────────────────────────
  await page.click('[data-testid="tp-asset-asset-boy"] .tp-asset-hit');
  await page.waitForSelector('[data-testid="tp-help-modal"]', { timeout: 5000 });
  await shot('14-help-modal');
  await page.click('[data-testid="tp-help-ok"]');
  await page.waitForSelector('.tp-canvas-host[data-tp-canvas-ready="1"]', { timeout: 20000 });
  assert(await page.isVisible('[data-testid="tp-stats"]'), 'topology stats overlay');
  assert(await page.isVisible('[data-testid="tp-material-strip"]'), 'material strip');
  assert(await page.isVisible('[data-testid="tp-actionbar"]'), 'action bar');
  const canvasSize = await page.evaluate(() => {
    const c = document.querySelector('.tp-canvas-host canvas');
    return c ? { w: c.width, h: c.height } : null;
  });
  assert(canvasSize && canvasSize.w > 100 && canvasSize.h > 100, 'webgl canvas has real size');
  await page.waitForTimeout(400); // a few frames of the render loop
  await shot('15-viewer-loaded-dark');

  // viewer chrome: grid toggle, display popover (wireframe), lighting popover
  await page.click('[data-testid="tp-grid-btn"]');
  await page.click('[data-testid="tp-display-btn"]');
  await page.click('[data-testid="tp-wireframe-toggle"]');
  await page.waitForTimeout(250);
  await shot('16-viewer-wireframe-grid');
  await page.click('[data-testid="tp-wireframe-toggle"]');
  await page.keyboard.press('Escape');
  await page.click('[data-testid="tp-grid-btn"]');
  await page.click('[data-testid="tp-light-btn"]');
  assert(await page.isVisible('[data-testid="tp-menu-lighting"]'), 'lighting popover');
  await shot('17-lighting-popover');
  await page.keyboard.press('Escape');
  await page.click('[data-testid="tp-mat-gold"]');
  await page.waitForTimeout(250);
  await shot('18-material-gold');
  await page.click('[data-testid="tp-history-btn"]');
  assert(await page.isVisible('[data-testid="tp-history-menu"]'), 'history/progress menu');
  await shot('19-history-menu');
  await page.keyboard.press('Escape');

  // ── export dialog + send-to menu ────────────────────────────────────────
  await page.click('[data-testid="tp-export-btn"]');
  assert(await page.isVisible('[data-testid="tp-export-dialog"]'), 'export dialog');
  await page.click('[data-testid="tp-select-exportformat"]');
  await shot('20-export-format-menu');
  await page.keyboard.press('Escape');
  await page.click('[data-testid="tp-sendto-btn"]');
  assert(await page.isVisible('[data-testid="tp-sendto-menu"]'), 'send-to menu');
  const sendToText = await page.textContent('[data-testid="tp-sendto-menu"]');
  for (const target of [
    'Blender',
    '3ds Max',
    'Unity',
    'Unreal',
    'Maya',
    'Cocos',
    'Godot',
    'ZBrush',
    'MetaTailor',
  ]) {
    assert(sendToText.includes(target), `send-to lists ${target}`);
  }
  await shot('21-sendto-menu');
  await page.keyboard.press('Escape');
  await page.click('[data-testid="tp-export-close"]');
  assert(!(await page.isVisible('[data-testid="tp-export-dialog"]')), 'export dialog closes');

  // ── property tab: hierarchy ─────────────────────────────────────────────
  await page.click('[data-testid="tp-tab-property"]');
  assert(await page.isVisible('[data-testid="tp-hierarchy"]'), 'hierarchy tree');
  assert(await page.isVisible('[data-testid="tp-hier-tripo_node_711b6583"]'), 'mesh node row');
  await page.click('[data-testid="tp-hier-menu-root"]');
  await shot('22-property-hierarchy');
  await page.keyboard.press('Escape');
  await page.click('[data-testid="tp-hier-eye-tripo_node_711b6583"]');
  const eyeLabel = await page.getAttribute(
    '[data-testid="tp-hier-eye-tripo_node_711b6583"]',
    'aria-label',
  );
  assert(eyeLabel === 'Show', 'eye toggle hides the mesh node');
  await page.click('[data-testid="tp-hier-eye-tripo_node_711b6583"]');

  // ── assets: filter + manage flows ───────────────────────────────────────
  await page.click('[data-testid="tp-tab-assets"]');
  await page.click('[data-testid="tp-filter-btn"]');
  assert(await page.isVisible('[data-testid="tp-menu-assetfilter"]'), 'filter menu');
  await shot('23-asset-filter-menu');
  await page.click('[data-testid="tp-filter-rigged"]');
  assert(await page.isVisible('[data-testid="tp-asset-asset-boy"]'), 'rigged asset kept');
  assert(!(await page.isVisible('[data-testid="tp-asset-asset-sofa"]')), 'filter hides others');
  await page.click('[data-testid="tp-filter-btn"]');
  await page.click('[data-testid="tp-filter-all"]');
  await page.click('[data-testid="tp-manage-btn"]');
  assert(await page.isVisible('[data-testid="tp-manage-bar"]'), 'manage bar');
  await page.click('[data-testid="tp-asset-asset-sofa"] .tp-asset-hit');
  await shot('24-manage-mode');
  await page.click('[data-testid="tp-manage-delete"]');
  assert(!(await page.isVisible('[data-testid="tp-asset-asset-sofa"]')), 'delete removes card');
  await page.click('[data-testid="tp-asset-info-asset-cottage"]');
  assert(await page.isVisible('[data-testid="tp-menu-assetinfo-asset-cottage"]'), 'info popover');
  await shot('25-asset-info');
  await page.keyboard.press('Escape');

  // ── theme matrix: both flavors × both modes ─────────────────────────────
  await setTheme('claude', 'light');
  await page.waitForTimeout(300);
  await shot('26-viewer-claude-light');
  await setTheme('codex', 'dark');
  await page.waitForTimeout(300);
  await shot('27-viewer-codex-dark');
  await setTheme('codex', 'light');
  await page.waitForTimeout(300);
  await shot('28-viewer-codex-light');
  // default workspace in the other flavor too (panel + empty state coverage)
  await page.click('[data-testid="tp-rail-model"]');
  await shot('29-model-panel-codex-light');
  await setTheme('claude', 'dark');

  console.log(`tripo-ui-probe passed. Screenshots: ${OUT_DIR}`);
} finally {
  await app.close();
}
