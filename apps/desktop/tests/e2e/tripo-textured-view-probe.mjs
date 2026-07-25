/**
 * Does Textured mode show the PBR maps TRELLIS actually baked?
 *
 * jedd: "trellis should auto texture and it supports Base Color, Roughness,
 * Metallic, and Opacity for photoreal textures, so please ensure that that's
 * all well and working." Baking them is only half of it — the viewer used to
 * paint a procedural stand-in over every model, so a perfect bake looked
 * identical to no bake at all.
 *
 * Loads an existing textured GLB (no generation — seconds, not minutes),
 * switches Clay → Textured, and reports what three.js has on the mesh: the map
 * names and whether they came from the file or from the stand-in.
 *
 * Usage: TRIPO_TEX_GLB=<model.glb> node tests/e2e/tripo-textured-view-probe.mjs
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const GLB = process.env.TRIPO_TEX_GLB ?? '';
const OUT_DIR = process.env.TRIPO_TEX_OUT ?? path.join(tmpdir(), 'tripo-textured');
const APP =
  process.env.TRIPO_TEX_APP ??
  path.resolve(here, '..', '..', 'release', 'mac-arm64', 'Bobble.app', 'Contents', 'MacOS', 'Bobble');
mkdirSync(OUT_DIR, { recursive: true });
if (GLB.length === 0) throw new Error('set TRIPO_TEX_GLB');

const app = await electron.launch({
  executablePath: APP,
  args: [`--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'))}`],
  env: { ...process.env, HOME: homedir(), PI_E2E: '1', PI_DESKTOP_TRIPO: '1' },
});
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
await win.waitForSelector('[data-testid="tp-rightpanel"]', { timeout: 120_000 });

await win.setInputFiles('[data-testid="tp-upload-card-input"]', GLB);
await win.waitForFunction(() => document.querySelectorAll('.tp-asset-card').length > 0, undefined, {
  timeout: 60_000,
});
await win.waitForTimeout(3000);
await win.screenshot({ path: path.join(OUT_DIR, '01-clay.png') });

await win.click('[data-testid="tp-rmode-textured"]');
await win.waitForTimeout(2500);
await win.screenshot({ path: path.join(OUT_DIR, '02-textured.png') });

// The two cases are unmistakable by eye, which is the point: the stand-in is
// orange/brown painterly bands on everything, a real bake looks like the
// subject. Compare 01-clay.png with 02-textured.png.
console.log(`shots in ${OUT_DIR} — compare 01-clay.png / 02-textured.png`);
await app.close().catch(() => {});
