/**
 * text → 3D with NO image hop, through the real UI (Cube 3D).
 *
 * Until the gen3d-client fix, the Cube 3D selector was wired to nothing — the
 * request field was dropped in transit and every run silently went to TRELLIS.
 * So this probe checks the thing that actually matters: that a job runs, that
 * its plan has NO image stage (which is the whole point of Cube3D), and that a
 * model lands in the viewport.
 *
 * Usage: node tests/e2e/tripo-cube3d-probe.mjs
 *   TRIPO_CUBE_PROMPT   default "a wooden chair"
 *   TRIPO_CUBE_PARTS    optional comma list, e.g. "seat,backrest,legs"
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const PROMPT = process.env.TRIPO_CUBE_PROMPT ?? 'a wooden chair';
const PARTS = process.env.TRIPO_CUBE_PARTS ?? '';
const OUT_DIR = process.env.TRIPO_CUBE_OUT ?? path.join(tmpdir(), 'tripo-cube3d');
const APP =
  process.env.TRIPO_CUBE_APP ??
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
await win.click('[data-testid="tp-input-tab-text"]');
await win.waitForTimeout(500);
await win.click('[data-testid="tp-engine"] >> text=Cube 3D');
await win.waitForTimeout(500);
await win.fill('[data-testid="tp-prompt"]', PROMPT).catch(async () => {
  await win.fill('textarea', PROMPT);
});
if (PARTS.length > 0) await win.fill('[data-testid="tp-parts-input"]', PARTS);
await win.screenshot({ path: path.join(OUT_DIR, '01-before.png') });
await win.click('[data-testid="tp-generate-btn"]');
console.log(`generating “${PROMPT}”${PARTS ? ` → parts: ${PARTS}` : ''} with Cube 3D…`);

const t0 = Date.now();
let last = '';
let sawImageStage = false;
let outcome = 'timeout';
let chunks = '';
while (Date.now() - t0 < 2_400_000) {
  const s = await win
    .evaluate(() => ({
      phase: document.querySelector('[data-testid="tp-genstage"]')?.getAttribute('data-phase') ?? null,
      failed: document.querySelector('[data-testid="tp-genstage"]')?.getAttribute('data-failed') === 'true',
      msg: document.querySelector('[data-testid="tp-genstage-msg"]')?.textContent ?? '',
      chunks: [...document.querySelectorAll('.tp-chunk-label')].map((e) => e.textContent).join(' | '),
      loaded: document.querySelector('[data-testid="tp-stats"]') !== null,
    }))
    .catch(() => null);
  if (s === null) {
    outcome = 'dead';
    break;
  }
  if (s.chunks.length > 0) chunks = s.chunks;
  if (/Drawing|Drawn|image/i.test(s.chunks)) sawImageStage = true;
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
  stats: document.querySelector('[data-testid="tp-stats"]')?.textContent ?? '',
}));
console.log(`\nstage chunks seen: ${chunks}`);
console.log(`outcome: ${outcome}  asset cards: ${end.cards}`);
console.log(`stats: ${end.stats.replace(/\s+/g, ' ').slice(0, 90)}`);
const checks = [
  ['job completed', outcome === 'done'],
  ['NO image stage in the plan (the point of Cube3D)', !sawImageStage],
  ['a model landed in the viewport', end.stats.length > 0],
  ['exactly one asset card', end.cards === 1],
];
let bad = 0;
for (const [l, ok] of checks) {
  if (!ok) bad += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${l}`);
}
console.log(`\nVERDICT: ${bad === 0 ? 'text→3D with no image hop works' : `${bad} failed`}`);
console.log(`shots in ${OUT_DIR}`);
await app.close().catch(() => {});
process.exit(bad === 0 ? 0 : 1);
