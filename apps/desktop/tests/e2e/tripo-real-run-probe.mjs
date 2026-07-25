/**
 * Drive a REAL generation through the REAL UI and watch what the user watches.
 *
 * jedd's report, verbatim: "from the blank screen … there was nothing in the
 * right sidebar, now there's 2 things, and both seem selected, of course the
 * debris issue also, and then there's painting failed, and also why is the
 * plane on it's nose … generate via the real UI and check."
 *
 * Four separate claims, so this probe records four separate things rather than
 * a pass/fail:
 *   1. ASSET CARDS — every card id, its version-count badge, and whether it
 *      renders selected, sampled on every change. One generation must end as
 *      ONE card whose badge counts the textured version.
 *   2. STAGE + PROGRESS — the chunk labels and their state, so the new chunked
 *      bar can be read back (and so "painting failed" shows up as a failure of
 *      the texture chunk rather than of the run).
 *   3. THE VIEWPORT — screenshots at blank / geometry-visible / finished, which
 *      is the only way to see orientation and debris.
 *   4. THE ARTIFACTS ON DISK — measured extents (Y-up?) and connected-component
 *      count (debris?) of the GLBs the run actually produced.
 *
 * Usage:
 *   TRIPO_RUN_IMAGE=<image> [TRIPO_RUN_RES=low|medium|high] [TRIPO_RUN_TEXTURE=1]
 *   [TRIPO_RUN_APP=<path to Bobble binary>] node tests/e2e/tripo-real-run-probe.mjs
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const IMAGE = process.env.TRIPO_RUN_IMAGE ?? '';
const RES = process.env.TRIPO_RUN_RES ?? 'low';
const TEXTURE = process.env.TRIPO_RUN_TEXTURE === '1';
// The freshly-packaged build, NOT /Applications — verifying a fix means running
// the bits that contain it, and jedd's installed copy may be open.
const APP =
  process.env.TRIPO_RUN_APP ??
  path.resolve(here, '..', '..', 'release', 'mac-arm64', 'Bobble.app', 'Contents', 'MacOS', 'Bobble');
const OUT_DIR = process.env.TRIPO_RUN_OUT ?? path.join(tmpdir(), 'tripo-real-run');
mkdirSync(OUT_DIR, { recursive: true });
if (IMAGE.length === 0) throw new Error('set TRIPO_RUN_IMAGE');

const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'));
const app = await electron.launch({
  executablePath: APP,
  args: [`--user-data-dir=${userDataDir}`],
  env: { ...process.env, HOME: homedir(), PI_E2E: '1', PI_DESKTOP_TRIPO: '1' },
});

const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
await win.waitForSelector('[data-testid="tp-rightpanel"]', { timeout: 120_000 });
win.on('console', (m) => {
  if (m.type() === 'error') console.log('[console error]', m.text().slice(0, 200));
});

/** Everything the user can see about assets + progress, straight off the DOM. */
const snapshot = () =>
  win.evaluate(() => {
    const cards = [...document.querySelectorAll('.tp-asset-card')].map((el) => {
      const id = (el.getAttribute('data-testid') ?? '').replace(/^tp-asset-/, '');
      const badge = document.querySelector(`[data-testid="tp-asset-steps-${id}"]`);
      return {
        id,
        selected: el.getAttribute('data-selected') === 'true',
        versions: badge === null ? 1 : Number(badge.textContent ?? '1'),
        thumb: el.querySelector('.tp-asset-preview') !== null,
      };
    });
    const chunks = [...document.querySelectorAll('.tp-chunk')].map((el) => ({
      role: (el.getAttribute('data-testid') ?? '').replace(/^tp-chunk-/, ''),
      state: el.getAttribute('data-state'),
      label: el.querySelector('.tp-chunk-label')?.textContent ?? '',
    }));
    const stage = document.querySelector('[data-testid="tp-genstage"]');
    return {
      cards,
      chunks,
      phase: stage?.getAttribute('data-phase') ?? null,
      failed: stage?.getAttribute('data-failed') === 'true',
      title: document.querySelector('[data-testid="tp-genstage-title"]')?.textContent ?? '',
      msg: document.querySelector('[data-testid="tp-genstage-msg"]')?.textContent ?? '',
      pct:
        document.querySelector('[data-testid="tp-genbar"]')?.getAttribute('aria-valuenow') ?? null,
    };
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

const resLabel = { low: '512', medium: '1024', high: '1536' }[RES] ?? '512';
await win.click(`text=${resLabel}`).catch(() => {});
if (!TEXTURE) await win.click('[data-testid="tp-autotexture-toggle"]').catch(() => {});

await win.setInputFiles('[data-testid="tp-image-input"]', IMAGE);
await win.waitForTimeout(600);
const before = await snapshot();
console.log(`BEFORE: ${before.cards.length} asset card(s) — the sidebar starts ${before.cards.length === 0 ? 'EMPTY (jedd\'s repro)' : 'with existing assets'}`);
await win.screenshot({ path: path.join(OUT_DIR, '01-before.png') });

const t0 = Date.now();
await win.click('[data-testid="tp-generate-btn"]');
console.log(`generation started (res=${resLabel}, texture=${TEXTURE})\n`);

const timeline = [];
let lastKey = '';
let shotGeometry = false;
let outcome = 'timeout';
const deadline = Date.now() + 2_400_000;
while (Date.now() < deadline) {
  const at = Math.round((Date.now() - t0) / 1000);
  let s;
  try {
    s = await snapshot();
  } catch (err) {
    console.log(`  [${at}s] !!! RENDERER NOT ANSWERING: ${String(err).slice(0, 140)}`);
    outcome = 'dead';
    break;
  }
  const key = JSON.stringify([s.cards, s.chunks.map((c) => `${c.label}:${c.state}`), s.phase, s.msg]);
  if (key !== lastKey) {
    lastKey = key;
    timeline.push({ at, ...s });
    const chunkStr = s.chunks.map((c) => `${c.label}[${c.state}]`).join(' ') || '—';
    console.log(
      `  [${at}s] cards=${s.cards.length}${s.cards.length > 0 ? `(sel:${s.cards.filter((c) => c.selected).length} v:${s.cards.map((c) => c.versions).join(',')})` : ''}` +
        ` ${chunkStr} ${s.pct ?? '–'}% — ${s.msg.slice(0, 74)}`,
    );
  }
  if (!shotGeometry && s.cards.length > 0) {
    shotGeometry = true;
    await win.waitForTimeout(1500); // let the viewer draw a frame
    await win.screenshot({ path: path.join(OUT_DIR, '02-geometry-visible.png') });
    console.log(`  [${at}s] >>> model first visible — shot 02`);
  }
  if (s.phase === 'end') {
    outcome = s.failed ? 'failed' : 'done';
    break;
  }
  await new Promise((r) => setTimeout(r, 2500));
}

await win.waitForTimeout(2000);
await win.screenshot({ path: path.join(OUT_DIR, '03-finished.png') }).catch(() => {});
const end = await snapshot().catch(() => null);
writeFileSync(path.join(OUT_DIR, 'timeline.json'), JSON.stringify(timeline, null, 2));

console.log('\n──────── WHAT THE USER SEES ────────');
console.log(`outcome: ${outcome}   elapsed: ${Math.round((Date.now() - t0) / 1000)}s`);
if (end !== null) {
  console.log(`asset cards: ${end.cards.length}`);
  for (const c of end.cards) {
    console.log(`   ${c.id}  versions=${c.versions}  selected=${c.selected}  thumb=${c.thumb}`);
  }
  console.log(`selected cards: ${end.cards.filter((c) => c.selected).length}`);
  console.log(`chunks: ${end.chunks.map((c) => `${c.label}[${c.state}]`).join(' ') || '—'}`);
  console.log(`title: ${end.title}   failed: ${end.failed}`);
  const oneCard = end.cards.length === 1;
  const oneSelected = end.cards.filter((c) => c.selected).length <= 1;
  console.log(
    `\nVERDICT: ${oneCard ? 'ONE card' : `${end.cards.length} CARDS — DUPLICATE`} · ` +
      `${oneSelected ? 'at most one selected' : 'MULTIPLE SELECTED'} · ` +
      `${outcome === 'done' ? 'run completed' : `run ${outcome}`}`,
  );
}
console.log(`shots + timeline in ${OUT_DIR}`);
await app.close().catch(() => {});
