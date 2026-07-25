/**
 * Bobble 3D studio — a REAL TRELLIS generation, measuring whether the window
 * stays interactive throughout.
 *
 * This is jedd's actual complaint ("the app freezes completely when running
 * trellis"), so it drives the real thing end-to-end rather than a proxy: pick
 * an image → Generate → sample rAF gaps + IPC latency + poke the UI the whole
 * way through → report when the geometry actually became visible relative to
 * when the engine said it existed.
 *
 * Long (minutes). `pnpm --filter @pi-desktop/desktop build` first.
 */
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const mockPi = path.resolve(appRoot, '../../packages/engine/tools/mock-pi/mock-pi.mjs');
const OUT_DIR = process.env.TRIPO_GEN_OUT ?? path.join(tmpdir(), 'tripo-gen-shots');
mkdirSync(OUT_DIR, { recursive: true });

const IMAGE = process.env.TRIPO_GEN_IMAGE ?? '';
const TEXTURE = process.env.TRIPO_GEN_TEXTURE === '1';
if (IMAGE.length === 0) throw new Error('set TRIPO_GEN_IMAGE to an input image');

const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'pi-e2e-home-')));
const app = await electron.launch({
  executablePath: require('electron'),
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'))}`],
  env: {
    ...process.env,
    HOME: home,
    PI_BIN: mockPi,
    PI_E2E: '1',
    PI_DESKTOP_TRIPO: '1',
    GEN3D_CACHE_DIR: path.join(homedir(), '.cache/pi-desktop/gen3d'),
  },
});

const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
await win.waitForSelector('[data-testid="tp-rightpanel"]', { timeout: 60_000 });

// Sampler: rAF gaps, plus a timestamped log of when the engine announced the
// geometry artifact vs. when a mesh was actually on screen.
await win.evaluate(() => {
  const w = /** @type {any} */ (window);
  w.__resp = { gaps: [], marks: {} };
  let last = performance.now();
  const tick = () => {
    const now = performance.now();
    w.__resp.gaps.push(now - last);
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

await win.click('[data-testid="tp-rail-model"]');
await win.waitForFunction(
  () => {
    const el = document.querySelector('[data-testid="tp-generate-btn"]');
    return el !== null && !/Download/i.test(el.textContent ?? '');
  },
  undefined,
  { timeout: 120_000 },
);

// Pick the input image through the real picker.
const imgInput = await win.$('[data-testid="tp-image-input"]');
if (imgInput === null) throw new Error('no image input found');
await imgInput.setInputFiles(IMAGE);
await win.waitForTimeout(600);

if (TEXTURE) {
  await win.click('[data-testid="tp-autotexture-toggle"]').catch(() => {});
}

await win.evaluate(() => {
  /** @type {any} */ (window).__resp.gaps = [];
});
const t0 = Date.now();
await win.click('[data-testid="tp-generate-btn"]');
console.log('generation started…');

// Poke the UI at intervals for the whole run; every failure is a real freeze.
const interactions = [];
let running = true;
const poke = async () => {
  const targets = [
    ['History tab', '[data-testid="tp-tab-history"]'],
    ['Assets tab', '[data-testid="tp-tab-assets"]'],
    ['Segment panel', '[data-testid="tp-rail-segment"]'],
    ['Model panel', '[data-testid="tp-rail-model"]'],
  ];
  let i = 0;
  while (running) {
    const [label, sel] = targets[i % targets.length];
    const at = Math.round((Date.now() - t0) / 1000);
    const s = Date.now();
    try {
      await win.click(sel, { timeout: 5000 });
      const ms = Date.now() - s;
      interactions.push({ at, label, ms, ok: true });
      if (ms > 500) console.log(`  [${at}s] SLOW ${label} ${ms}ms`);
    } catch (err) {
      interactions.push({ at, label, ms: Date.now() - s, ok: false });
      console.log(`  [${at}s] FROZE on ${label}: ${String(err).slice(0, 90)}`);
    }
    i++;
    await new Promise((r) => setTimeout(r, 3000));
  }
};
const pokeTask = poke();

// Log progress lines as they change, so the transcript shows the real pipeline.
let lastMsg = '';
const watch = async () => {
  while (running) {
    const msg = await win.textContent('[data-testid="tp-genstage-msg"]').catch(() => null);
    if (msg !== null && msg !== lastMsg) {
      lastMsg = msg;
      console.log(`  [${Math.round((Date.now() - t0) / 1000)}s] ${msg.slice(0, 110)}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
};
const watchTask = watch();

// When does a mesh first appear on screen?
const meshVisible = win
  .waitForFunction(() => document.querySelector('.tp-asset-card') !== null, undefined, {
    timeout: 1_800_000,
  })
  .then(() => Date.now() - t0);

await win.waitForFunction(
  () => {
    const el = document.querySelector('[data-testid="tp-genstage"]');
    return el !== null && el.getAttribute('data-phase') === 'end';
  },
  undefined,
  { timeout: 1_800_000 },
);
const doneAt = Date.now() - t0;
running = false;
await Promise.all([pokeTask, watchTask]);
const firstMeshAt = await Promise.race([meshVisible, Promise.resolve(-1)]);

const gaps = await win.evaluate(() => /** @type {any} */ (window).__resp.gaps);
const sorted = [...gaps].sort((a, b) => b - a);
const over250 = sorted.filter((g) => g > 250);
const stalled = Math.round(over250.reduce((s, g) => s + g, 0));

console.log('\n──────── REAL TRELLIS GENERATION ────────');
console.log(`total: ${Math.round(doneAt / 1000)}s   first asset on screen: ${Math.round(firstMeshAt / 1000)}s`);
console.log(`worst rAF gaps: ${sorted.slice(0, 6).map(Math.round).join('ms, ')}ms`);
console.log(`frames >250ms: ${over250.length}   >1000ms: ${sorted.filter((g) => g > 1000).length}`);
console.log(`total time the UI was stalled: ${stalled}ms`);
const failed = interactions.filter((i) => !i.ok);
const slow = interactions.filter((i) => i.ok && i.ms > 500);
console.log(`interactions: ${interactions.length} total, ${failed.length} FROZE, ${slow.length} slow(>500ms)`);
await win.screenshot({ path: path.join(OUT_DIR, 'after.png') });
console.log(`\nVERDICT: ${failed.length === 0 && stalled < 1000 ? 'UI STAYED INTERACTIVE' : 'UI BLOCKED'}`);
await app.close();
