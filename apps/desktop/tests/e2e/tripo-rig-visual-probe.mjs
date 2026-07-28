/**
 * tripo-rig-visual-probe.mjs — LOOK at the rigs, in the real viewport.
 *
 * Joint counts and inside-ness numbers do not tell you whether a rig is any
 * good. A skeleton that scores well and still has no arm bones is a thing that
 * has actually happened here. So this loads each rigged GLB into the studio,
 * turns the Skeleton overlay on, and captures the viewport from a few angles —
 * three.js SkeletonHelper drawing the model's OWN bones, which is exactly what
 * the user sees.
 *
 *   RIGS   colon-separated .glb paths (required)
 *   OUT    where the PNGs land
 *   APP    app binary (defaults to the installed Bobble.app)
 *
 * Exits non-zero if a model does not load, or loads without a skeleton.
 */
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { backgroundLaunch } from './_focus.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const RIGS = (process.env.RIGS ?? '').split(':').filter((p) => p.length > 0);
const OUT_DIR =
  process.env.OUT ?? path.resolve(here, '..', '..', '..', '..', '.corp-runs', 'rig-visual');
const APP = process.env.APP ?? '/Applications/Bobble.app/Contents/MacOS/Bobble';

if (RIGS.length === 0) throw new Error('set RIGS to colon-separated .glb paths');
for (const rig of RIGS) if (!existsSync(rig)) throw new Error(`missing ${rig}`);
mkdirSync(OUT_DIR, { recursive: true });

let failed = false;
const fail = (m) => {
  console.log(`  FAIL ${m}`);
  failed = true;
};

const background = backgroundLaunch();
const app = await electron.launch({
  executablePath: APP,
  args: [`--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-rigvis-udd-'))}`],
  env: {
    ...process.env,
    HOME: homedir(),
    PI_E2E: '1',
    PI_DESKTOP_TRIPO: '1',
    // Headed, but never the active app: the window renders (real GPU, honest
    // screenshots) without stealing focus mid-run. FOCUS=1 to opt out.
    ...background.env,
  },
});

try {
  const win = await app.firstWindow();
  background.restore();
  await win.waitForSelector('[data-testid="tp-rightpanel"]', { timeout: 120_000 });
  await win.setViewportSize({ width: 1280, height: 860 });

  for (const rig of RIGS) {
    const name = path.basename(path.dirname(rig));
    console.log(`\n${name} (${path.basename(rig)})`);
    const before = await win.evaluate(() => document.querySelectorAll('.tp-asset-card').length);
    await win.setInputFiles('[data-testid="tp-upload-card-input"]', rig);
    await win.waitForFunction(
      (n) => document.querySelectorAll('.tp-asset-card').length > n,
      before,
      { timeout: 90_000 },
    );
    await win.waitForTimeout(2500);

    // The Skeleton toggle only EXISTS when the loaded model carries bones, so
    // its absence is the finding: the GLB has no skin, or the viewer missed it.
    const toggle = await win.$('[data-testid="tp-skeleton-btn"]');
    if (toggle === null) {
      // Set SKELETON=optional to use this on unrigged models — the same capture
      // is how you check a texture survived a stage.
      if (process.env.SKELETON === 'optional') console.log('  (no rig in this file)');
      else fail(`${name}: no Skeleton toggle — the viewer sees no rig in this file`);
    } else if ((await toggle.getAttribute('data-active')) !== 'true') {
      await toggle.click();
    }
    // Textured, so a stripped texture is visible here too rather than only in a
    // file listing.
    await win.click('[data-testid="tp-rmode-textured"]').catch(() => {});
    await win.waitForTimeout(900);

    const viewport = await win.$('[data-testid="tp-viewport"]');
    await viewport.screenshot({ path: path.join(OUT_DIR, `${name}-front.png`) });

    // Orbit for more angles: a skeleton can look centred head-on and run right
    // down the OUTSIDE of a limb in profile, which is what jedd saw the first
    // time. One drag was not always enough — OrbitControls needs the pointer to
    // settle before it starts tracking, so each turn is stepped and paused.
    const box = await viewport.boundingBox();
    const orbit = async (dx, dy) => {
      await win.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.45);
      await win.mouse.down();
      await win.waitForTimeout(150);
      for (let i = 1; i <= 10; i += 1) {
        await win.mouse.move(
          box.x + box.width * 0.5 + (dx * i) / 10,
          box.y + box.height * 0.45 + (dy * i) / 10,
        );
        await win.waitForTimeout(30);
      }
      await win.mouse.up();
      await win.waitForTimeout(600);
    };
    await orbit(200, 0);
    await viewport.screenshot({ path: path.join(OUT_DIR, `${name}-side.png`) });
    await orbit(200, 0);
    await viewport.screenshot({ path: path.join(OUT_DIR, `${name}-back.png`) });
    console.log(`  captured front + side + back`);
  }
  console.log(`\nimages → ${OUT_DIR}`);
} catch (err) {
  console.error(`tripo-rig-visual-probe: ${err.message}`);
  failed = true;
} finally {
  await app.close().catch(() => {});
}

process.exit(failed ? 1 : 0);
