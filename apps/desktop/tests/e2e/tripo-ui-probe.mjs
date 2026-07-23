/**
 * Bobble 3D studio UI probe — drives the REAL built app (PI_DESKTOP_TRIPO=1)
 * across the redone, de-Tripo'd surface:
 *   - the top bar is minimal (asserts NO promos/credits/nav/DCC-bridge copy),
 *   - real model names (Hunyuan 3D Omni / TRELLIS-2 / CubePart / AutoRemesher /
 *     Hunyuan Paint / SkinTokens / ARDY),
 *   - all four labeled render modes (Clay/Textured/Normal/Wireframe),
 *   - every pipeline section functional (segment parts list, retopo, texture),
 *   - Send To menu with real DCC app logos,
 *   - the gizmo stacking under menus (the dropdown z-index bug),
 *   - drag-and-drop import → viewport + a REAL rendered preview in Assets,
 *   - the export dialog (real exporter formats),
 *   - light-theme re-tint.
 * `npm run build` first — the probe loads dist.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
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

// The bundled sample GLB (base64) — reused as the drag-and-drop payload.
const heroTs = readFileSync(path.join(appRoot, 'src/tripo/assets/hero-glb.ts'), 'utf8');
const heroB64 = (heroTs.match(/HERO_MESH_GLB_B64 =\s*'([^']+)'/) ?? [])[1];
assert(heroB64 !== undefined && heroB64.length > 1000, 'extracted hero GLB b64');

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
  await page.waitForTimeout(350);
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
  await setTheme('bobble', 'dark');

  // ── clean chrome: no promos, credits, nav ballast, or bridge popovers ────
  const topbarText = await page.textContent('[data-testid="tp-topbar"]');
  for (const banned of ['Upgrade', 'Affiliate', 'Creator Program', 'DCC Bridge']) {
    assert(!topbarText.includes(banned), `top bar must not contain "${banned}"`);
  }
  const rootText = await page.textContent('[data-testid="tp-root"]');
  for (const banned of ['Members Only', 'GPT Image', 'credits', 'Free Trial']) {
    assert(!rootText.includes(banned), `workspace must not contain "${banned}"`);
  }
  assert(await page.isVisible('[data-testid="tp-empty-state"]'), 'empty viewport state');
  await shot('01-default');

  // ── real generation model names ──────────────────────────────────────────
  await page.click('[data-testid="tp-genmodel-btn"]');
  const menuText = await page.textContent('.tp-popover');
  assert(
    menuText.includes('Hunyuan 3D Omni') && menuText.includes('TRELLIS-2'),
    'AI Model lists Hunyuan 3D Omni + TRELLIS-2',
  );
  await page.keyboard.press('Escape');

  // ── generate → viewer up ─────────────────────────────────────────────────
  await page.click('[data-testid="tp-generate-btn"]');
  await page.waitForSelector('[data-testid="tp-canvas-host"][data-tp-canvas-ready="1"]', {
    timeout: 20000,
  });
  const helpOk = page.locator('[data-testid="tp-help-ok"]');
  if (await helpOk.count()) await helpOk.click();
  await shot('02-mesh-clay');

  // ── the four labeled render modes ───────────────────────────────────────
  for (const mode of ['textured', 'normal', 'wireframe', 'clay']) {
    await page.click(`[data-testid="tp-rmode-${mode}"]`);
    await page.waitForFunction(
      (m) => document.querySelector('[data-testid="tp-canvas-host"]')?.dataset.tpRenderMode === m,
      mode,
      { timeout: 5000 },
    );
    if (mode !== 'clay') await shot(`03-mode-${mode}`);
  }

  // ── segment (CubePart) → colored parts + list ────────────────────────────
  await page.click('[data-testid="tp-rail-segment"]');
  assert(
    (await page.textContent('[data-testid="tp-panel-segment"]')).includes('CubePart'),
    'segment names CubePart',
  );
  await page.click('[data-testid="tp-segment-btn"]');
  await page.waitForSelector('[data-testid="tp-parts-list"]', { timeout: 8000 });
  await shot('04-segment');

  // ── retopo (AutoRemesher) ────────────────────────────────────────────────
  await page.click('[data-testid="tp-rail-retopo"]');
  assert(
    (await page.textContent('[data-testid="tp-panel-retopo"]')).includes('AutoRemesher'),
    'retopo names AutoRemesher',
  );
  await page.click('[data-testid="tp-retopo-btn"]');
  await shot('05-retopo');

  // ── texture (Hunyuan Paint) → auto-switch to Textured ────────────────────
  await page.click('[data-testid="tp-rail-texture"]');
  assert(
    (await page.textContent('[data-testid="tp-panel-texture"]')).includes('Hunyuan Paint'),
    'texture names Hunyuan Paint',
  );
  await page.click('[data-testid="tp-texture-btn"]');
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="tp-canvas-host"]')?.dataset.tpRenderMode === 'textured',
    undefined,
    { timeout: 5000 },
  );
  await shot('06-texture');

  // ── rig + animate (SkinTokens / ARDY named) ─────────────────────────────
  await page.click('[data-testid="tp-rail-animate"]');
  const animText = await page.textContent('[data-testid="tp-panel-animate"]');
  assert(animText.includes('SkinTokens') && animText.includes('ARDY'), 'rig/anim engines named');
  await page.click('[data-testid="tp-rig-btn"]');
  await shot('07-rig');
  await page.click('[data-testid="tp-anim-wave"]');
  await page.waitForTimeout(800);
  await shot('08-animate');

  // ── Send To: real DCC app logos ──────────────────────────────────────────
  await page.click('[data-testid="tp-sendto-btn"]');
  const sendtoText = await page.textContent('[data-testid="tp-sendto-menu"]');
  for (const appName of ['Blender', 'Maya', '3ds Max', 'Unity', 'Unreal Engine', 'Godot']) {
    assert(sendtoText.includes(appName), `Send To lists ${appName}`);
  }
  const logoCount = await page.locator('[data-testid="tp-sendto-menu"] svg.tp-dcc-logo').count();
  assert(logoCount >= 6, `Send To renders real logo SVGs (got ${logoCount})`);
  await shot('09-sendto-logos');
  await page.keyboard.press('Escape');

  // ── gizmo stacks BELOW menus (the dropdown z-index bug) ──────────────────
  const gz = await page.evaluate(
    () => getComputedStyle(document.querySelector('.tp-gizmo')).zIndex,
  );
  assert(Number(gz) < 80, `gizmo z-index (${gz}) must sit below menus (80)`);

  // ── export dialog: real formats ──────────────────────────────────────────
  await page.click('[data-testid="tp-export-btn"]');
  await page.waitForSelector('[data-testid="tp-export-dialog"]', { timeout: 5000 });
  await page.click('[data-testid="tp-select-exportformat"]');
  const fmtText = await page.textContent('.tp-popover');
  for (const f of ['GLB', 'OBJ', 'STL', 'USDZ']) {
    assert(fmtText.includes(f), `export offers ${f}`);
  }
  await page.keyboard.press('Escape');
  await shot('10-export-dialog');
  await page.click('[data-testid="tp-export-close"]');

  // ── drag-and-drop import: viewport + REAL rendered preview in Assets ─────
  await page.evaluate((b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], 'dropped-model.glb', { type: 'model/gltf-binary' });
    const dt = new DataTransfer();
    dt.items.add(file);
    document
      .querySelector('[data-testid="tp-root"]')
      .dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, heroB64);
  await page.waitForSelector('[data-testid="tp-asset-imported-1"]', { timeout: 8000 });
  await page.waitForSelector('[data-testid="tp-asset-imported-1"] img.tp-asset-preview', {
    timeout: 12000,
  });
  // The sample's thumbnail is a captured render too (no icon artwork anywhere).
  await page.waitForSelector('[data-testid="tp-asset-asset-sample"] img.tp-asset-preview', {
    timeout: 12000,
  });
  await shot('11-dropped-import');

  // ── light theme re-tint ──────────────────────────────────────────────────
  await setTheme('bobble', 'light');
  await shot('12-light-theme');

  console.log(
    'tripo-ui-probe PASSED — clean chrome, real model names, 4 render modes, functional ' +
      'segment/retopo/texture, Send To logos, gizmo under menus, real export formats, ' +
      `dnd import with rendered previews. Screenshots: ${OUT_DIR}`,
  );
} finally {
  await app.close();
}
