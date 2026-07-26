/**
 * Does the ANIMATE stage rig a model through the real UI?
 *
 * The rig stage now routes to SkinTokens when its checkout is present — a
 * learned skeleton + skin weights for an arbitrary mesh — falling back to the
 * geometric 27-joint humanoid fitter otherwise. jobs.py picks between them, and
 * the fp32 environment variable the rigger needs is set there too, so nothing
 * below the IPC boundary is exercised by running the worker directly.
 *
 * The flow the user actually walks: load a model → Animate → "Analyse shape &
 * rig" (a probe-only run that raises the humanoid question) → confirm → the
 * real rig job.
 *
 * Usage: TRIPO_RIG_GLB=<model.glb> node tests/e2e/tripo-rig-stage-probe.mjs
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const GLB = process.env.TRIPO_RIG_GLB ?? '';
const OUT_DIR = process.env.TRIPO_RIG_OUT ?? path.join(tmpdir(), 'tripo-rig-stage');
const APP =
  process.env.TRIPO_RIG_APP ??
  path.resolve(here, '..', '..', 'release', 'mac-arm64', 'Bobble.app', 'Contents', 'MacOS', 'Bobble');
mkdirSync(OUT_DIR, { recursive: true });
if (GLB.length === 0) throw new Error('set TRIPO_RIG_GLB');

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

await win.setInputFiles('[data-testid="tp-upload-card-input"]', GLB);
await win.waitForFunction(() => document.querySelectorAll('.tp-asset-card').length > 0, undefined, {
  timeout: 60_000,
});
await win.waitForTimeout(2500);

await win.click('[data-testid="tp-rail-animate"]');
await win.waitForTimeout(800);
const engine = await win
  .textContent('[data-testid="tp-rig-engine-row"]')
  .catch(() => '(no engine row)');
console.log(`engine row: ${engine?.replace(/\s+/g, ' ').trim()}`);
await win.screenshot({ path: path.join(OUT_DIR, '01-animate-panel.png') });

const btn = await win.$('[data-testid="tp-rig-btn"]');
if (btn === null || (await btn.isDisabled())) {
  console.log('FAIL: rig button missing or disabled');
  await app.close();
  process.exit(1);
}
await btn.click();

/**
 * TWO jobs, in order. "Analyse shape & rig" runs a PROBE first, and only when
 * that lands does the humanoid question appear; answering it starts the real
 * rig. Clicking confirm early does nothing and the probe's own completion then
 * looks like success — which is exactly how this probe first reported a rig
 * that never ran.
 */
const snap = () =>
  win
    .evaluate(() => ({
      phase: document.querySelector('[data-testid="tp-genstage"]')?.getAttribute('data-phase') ?? null,
      failed: document.querySelector('[data-testid="tp-genstage"]')?.getAttribute('data-failed') === 'true',
      msg: document.querySelector('[data-testid="tp-genstage-msg"]')?.textContent ?? '',
      asking: document.querySelector('[data-testid="tp-humanoid-ask"]') !== null,
      confirm: document.querySelector('[data-testid="tp-humanoid-confirm"]') !== null,
      steps: document.querySelector('[class*="tp-asset-steps"]')?.textContent ?? '1',
    }))
    .catch(() => null);

const waitFor = async (pred, label, ms) => {
  const t = Date.now();
  let last = '';
  while (Date.now() - t < ms) {
    const s = await snap();
    if (s === null) return null;
    if (s.msg !== last && s.msg.length > 0) {
      last = s.msg;
      console.log(`  [${Math.round((Date.now() - t) / 1000)}s] ${label}: ${s.msg.slice(0, 100)}`);
    }
    if (pred(s)) return s;
    await new Promise((r) => setTimeout(r, 2500));
  }
  return null;
};

const asked = await waitFor((s) => s.asking && s.confirm, 'shape probe', 600_000);
if (asked === null) {
  console.log('FAIL: the humanoid question never appeared');
  await app.close();
  process.exit(1);
}
console.log('  shape probe finished — answering the humanoid question');
await win.click('[data-testid="tp-humanoid-confirm"]');

// The rig job proper. Waiting for phase==='end' straight away would match the
// PROBE job's own end, which is still on screen — so wait for a running job
// first ('building' or 'refining'), and only then for it to finish.
const started = await waitFor(
  (s) => s.phase === 'building' || s.phase === 'refining',
  'rig start',
  120_000,
);
if (started === null) {
  console.log('FAIL: the rig job never started after the humanoid question');
  await app.close();
  process.exit(1);
}
const done = await waitFor((s) => s.phase === 'end', 'rig', 1_800_000);
const outcome = done === null ? 'timeout' : done.failed ? 'FAILED' : 'done';

await win.waitForTimeout(2000);
await win.screenshot({ path: path.join(OUT_DIR, '02-rigged.png') });
const end = await win.evaluate(() => ({
  cards: document.querySelectorAll('.tp-asset-card').length,
  versions: document.querySelector('[class*="tp-asset-steps"]')?.textContent ?? '1',
  rigBadge: document.querySelector('.tp-asset-rig') !== null,
}));
console.log(
  `\noutcome: ${outcome}  cards: ${end.cards}  versions: ${end.versions}  rig badge: ${end.rigBadge}`,
);
console.log(`shots in ${OUT_DIR}`);
await app.close().catch(() => {});
