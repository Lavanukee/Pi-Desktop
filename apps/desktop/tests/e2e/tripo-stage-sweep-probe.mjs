/**
 * Drive a downstream STAGE on a loaded model through the real UI.
 *
 * Retopo and Segment have never been pressed in the app by me — only their
 * workers run from the command line — so their IPC path, their panel gating and
 * their result handling are unverified. This does one stage per invocation so a
 * failure names a stage rather than "the sweep".
 *
 * Usage: TRIPO_STAGE=retopo|segment|texture TRIPO_STAGE_GLB=<model.glb> \
 *        node tests/e2e/tripo-stage-sweep-probe.mjs
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const STAGE = process.env.TRIPO_STAGE ?? 'retopo';
const GLB = process.env.TRIPO_STAGE_GLB ?? '';
const PARTS = process.env.TRIPO_STAGE_PARTS ?? '';
const OUT_DIR = process.env.TRIPO_SWEEP_OUT ?? path.join(tmpdir(), `tripo-stage-${STAGE}`);
const APP =
  process.env.TRIPO_STAGE_APP ??
  path.resolve(here, '..', '..', 'release', 'mac-arm64', 'Bobble.app', 'Contents', 'MacOS', 'Bobble');
mkdirSync(OUT_DIR, { recursive: true });
if (GLB.length === 0) throw new Error('set TRIPO_STAGE_GLB');

const BUTTON = { retopo: 'tp-retopo-btn', segment: 'tp-segment-btn', texture: 'tp-texture-btn' };
const btnId = BUTTON[STAGE];
if (btnId === undefined) throw new Error(`unknown stage ${STAGE}`);

const app = await electron.launch({
  executablePath: APP,
  args: [`--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'))}`],
  env: { ...process.env, HOME: homedir(), PI_E2E: '1', PI_DESKTOP_TRIPO: '1' },
});
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
await win.waitForSelector('[data-testid="tp-rightpanel"]', { timeout: 120_000 });
win.on('console', (m) => {
  if (m.type() === 'error') console.log('[console error]', m.text().slice(0, 160));
});

await win.setInputFiles('[data-testid="tp-upload-card-input"]', GLB);
await win.waitForFunction(() => document.querySelectorAll('.tp-asset-card').length > 0, undefined, {
  timeout: 60_000,
});
await win.waitForTimeout(3000);

await win.click(`[data-testid="tp-rail-${STAGE}"]`);
await win.waitForTimeout(800);
if (STAGE === 'segment' && PARTS.length > 0) {
  await win.fill('[data-testid="tp-segment-parts"]', PARTS).catch(() => {});
}
await win.screenshot({ path: path.join(OUT_DIR, '01-panel.png') });

const btn = await win.$(`[data-testid="${btnId}"]`);
if (btn === null) {
  console.log(`FAIL: no ${STAGE} button`);
  await app.close();
  process.exit(1);
}
const label = (await btn.textContent())?.trim() ?? '';
const disabled = await btn.isDisabled();
console.log(`${STAGE} button: "${label}"${disabled ? ' (DISABLED)' : ''}`);
if (disabled) {
  const warn = await win.textContent('[data-testid="tp-start-error"]').catch(() => null);
  console.log(`FAIL: the stage cannot run${warn ? ` — ${warn}` : ''}`);
  await app.close();
  process.exit(1);
}
await btn.click();

const t0 = Date.now();
let last = '';
let outcome = 'timeout';
while (Date.now() - t0 < 2_700_000) {
  const s = await win
    .evaluate(() => ({
      phase: document.querySelector('[data-testid="tp-genstage"]')?.getAttribute('data-phase') ?? null,
      failed: document.querySelector('[data-testid="tp-genstage"]')?.getAttribute('data-failed') === 'true',
      msg: document.querySelector('[data-testid="tp-genstage-msg"]')?.textContent ?? '',
      startError: document.querySelector('[data-testid="tp-start-error"]')?.textContent ?? null,
      steps: document.querySelector('[class*="tp-asset-steps"]')?.textContent ?? '1',
    }))
    .catch(() => null);
  if (s === null) {
    outcome = 'dead';
    break;
  }
  if (s.startError !== null) {
    console.log(`FAIL: refused — ${s.startError}`);
    await app.close();
    process.exit(1);
  }
  if (s.msg !== last && s.msg.length > 0) {
    last = s.msg;
    console.log(`  [${Math.round((Date.now() - t0) / 1000)}s] ${s.msg.slice(0, 100)}`);
  }
  if (s.phase === 'end') {
    outcome = s.failed ? 'FAILED' : 'done';
    break;
  }
  await new Promise((r) => setTimeout(r, 3000));
}

await win.waitForTimeout(2500);
await win.screenshot({ path: path.join(OUT_DIR, '02-result.png') });
const end = await win.evaluate(() => ({
  cards: document.querySelectorAll('.tp-asset-card').length,
  versions: document.querySelector('[class*="tp-asset-steps"]')?.textContent ?? '1',
  stats: document.querySelector('[data-testid="tp-stats"]')?.textContent ?? '',
}));
console.log(
  `\noutcome: ${outcome}  cards: ${end.cards}  versions: ${end.versions}\nstats: ${end.stats.replace(/\s+/g, ' ').slice(0, 90)}`,
);
const ok = outcome === 'done' && end.cards === 1 && Number(end.versions) >= 2;
console.log(`\nVERDICT: ${STAGE} ${ok ? 'ran and added a version to the SAME asset' : 'DID NOT complete cleanly'}`);
console.log(`shots in ${OUT_DIR}`);
await app.close().catch(() => {});
process.exit(ok ? 0 : 1);
