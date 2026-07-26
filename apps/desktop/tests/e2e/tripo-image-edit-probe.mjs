/**
 * text → image → EDIT → 3D, through the real UI.
 *
 * jedd's requirement: the user has to be able to SEE the image and CHANGE it
 * before spending minutes turning it into geometry. So this walks the whole
 * decision loop rather than just checking a button exists — generate, look,
 * edit, step back to the original, and confirm Make 3D is offered on whichever
 * version is selected.
 *
 * Usage: node tests/e2e/tripo-image-edit-probe.mjs
 *   TRIPO_EDIT_PROMPT   what to generate (default "a T-Rex dinosaur")
 *   TRIPO_EDIT_INSTR    the edit instruction (default "make it bright blue")
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const PROMPT = process.env.TRIPO_EDIT_PROMPT ?? 'a T-Rex dinosaur';
const INSTR = process.env.TRIPO_EDIT_INSTR ?? 'make it bright blue';
const OUT_DIR = process.env.TRIPO_EDIT_OUT ?? path.join(tmpdir(), 'tripo-image-edit');
const APP =
  process.env.TRIPO_EDIT_APP ??
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

const state = () =>
  win
    .evaluate(() => ({
      phase: document.querySelector('[data-testid="tp-genstage"]')?.getAttribute('data-phase') ?? null,
      failed: document.querySelector('[data-testid="tp-genstage"]')?.getAttribute('data-failed') === 'true',
      msg: document.querySelector('[data-testid="tp-genstage-msg"]')?.textContent ?? '',
      preview: document.querySelector('[data-testid="tp-image-preview"]')?.getAttribute('src') ?? null,
      steps: document.querySelector('[data-testid="tp-image-steps"]') !== null,
      counter: document.querySelector('.tp-image-count')?.textContent?.trim() ?? '',
      make3d: document.querySelector('[data-testid="tp-image-make3d"]') !== null,
      editBox: document.querySelector('[data-testid="tp-image-edit-prompt"]') !== null,
    }))
    .catch(() => null);

const until = async (pred, label, ms) => {
  const t0 = Date.now();
  let last = '';
  while (Date.now() - t0 < ms) {
    const s = await state();
    if (s === null) return null;
    if (s.msg !== last && s.msg.length > 0) {
      last = s.msg;
      console.log(`  [${Math.round((Date.now() - t0) / 1000)}s] ${label}: ${s.msg.slice(0, 96)}`);
    }
    if (pred(s)) return s;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
};

await win.click('[data-testid="tp-rail-image"]');
await win.waitForTimeout(600);
await win.fill('[data-testid="tp-image-prompt"]', PROMPT);
await win.click('[data-testid="tp-image-generate-btn"]');
console.log(`generating “${PROMPT}”…`);

const made = await until((s) => s.preview !== null, 'generate', 900_000);
if (made === null) {
  console.log('FAIL: no image preview appeared');
  await app.close();
  process.exit(1);
}
console.log(`  preview shown, edit box: ${made.editBox}, make3d: ${made.make3d}`);
await win.screenshot({ path: path.join(OUT_DIR, '01-generated.png') });
const firstSrc = made.preview;

// EDIT it.
await win.fill('[data-testid="tp-image-edit-prompt"]', INSTR);
await win.click('[data-testid="tp-image-edit-btn"]');
console.log(`editing: “${INSTR}”…`);
const edited = await until(
  (s) => s.preview !== null && s.preview !== firstSrc,
  'edit',
  900_000,
);
if (edited === null) {
  console.log('FAIL: the edit never produced a new image');
  await app.close();
  process.exit(1);
}
console.log(`  edited image shown · counter "${edited.counter}" · stepper: ${edited.steps}`);
await win.screenshot({ path: path.join(OUT_DIR, '02-edited.png') });

// Step BACK to the original — an edit must not destroy what it came from.
await win.click('[data-testid="tp-image-prev"]');
await win.waitForTimeout(1200);
const back = await state();
const restored = back?.preview === firstSrc;
console.log(`  stepped back to the original: ${restored}`);
await win.screenshot({ path: path.join(OUT_DIR, '03-stepped-back.png') });

const checks = [
  ['image preview shown full width', made.preview !== null],
  ['edit box offered', made.editBox === true],
  ['edit produced a different image', edited.preview !== firstSrc],
  ['version stepper appeared', edited.steps === true],
  ['original still reachable', restored],
  ['Make 3D offered on the selection', back?.make3d === true],
];
let bad = 0;
for (const [label, ok] of checks) {
  if (!ok) bad += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}`);
}
console.log(`\nVERDICT: ${bad === 0 ? 'generate → view → edit → choose works' : `${bad} failed`}`);
console.log(`shots in ${OUT_DIR}`);
await app.close().catch(() => {});
process.exit(bad === 0 ? 0 : 1);
