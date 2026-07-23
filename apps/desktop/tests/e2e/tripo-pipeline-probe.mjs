/**
 * Tripo 3D Studio PIPELINE probe — drives the REAL built app (?tripo=1 via
 * PI_DESKTOP_TRIPO=1) through all four pipeline stages and visually verifies
 * each renders a real result in the three.js viewer:
 *
 *   1. mesh    — click "Generate Model" → the dense generated base mesh.
 *   2. retopo  — Retopo panel → "Start Retopology" → the clean quad remesh
 *                with its quad topology revealed (quad wireframe overlay).
 *   3. rig     — Animate panel → "Generate Rig & Skeleton" → the real three.js
 *                Skeleton overlaid on the mesh (bind pose).
 *   4. animate — pick an animation preset → the rigged SkinnedMesh plays a
 *                baked skeletal clip. Two frames are captured ~500ms apart and
 *                asserted to DIFFER (proves it is actually animating).
 *
 * The stages are backed by two bundled sample GLBs (procedural three.js
 * geometry, not ML-model output) decoded offline via GLTFLoader — see
 * apps/desktop/src/tripo/Viewer3D.tsx. `npm run build` first — this loads dist.
 *
 * Screenshots land in TRIPO_PIPE_OUT (default: tests/e2e/.tripo-pipeline-shots).
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
const OUT_DIR =
  process.env.TRIPO_PIPE_OUT ?? path.join(appRoot, 'tests/e2e/.tripo-pipeline-shots');
mkdirSync(OUT_DIR, { recursive: true });

const assert = (c, m) => {
  if (!c) throw new Error(`tripo-pipeline-probe failed: ${m}`);
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
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`) });
  console.log(`  shot: ${name}.png`);
};
/** Screenshot just the WebGL canvas host, returned as a Buffer for diffing. */
const canvasBuffer = () => page.locator('.tp-canvas-host').screenshot();
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
const stageIs = async (stage) =>
  page.waitForFunction(
    (s) => document.querySelector('.tp-canvas-host')?.dataset.tpStage === s,
    stage,
    { timeout: 8000 },
  );

try {
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.waitForSelector('[data-testid="tp-root"]', { timeout: 15000 });
  await setTheme('claude', 'dark');
  // Keep the model still under the camera for clean, comparable shots.
  const stopTurntable = async () => {
    const btn = page.locator('[data-testid="tp-turntable-btn"]');
    if ((await btn.getAttribute('data-active')) === 'true') await btn.click();
  };

  // ── 1) MESH ─────────────────────────────────────────────────────────────
  await page.click('[data-testid="tp-generate-btn"]');
  // First model landing shows the coach dialog; dismiss it.
  await page.waitForSelector('[data-testid="tp-help-modal"]', { timeout: 5000 });
  await page.click('[data-testid="tp-help-ok"]');
  await page.waitForSelector('.tp-canvas-host[data-tp-canvas-ready="1"]', { timeout: 20000 });
  await stageIs('mesh');
  const canvasSize = await page.evaluate(() => {
    const c = document.querySelector('.tp-canvas-host canvas');
    return c ? { w: c.width, h: c.height } : null;
  });
  assert(canvasSize && canvasSize.w > 100 && canvasSize.h > 100, 'webgl canvas has real size');
  const topo1 = await page.textContent('[data-testid="tp-stats"]');
  assert(topo1.includes('Triangle'), 'mesh stage reports Triangle topology');
  await page.waitForTimeout(400);
  await shot('pipe-1-mesh');

  // ── 2) RETOPO ───────────────────────────────────────────────────────────
  await page.click('[data-testid="tp-rail-retopo"]');
  await page.click('[data-testid="tp-retopo-btn"]');
  await stageIs('retopo');
  await page.waitForTimeout(400);
  const topo2 = await page.textContent('[data-testid="tp-stats"]');
  assert(topo2.includes('Quad'), 'retopo stage reports Quad topology');
  await shot('pipe-2-retopo');

  // ── 3) RIG ──────────────────────────────────────────────────────────────
  await page.click('[data-testid="tp-rail-animate"]');
  await page.click('[data-testid="tp-rig-btn"]');
  await stageIs('rig');
  await page.waitForFunction(
    () => document.querySelector('.tp-canvas-host')?.dataset.tpSkeleton === '1',
    undefined,
    { timeout: 5000 },
  );
  await page.waitForTimeout(400);
  await shot('pipe-3-rig');

  // ── 4) ANIMATE ──────────────────────────────────────────────────────────
  await page.click('[data-testid="tp-anim-wave"]');
  await stageIs('animate');
  await page.waitForFunction(
    () => (document.querySelector('.tp-canvas-host')?.dataset.tpAnim ?? 'none') !== 'none',
    undefined,
    { timeout: 5000 },
  );
  await stopTurntable();
  // clean hero shot: hide the skeleton so the deforming mesh reads on its own
  const skel = page.locator('[data-testid="tp-skeleton-toggle"]');
  await page.waitForTimeout(300);
  await shot('pipe-4-animate-skeleton'); // bones + mesh both moving
  await skel.click(); // toggle skeleton off
  await page.waitForFunction(
    () => document.querySelector('.tp-canvas-host')?.dataset.tpSkeleton === '0',
    undefined,
    { timeout: 5000 },
  );

  // let the controls damping fully settle so ONLY the animation moves pixels
  await page.waitForTimeout(700);
  const frameA = await canvasBuffer();
  await page.waitForTimeout(550);
  const frameB = await canvasBuffer();
  writeFileSync(path.join(OUT_DIR, 'pipe-4-animate-a.png'), frameA);
  writeFileSync(path.join(OUT_DIR, 'pipe-4-animate-b.png'), frameB);
  console.log('  shot: pipe-4-animate-a.png');
  console.log('  shot: pipe-4-animate-b.png');
  const differ = Buffer.compare(frameA, frameB) !== 0;
  assert(differ, 'animation frames differ across time (the mesh is actually animating)');
  // rough magnitude: fraction of differing bytes
  const n = Math.min(frameA.length, frameB.length);
  let diffBytes = 0;
  for (let i = 0; i < n; i++) if (frameA[i] !== frameB[i]) diffBytes++;
  const pct = ((diffBytes / n) * 100).toFixed(1);
  console.log(`  animation frame delta: ${pct}% of bytes differ (a=${frameA.length}b b=${frameB.length}b)`);

  // ── perf: observed rAF frame rate from the viewer's own counter ──────────
  const fps = await page.evaluate(() => Number(document.querySelector('.tp-canvas-host')?.dataset.tpFps ?? 0));
  console.log(`  observed viewer frame rate: ~${fps} fps`);
  assert(fps >= 24, `viewer produces a smooth frame rate (got ${fps})`);

  // ── a couple of extra material / theme looks (still animating) ───────────
  await page.evaluate(() => {
    document.querySelector('[data-testid="tp-mat-gold"]')?.click();
  });
  await page.waitForTimeout(300);
  await shot('pipe-5-gold-material');
  await setTheme('claude', 'light');
  await page.waitForTimeout(300);
  await shot('pipe-6-light-theme');

  console.log(`\ntripo-pipeline-probe PASSED. Screenshots: ${OUT_DIR}`);
} finally {
  await app.close();
}
