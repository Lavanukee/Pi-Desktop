/**
 * Text→3D options: does the panel offer the right controls per shape model?
 *
 * TRELLIS is image→3D, so a text prompt goes through Mage-Flow first and the
 * relevant dials are structure resolution and texture size. Cube3D is natively
 * text→shape: no image hop, no texture at all, and an optional part schema that
 * hands the result to CubePart. Showing either set under the wrong model is a
 * control that silently does nothing, so this checks they swap.
 *
 * Usage: node tests/e2e/tripo-textgen-options-probe.mjs
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = process.env.TRIPO_OPT_OUT ?? path.join(tmpdir(), 'tripo-textgen-options');
const APP =
  process.env.TRIPO_OPT_APP ??
  path.resolve(here, '..', '..', 'release', 'mac-arm64', 'Bobble.app', 'Contents', 'MacOS', 'Bobble');
mkdirSync(OUT_DIR, { recursive: true });

const app = await electron.launch({
  executablePath: APP,
  args: [`--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'))}`],
  env: { ...process.env, HOME: homedir(), PI_E2E: '1', PI_DESKTOP_TRIPO: '1' },
});
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
await win.waitForSelector('[data-testid="tp-rightpanel"]', { timeout: 120_000 });
win.on('console', (m) => {
  if (m.type() === 'error') console.log('[console error]', m.text().slice(0, 180));
});

await win.click('[data-testid="tp-rail-model"]');
await win.waitForTimeout(600);

const seen = () =>
  win.evaluate(() => {
    const has = (t) => document.querySelector(`[data-testid="${t}"]`) !== null;
    return {
      engine: has('tp-engine'),
      resolution: has('tp-resolution'),
      autotexture: has('tp-autotexture-toggle'),
      textureSize: has('tp-texture-size'),
      parts: has('tp-parts-input'),
      cubeNote: has('tp-cube-note'),
    };
  });

// Image mode: no engine picker at all (Cube3D cannot take an image).
const imageMode = await seen();
console.log('image input   :', JSON.stringify(imageMode));

// Switch to text input.
await win.click('[data-testid="tp-input-tab-text"]').catch(async () => {
  await win.click('text=Text to 3D').catch(() => {});
});
await win.waitForTimeout(600);
const textTrellis = await seen();
console.log('text + TRELLIS:', JSON.stringify(textTrellis));
await win.screenshot({ path: path.join(OUT_DIR, '01-text-trellis.png') });

// Switch the shape model to Cube 3D.
await win.click('[data-testid="tp-engine"] >> text=Cube 3D').catch(() => {});
await win.waitForTimeout(600);
const textCube = await seen();
console.log('text + Cube3D :', JSON.stringify(textCube));
await win.screenshot({ path: path.join(OUT_DIR, '02-text-cube3d.png') });

const checks = [
  ['engine picker hidden for image input', !imageMode.engine],
  ['engine picker shown for text input', textTrellis.engine],
  ['TRELLIS shows resolution', textTrellis.resolution],
  ['TRELLIS shows texture size', textTrellis.textureSize],
  ['TRELLIS hides the parts box', !textTrellis.parts],
  ['Cube3D shows the parts box', textCube.parts],
  ['Cube3D explains it has no texture', textCube.cubeNote],
  ['Cube3D hides texture size', !textCube.textureSize],
  ['Cube3D hides auto-texture', !textCube.autotexture],
];
let bad = 0;
for (const [label, ok] of checks) {
  if (!ok) bad += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}`);
}
console.log(`\nVERDICT: ${bad === 0 ? 'controls swap correctly' : `${bad} check(s) failed`}`);
console.log(`shots in ${OUT_DIR}`);
await app.close().catch(() => {});
process.exit(bad === 0 ? 0 : 1);
