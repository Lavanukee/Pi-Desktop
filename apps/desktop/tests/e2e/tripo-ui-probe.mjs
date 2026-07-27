/**
 * Bobble 3D studio UI probe — drives the REAL built app (PI_DESKTOP_TRIPO=1)
 * across the functional overhaul:
 *   - NO bundled placeholder model: the viewport starts empty; a real model
 *     only appears via generation (engine) or import/drop,
 *   - Generate/stages with no engine open the DOWNLOAD PANEL — a full-height
 *     left module with a card + animated capability loop + real size + its own
 *     Download button per model, and Download all,
 *   - multi-image input (unlabeled; no front/back/left/right; image + text tabs),
 *   - drop a GLB → viewport + a REAL rendered preview in Assets,
 *   - render modes (Clay/Textured/Normal) + the wireframe overlay toggle,
 *   - stage panels (segment/retopo/texture) name their engine and, with none
 *     installed, present a "runs on <model>" download card (no fake run),
 *   - Send To real DCC app logos, gizmo under menus, real export formats.
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

// A real GLB (base64) — the drag-and-drop import payload.
const heroTs = readFileSync(path.join(appRoot, 'src/tripo/assets/hero-glb.ts'), 'utf8');
const heroB64 = (heroTs.match(/HERO_MESH_GLB_B64 =\s*'([^']+)'/) ?? [])[1];
assert(heroB64 !== undefined && heroB64.length > 1000, 'extracted GLB b64');

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
    // This is a UI probe: force the "engine not installed" state so the
    // download flow is deterministic regardless of what's installed on the
    // machine (the real sidecar is exercised by gen3d-live-probe.mjs). A
    // nonexistent sidecar dir keeps it from booting, and an empty cache dir
    // makes the TS-side installed probe report nothing installed.
    GEN3D_PY_DIR: '/nonexistent-gen3d-py-dir',
    GEN3D_CACHE_DIR: realpathSync(mkdtempSync(path.join(tmpdir(), 'gen3d-empty-'))),
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
const dropGlb = async () => {
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
};

try {
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.waitForSelector('[data-testid="tp-root"]', { timeout: 15000 });
  await setTheme('bobble', 'dark');

  // ── clean chrome + empty viewport (no placeholder model) ────────────────
  const topbarText = await page.textContent('[data-testid="tp-topbar"]');
  for (const banned of ['Upgrade', 'Affiliate', 'Creator Program', 'DCC Bridge']) {
    assert(!topbarText.includes(banned), `top bar must not contain "${banned}"`);
  }
  const rootText = await page.textContent('[data-testid="tp-root"]');
  for (const banned of ['Members Only', 'GPT Image', 'credits', 'Free Trial', 'sample_creature']) {
    assert(!rootText.includes(banned), `workspace must not contain "${banned}"`);
  }
  assert(await page.isVisible('[data-testid="tp-empty-state"]'), 'empty viewport state');
  await shot('01-default');

  // ── input is image(s)/text only — no labeled multi-view, no gallery ─────
  assert(await page.isVisible('[data-testid="tp-input-tab-image"]'), 'image input tab');
  assert(await page.isVisible('[data-testid="tp-input-tab-text"]'), 'text input tab');
  assert(
    (await page.locator('[data-testid="tp-input-tab-multiview"]').count()) === 0,
    'no labeled multi-view tab',
  );
  assert(await page.isVisible('[data-testid="tp-dropzone"]'), 'image dropzone shown');

  // ── real generation model names ──────────────────────────────────────────
  await page.click('[data-testid="tp-genmodel-btn"]');
  const menuText = await page.textContent('.tp-popover');
  assert(
    menuText.includes('Hunyuan 3D Omni') && menuText.includes('TRELLIS-2'),
    'AI Model lists Hunyuan 3D Omni + TRELLIS-2',
  );
  await page.keyboard.press('Escape');

  // ── Generate without the engine → the DOWNLOAD PANEL (full left module) ──
  await page.click('[data-testid="tp-generate-btn"]');
  await page.waitForSelector('[data-testid="tp-download-panel"]', { timeout: 8000 });
  // The catalog populates asynchronously (engine refresh); wait for the cards.
  await page.waitForSelector('[data-testid="tp-dlcard-trellis2"]', { timeout: 8000 });
  const dlText = await page.textContent('[data-testid="tp-download-panel"]');
  // The roster tracks catalog.ts. 'Hunyuan Paint' and 'AutoRemesher' were the
  // texture and retopo entries when this was written; the texture stage is now
  // a TRELLIS re-bake with no separate model at all, and QuadriFlow replaced
  // AutoRemesher as the primary remesher. Asserting names that no longer exist
  // is how this probe went red on main without anyone noticing.
  for (const expected of ['TRELLIS-2', 'Mage-Flow', 'CubePart', 'QuadriFlow', 'SkinTokens']) {
    assert(dlText.includes(expected), `download panel lists ${expected}`);
  }
  assert(/\d+\.\d GB/.test(dlText), 'download panel shows n.n GB sizes');
  assert(dlText.includes('Download all'), 'download panel offers Download all with total');
  // Each model has its own Download button, and that button is the loudest
  // thing on the card — "Download all · nn GB" is deliberately the quiet one.
  assert(
    (await page.locator('[data-testid^="tp-download-"]').count()) >= 4,
    'per-model Download buttons',
  );
  // No capability loops on the CARDS. At card size they read as broken images
  // (the TRELLIS loop is a near-empty rectangle with one dot); they live in the
  // larger "Runs on <model>" hero instead, which this probe checks below via
  // tp-needs-<id>. Asserting their ABSENCE keeps them from creeping back.
  assert(
    (await page.locator('.tp-dlcard svg.cl').count()) === 0,
    'no capability loops inside the download cards',
  );
  await shot('02-download-panel');
  await page.click('[data-testid="tp-download-back"]');

  // ── drop a GLB → viewport + a REAL rendered preview in Assets ────────────
  await dropGlb();
  await page.waitForSelector('[data-testid="tp-canvas-host"][data-tp-canvas-ready="1"]', {
    timeout: 20000,
  });
  const helpOk = page.locator('[data-testid="tp-help-ok"]');
  if (await helpOk.count()) await helpOk.click();
  // Asset ids are `imported-<session>-<n>` (asset-registry.ts), so match the
  // PREFIX — the hardcoded `imported-1` stopped existing when the per-session
  // component was added, and this probe has been red on main ever since.
  await page.waitForSelector('[data-testid^="tp-asset-imported-"] img.tp-asset-preview', {
    timeout: 12000,
  });
  await shot('03-imported');

  // ── render modes (Clay/Textured/Normal) + the wireframe overlay toggle ───
  for (const mode of ['textured', 'normal', 'clay']) {
    await page.click(`[data-testid="tp-rmode-${mode}"]`);
    await page.waitForFunction(
      (m) => document.querySelector('[data-testid="tp-canvas-host"]')?.dataset.tpRenderMode === m,
      mode,
      { timeout: 5000 },
    );
    if (mode !== 'clay') await shot(`04-mode-${mode}`);
  }
  await page.click('[data-testid="tp-wire-toggle"]');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="tp-canvas-host"]')?.dataset.tpWireframe === '1',
    undefined,
    { timeout: 5000 },
  );
  await shot('04b-wireframe-overlay');
  await page.click('[data-testid="tp-wire-toggle"]');

  // ── stage panels name their engine + present a download card (no fake) ───
  // Names track data.ts: retopo is QuadriFlow now (AutoRemesher is the fallback
  // and keeps the model id), and the texture stage is a TRELLIS-2 re-bake with
  // no separate paint model at all.
  const stages = [
    ['segment', 'CubePart', 'cubepart'],
    ['retopo', 'QuadriFlow', 'autoremesher'],
    ['texture', 'TRELLIS-2', 'trellis2'],
  ];
  for (const [rail, name, modelId] of stages) {
    await page.click(`[data-testid="tp-rail-${rail}"]`);
    const panelText = await page.textContent(`[data-testid="tp-panel-${rail}"]`);
    assert(panelText.includes(name), `${rail} names ${name}`);
    assert(
      await page.isVisible(`[data-testid="tp-needs-${modelId}"]`),
      `${rail} shows the "runs on ${name}" download card`,
    );
    // The primary action IS a download CTA (never a runnable-looking fake).
    const btnText = await page.textContent(`[data-testid="tp-${rail}-btn"]`);
    assert(btnText.includes('Download'), `${rail} action button is a download CTA`);
  }
  // Clicking a stage's CTA opens the download panel focused on its model.
  await page.click('[data-testid="tp-rail-segment"]');
  await page.click('[data-testid="tp-segment-btn"]');
  await page.waitForSelector('[data-testid="tp-download-panel"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="tp-dlcard-cubepart"][data-focus="true"]', {
    timeout: 5000,
  });
  await shot('05-stage-download');
  await page.click('[data-testid="tp-download-back"]');

  // ── animate: the RIG GATE, which is the whole point of this panel ────────
  // This block used to author an ARDY motion and build a state machine over an
  // unrigged model. Both are now deliberately unreachable — jedd asked for the
  // gate explicitly ("a state machine over a model with no skeleton is
  // theatre") — so the assertion is that NOTHING about motion is offered until
  // there is a real rig. The rigged path is covered end to end, on real
  // engines, by tripo-e2e-pipeline-probe.mjs.
  await page.click('[data-testid="tp-rail-animate"]');
  const animText = await page.textContent('[data-testid="tp-panel-animate"]');
  assert(animText.includes('SkinTokens'), 'animate panel names its rig engine');
  assert(
    (await page.locator('[data-testid="tp-anim-grid"]').count()) === 0,
    'no motion library before the model is rigged',
  );
  assert(
    (await page.locator('[data-testid="tp-open-graph"]').count()) === 0,
    'no state-machine launcher before the model is rigged',
  );
  // A browser-dropped GLB has no path on disk, so the engine has nothing to
  // rig FROM and the panel says so rather than offering a button that cannot
  // run (`hasModel` is `version.diskPath !== undefined`, not "a model is
  // loaded").
  assert(
    await page.isVisible('[data-testid="tp-rig-imported-note"]'),
    'a model with no file on disk explains why it cannot be rigged',
  );
  await shot('06-animate');

  // ── Send To: real DCC app logos (needs a loaded model) ──────────────────
  await page.click('[data-testid="tp-sendto-btn"]');
  const sendtoText = await page.textContent('[data-testid="tp-sendto-menu"]');
  for (const appName of ['Blender', 'Maya', '3ds Max', 'Unity', 'Unreal Engine', 'Godot']) {
    assert(sendtoText.includes(appName), `Send To lists ${appName}`);
  }
  const logoCount = await page.locator('[data-testid="tp-sendto-menu"] svg.tp-dcc-logo').count();
  assert(logoCount >= 6, `Send To renders real logo SVGs (got ${logoCount})`);
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
  await page.click('[data-testid="tp-export-close"]');

  // ── light theme re-tint ──────────────────────────────────────────────────
  await setTheme('bobble', 'light');
  await shot('07-light-theme');

  console.log(
    'tripo-ui-probe PASSED — no placeholder, download panel with per-model downloads (and no ' +
      'card-size capability loops), multi-image input, drop-import with rendered previews, ' +
      '3 render modes + wireframe overlay, stage download cards, the animate rig GATE, ' +
      `Send To logos, export. Shots: ${OUT_DIR}`,
  );
} finally {
  await app.close();
}
