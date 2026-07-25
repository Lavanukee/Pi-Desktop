/**
 * Bobble 3D studio — UI responsiveness during a real engine job.
 *
 * jedd: "the app freezes completely when running trellis model and likely
 * anything as far as I could tell". This probe MEASURES rather than assumes,
 * and separates the two possible culprits:
 *
 *   - renderer main thread blocked  → requestAnimationFrame gaps balloon
 *   - Electron main process blocked → IPC round-trips stall
 *
 * Both samplers run for the whole job. It also times how long after the
 * "artifact exists" event the model actually becomes visible, which is jedd's
 * second complaint ("the model doesn't appear immediately when generated").
 *
 * `pnpm --filter @pi-desktop/desktop build` first.
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
const OUT_DIR = process.env.TRIPO_RESP_OUT ?? path.join(tmpdir(), 'tripo-resp-shots');
mkdirSync(OUT_DIR, { recursive: true });

const MODEL = process.env.TRIPO_RESP_MODEL ?? '';
const OP = process.env.TRIPO_RESP_OP ?? 'retopo';
if (MODEL.length === 0) throw new Error('set TRIPO_RESP_MODEL to a model file on disk');

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

// ── renderer sampler: rAF gaps + when the model first renders ──────────────
await win.evaluate(() => {
  const w = /** @type {any} */ (window);
  w.__resp = { gaps: [], started: 0, artifactAt: 0, visibleAt: 0 };
  let last = performance.now();
  const tick = () => {
    const now = performance.now();
    w.__resp.gaps.push(now - last);
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

// Measure the IMPORT itself — ingesting a produced artifact takes exactly this
// path, and mid-generation that happens while texturing is still running.
await win.evaluate(() => {
  const w = /** @type {any} */ (window);
  w.__resp.gaps = [];
  w.__resp.importStart = performance.now();
});
await win.setInputFiles('[data-testid="tp-upload-card-input"]', MODEL);
await win.waitForSelector('.tp-asset-card', { timeout: 30_000 });
await win.waitForFunction(
  () => document.querySelector('[data-tp-canvas-ready]') !== null,
  undefined,
  { timeout: 120_000 },
).catch(() => {});
{
  const g = await win.evaluate(() => /** @type {any} */ (window).__resp.gaps);
  const sorted = [...g].sort((a, b) => b - a);
  const stalled = Math.round(sorted.filter((x) => x > 250).reduce((s, x) => s + x, 0));
  console.log(`\nIMPORT of ${path.basename(MODEL)}:`);
  console.log(`  worst rAF gaps: ${sorted.slice(0, 5).map(Math.round).join('ms, ')}ms`);
  console.log(`  frames >250ms: ${sorted.filter((x) => x > 250).length}  stalled total: ${stalled}ms`);
}
await win.click(`[data-testid="tp-rail-${OP}"]`);
await win.waitForFunction(
  (op) => {
    const el = document.querySelector(`[data-testid="tp-${op}-btn"]`);
    return el !== null && !/Download/i.test(el.textContent ?? '') && !el.disabled;
  },
  OP,
  { timeout: 90_000 },
);

// Reset the gap buffer right before the run so startup noise is excluded.
await win.evaluate(() => {
  const w = /** @type {any} */ (window);
  w.__resp.gaps = [];
  w.__resp.started = performance.now();
});

// ── main-process sampler: IPC round-trip latency, from node ────────────────
const ipcSamples = [];
let sampling = true;
const sampleIpc = async () => {
  while (sampling) {
    const t0 = Date.now();
    try {
      await win.evaluate(() => window.piDesktop.invoke('gen3d:catalog', undefined));
      ipcSamples.push(Date.now() - t0);
    } catch {
      ipcSamples.push(-1);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
};
const ipcTask = sampleIpc();

await win.click(`[data-testid="tp-${OP}-btn"]`);

// ── interaction checks WHILE the job runs ─────────────────────────────────
const interactions = [];
const tryInteraction = async (label, fn) => {
  const t0 = Date.now();
  try {
    await fn();
    interactions.push({ label, ms: Date.now() - t0, ok: true });
  } catch (err) {
    interactions.push({ label, ms: Date.now() - t0, ok: false, err: String(err).slice(0, 120) });
  }
};

// Give the job a moment to get going, then poke the UI like a user would.
await win.waitForTimeout(1200);
await tryInteraction('switch to History tab', () =>
  win.click('[data-testid="tp-tab-history"]', { timeout: 8000 }),
);
await tryInteraction('switch to Assets tab', () =>
  win.click('[data-testid="tp-tab-assets"]', { timeout: 8000 }),
);
await tryInteraction('open the Segment panel', () =>
  win.click('[data-testid="tp-rail-segment"]', { timeout: 8000 }),
);
await tryInteraction('back to the stage panel', () =>
  win.click(`[data-testid="tp-rail-${OP}"]`, { timeout: 8000 }),
);
await tryInteraction('cancel button is reachable', async () => {
  const btn = await win.$('[data-testid="tp-genstage-cancel"]');
  if (btn === null) throw new Error('no cancel button');
  await btn.hover({ timeout: 8000 });
});

await win.waitForFunction(
  () => {
    const el = document.querySelector('[data-testid="tp-genstage"]');
    return el !== null && el.getAttribute('data-phase') === 'end';
  },
  undefined,
  { timeout: 600_000 },
);
sampling = false;
await ipcTask;

// How long until the produced model is actually on screen?
const visibleMs = await win
  .waitForFunction(
    () => {
      const host = document.querySelector('[data-tp-canvas-ready]');
      return host !== null;
    },
    undefined,
    { timeout: 60_000 },
  )
  .then(() => 'rendered')
  .catch(() => 'NEVER RENDERED');

const gaps = await win.evaluate(() => /** @type {any} */ (window).__resp.gaps);
gaps.sort((a, b) => b - a);
const worst = gaps.slice(0, 5).map((g) => Math.round(g));
const over250 = gaps.filter((g) => g > 250).length;
const over1000 = gaps.filter((g) => g > 1000).length;
const totalStalled = Math.round(gaps.filter((g) => g > 250).reduce((s, g) => s + g, 0));

const ipcOk = ipcSamples.filter((s) => s >= 0);
ipcOk.sort((a, b) => b - a);

console.log('\n──────── UI RESPONSIVENESS DURING THE JOB ────────');
console.log(`renderer rAF gaps: worst ${worst.join('ms, ')}ms`);
console.log(`  frames >250ms: ${over250}   >1000ms: ${over1000}   stalled total: ${totalStalled}ms`);
console.log(`main-process IPC round-trip: worst ${ipcOk.slice(0, 5).join('ms, ')}ms (n=${ipcOk.length})`);
console.log(`model render after job: ${visibleMs}`);
console.log('interactions mid-run:');
for (const i of interactions) {
  console.log(`  ${i.ok ? 'OK  ' : 'FAIL'} ${i.label} — ${i.ms}ms ${i.err ?? ''}`);
}
await win.screenshot({ path: path.join(OUT_DIR, 'during.png') });

const blockedRenderer = over250 > 0;
const blockedMain = (ipcOk[0] ?? 0) > 1000;
console.log(
  `\nVERDICT: renderer ${blockedRenderer ? 'BLOCKED' : 'responsive'}, main ${blockedMain ? 'BLOCKED' : 'responsive'}`,
);
await app.close();
