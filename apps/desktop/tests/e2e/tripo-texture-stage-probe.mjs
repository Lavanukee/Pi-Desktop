/**
 * Does the standalone TEXTURE STAGE work through the real UI?
 *
 * Texturing used to be Hunyuan Paint (11.4 GB of weights). It is now TRELLIS
 * re-baking from the voxel colour field the generation saved beside the mesh,
 * which means this stage exercises a chain that nothing else does: the engine
 * has to find `voxels.npz` (from the mesh's own dir or the `sourcePath` the
 * renderer passes), run trellis_worker in --bake-only, and hand back a GLB — no
 * pipeline load, no separate model.
 *
 * Imports an UNTEXTURED geometry.glb from a real job dir, presses the Texture
 * stage's own button, and screenshots the result in Textured mode.
 *
 * Usage: TRIPO_STAGE_GLB=<geometry.glb> node tests/e2e/tripo-texture-stage-probe.mjs
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const GLB = process.env.TRIPO_STAGE_GLB ?? '';
const OUT_DIR = process.env.TRIPO_STAGE_OUT ?? path.join(tmpdir(), 'tripo-texture-stage');
const APP =
  process.env.TRIPO_STAGE_APP ??
  path.resolve(here, '..', '..', 'release', 'mac-arm64', 'Bobble.app', 'Contents', 'MacOS', 'Bobble');
mkdirSync(OUT_DIR, { recursive: true });
if (GLB.length === 0) throw new Error('set TRIPO_STAGE_GLB');

const app = await electron.launch({
  executablePath: APP,
  args: [`--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'))}`],
  env: { ...process.env, HOME: homedir(), PI_E2E: '1', PI_DESKTOP_TRIPO: '1' },
});
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
await win.waitForSelector('[data-testid="tp-rightpanel"]', { timeout: 120_000 });
win.on('console', (m) => {
  if (m.type() === 'error') console.log('[console error]', m.text().slice(0, 200));
});

await win.setInputFiles('[data-testid="tp-upload-card-input"]', GLB);
await win.waitForFunction(() => document.querySelectorAll('.tp-asset-card').length > 0, undefined, {
  timeout: 60_000,
});
await win.waitForTimeout(3000);
await win.screenshot({ path: path.join(OUT_DIR, '01-imported.png') });

await win.click('[data-testid="tp-rail-texture"]');
await win.waitForTimeout(800);
await win.screenshot({ path: path.join(OUT_DIR, '02-texture-panel.png') });

const btn = await win.$('[data-testid="tp-texture-btn"]');
if (btn === null) {
  console.log('FAIL: no texture button');
  await app.close();
  process.exit(1);
}
const label = (await btn.textContent())?.trim() ?? '';
const disabled = await btn.isDisabled();
console.log(`texture button: "${label}"${disabled ? ' (DISABLED)' : ''}`);
if (disabled) {
  console.log('FAIL: the stage cannot run — nothing loaded, or its model reads as missing');
  await app.close();
  process.exit(1);
}
await btn.click();

const t0 = Date.now();
let last = '';
let outcome = 'timeout';
while (Date.now() - t0 < 900_000) {
  const s = await win
    .evaluate(() => {
      const stage = document.querySelector('[data-testid="tp-genstage"]');
      return {
        phase: stage?.getAttribute('data-phase') ?? null,
        failed: stage?.getAttribute('data-failed') === 'true',
        msg: document.querySelector('[data-testid="tp-genstage-msg"]')?.textContent ?? '',
        title: document.querySelector('[data-testid="tp-genstage-title"]')?.textContent ?? '',
        chunks: [...document.querySelectorAll('.tp-chunk')].map(
          (c) => `${c.querySelector('.tp-chunk-label')?.textContent}[${c.getAttribute('data-state')}]`,
        ),
        versions: document.querySelector('[class*="tp-asset-steps"]')?.textContent ?? '1',
      };
    })
    .catch(() => null);
  if (s === null) {
    outcome = 'dead';
    break;
  }
  const line = `${s.chunks.join(' ')} ${s.msg}`;
  if (line !== last && s.msg.length > 0) {
    last = line;
    console.log(`  [${Math.round((Date.now() - t0) / 1000)}s] ${line.slice(0, 110)}`);
  }
  if (s.phase === 'end') {
    outcome = s.failed ? 'FAILED' : 'done';
    break;
  }
  await new Promise((r) => setTimeout(r, 2500));
}

await win.click('[data-testid="tp-rmode-textured"]').catch(() => {});
await win.waitForTimeout(2500);
await win.screenshot({ path: path.join(OUT_DIR, '03-textured.png') });
const end = await win.evaluate(() => ({
  cards: document.querySelectorAll('.tp-asset-card').length,
  versions: document.querySelector('[class*="tp-asset-steps"]')?.textContent ?? '1',
}));
console.log(`\noutcome: ${outcome}   cards: ${end.cards}   versions on the asset: ${end.versions}`);
console.log(`shots in ${OUT_DIR}`);
await app.close().catch(() => {});
