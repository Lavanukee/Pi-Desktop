/**
 * Does the renderer DIE during a TRELLIS generation?
 *
 * The user's report — blank solid-colour window, Cmd+R inert, force-quit
 * required — describes a dead render process, not a slow one. This probe drives
 * a REAL generation on the PACKAGED app at 512 (the user's stated repro) and
 * watches for the death rather than for slowness:
 *
 *   - render-process-gone / child-process-gone are recorded by the main process
 *     into <userData>/diagnostics/renderer-health.jsonl (renderer-health.ts),
 *     which survives the window dying. This probe reads it back.
 *   - `webglcontextlost` on the canvas: a GPU reset also paints a blank solid
 *     colour and can wedge the surface without any JS error.
 *   - renderer JS heap over the whole run, so an OOM can be read against the
 *     curve that produced it.
 *   - a liveness beacon: if the page stops answering evaluate() entirely, the
 *     renderer is gone rather than busy.
 *
 * Usage:
 *   TRIPO_CRASH_IMAGE=<image> [TRIPO_CRASH_RES=low|medium|high] \
 *   [TRIPO_CRASH_TEXTURE=1] node tests/e2e/tripo-crash-probe.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';

const IMAGE = process.env.TRIPO_CRASH_IMAGE ?? '';
const RES = process.env.TRIPO_CRASH_RES ?? 'low'; // 'low' == 512
const TEXTURE = process.env.TRIPO_CRASH_TEXTURE === '1';
const APP =
  process.env.TRIPO_CRASH_APP ?? '/Applications/Bobble.app/Contents/MacOS/Bobble';
const OUT_DIR = process.env.TRIPO_CRASH_OUT ?? path.join(tmpdir(), 'tripo-crash-shots');
mkdirSync(OUT_DIR, { recursive: true });
if (IMAGE.length === 0) throw new Error('set TRIPO_CRASH_IMAGE');

const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'));
const app = await electron.launch({
  executablePath: APP,
  args: [`--user-data-dir=${userDataDir}`],
  env: { ...process.env, HOME: homedir(), PI_E2E: '1', PI_DESKTOP_TRIPO: '1' },
});

const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
await win.waitForSelector('[data-testid="tp-rightpanel"]', { timeout: 120_000 });

let crashed = null;
win.on('crash', () => {
  crashed = 'playwright page "crash" event';
  console.log('!!! PAGE CRASH EVENT');
});
win.on('console', (m) => {
  if (m.type() === 'error') console.log('[console error]', m.text().slice(0, 200));
});

// WebGL context loss paints a blank solid colour too — catch it separately.
await win.evaluate(() => {
  const w = /** @type {any} */ (window);
  w.__health = { contextLost: 0, contextRestored: 0, heap: [] };
  const attach = () => {
    for (const c of document.querySelectorAll('canvas')) {
      if (c.dataset.healthWatched === '1') continue;
      c.dataset.healthWatched = '1';
      c.addEventListener('webglcontextlost', () => {
        w.__health.contextLost++;
        console.error('WEBGL CONTEXT LOST');
      });
      c.addEventListener('webglcontextrestored', () => w.__health.contextRestored++);
    }
  };
  attach();
  setInterval(attach, 2000);
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

// Resolution: the segmented control writes genResolution.
const resLabel = { low: '512', medium: '1024', high: '1536' }[RES] ?? '512';
await win.click(`text=${resLabel}`).catch(() => {});
if (!TEXTURE) {
  // Auto-texture defaults on; turn it off unless asked for.
  await win.click('[data-testid="tp-autotexture-toggle"]').catch(() => {});
}

await win.setInputFiles('[data-testid="tp-image-input"]', IMAGE);
await win.waitForTimeout(600);
await win.screenshot({ path: path.join(OUT_DIR, '01-before.png') });

const t0 = Date.now();
await win.click('[data-testid="tp-generate-btn"]');
console.log(`generation started (res=${resLabel}, texture=${TEXTURE})`);

const heap = [];
let alive = true;
let lastMsg = '';
const sample = async () => {
  while (alive) {
    const at = Math.round((Date.now() - t0) / 1000);
    try {
      const snap = await win.evaluate(() => {
        const m = /** @type {any} */ (performance).memory;
        const w = /** @type {any} */ (window);
        const el = document.querySelector('[data-testid="tp-genstage-msg"]');
        return {
          usedMb: m ? Math.round(m.usedJSHeapSize / 1e6) : -1,
          limitMb: m ? Math.round(m.jsHeapSizeLimit / 1e6) : -1,
          lost: w.__health?.contextLost ?? 0,
          msg: el?.textContent ?? '',
          done:
            document.querySelector('[data-testid="tp-genstage"]')?.getAttribute('data-phase') ===
            'end',
        };
      });
      heap.push({ at, mb: snap.usedMb });
      if (snap.msg !== lastMsg && snap.msg.length > 0) {
        lastMsg = snap.msg;
        console.log(`  [${at}s] heap ${snap.usedMb}MB/${snap.limitMb}MB — ${snap.msg.slice(0, 90)}`);
      }
      if (snap.lost > 0) console.log(`  [${at}s] !!! WEBGL CONTEXT LOST`);
      if (snap.done) return 'done';
    } catch (err) {
      // evaluate() failing outright is the signature of a dead renderer.
      console.log(`  [${at}s] !!! RENDERER NOT ANSWERING: ${String(err).slice(0, 140)}`);
      return 'dead';
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
  return 'stopped';
};

const outcome = await Promise.race([
  sample(),
  new Promise((r) => setTimeout(() => r('timeout'), 2_400_000)),
]);
alive = false;

await win.screenshot({ path: path.join(OUT_DIR, '02-after.png') }).catch(() => {});

// Read back what the MAIN process saw — this survives a dead window.
const trace = path.join(userDataDir, 'diagnostics', 'renderer-health.jsonl');
let gone = [];
if (existsSync(trace)) {
  const lines = readFileSync(trace, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  gone = lines.filter(
    (l) => l.event === 'render-process-gone' || l.event === 'child-process-gone',
  );
  const mem = lines.filter((l) => l.event === 'memory');
  const peak = mem.reduce(
    (m, l) => Math.max(m, ...(l.renderers ?? []).map((r) => r.workingSetKb)),
    0,
  );
  console.log(`\nmain-process trace: ${lines.length} entries, peak renderer RSS ${Math.round(peak / 1024)}MB`);
}

const peakHeap = heap.reduce((m, h) => Math.max(m, h.mb), 0);
console.log('\n──────── RENDERER SURVIVAL ────────');
console.log(`outcome: ${outcome}   elapsed: ${Math.round((Date.now() - t0) / 1000)}s`);
console.log(`renderer JS heap: peak ${peakHeap}MB  (${heap.length} samples)`);
console.log(`heap curve: ${heap.filter((_, i) => i % 5 === 0).map((h) => `${h.at}s:${h.mb}`).join('  ')}`);
if (gone.length > 0) {
  console.log('PROCESS DEATHS:');
  for (const g of gone) console.log('  ', JSON.stringify(g));
} else {
  console.log('PROCESS DEATHS: none');
}
console.log(crashed !== null ? `PAGE CRASH: ${crashed}` : 'PAGE CRASH: none');
const ok = outcome === 'done' && gone.length === 0 && crashed === null;
console.log(`\nVERDICT: ${ok ? 'RENDERER SURVIVED' : 'RENDERER DID NOT SURVIVE'}`);
await app.close().catch(() => {});
