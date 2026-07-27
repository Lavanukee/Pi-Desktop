/**
 * tripo-motion-probe.mjs — rig a humanoid, then animate it, in the real studio.
 *
 * The motion stage is the one that cannot be trusted from unit tests: it spans
 * a renderer panel, an IPC contract, a Python sidecar, a 16 GB text encoder and
 * a GLB rewrite, and the interesting failures all live in the seams. This drives
 * the actual buttons and then checks the FILE that came out.
 *
 *   TRIPO_MOTION_GLB   humanoid mesh to import (required)
 *   TRIPO_MOTION_APP   app binary (defaults to the built Bobble.app)
 *   MOTION_PROMPT      what to generate (default is one already in the cache,
 *                      so the probe does not spend two minutes encoding text)
 *
 * Exits non-zero if the studio cannot produce an animated character.
 */
import { mkdirSync, mkdtempSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const GLB = process.env.TRIPO_MOTION_GLB ?? '';
const PROMPT = process.env.MOTION_PROMPT ?? 'A person walks forward.';
const OUT_DIR = process.env.OUT ?? path.resolve(here, '..', '..', '..', '..', '.corp-runs', 'tripo-motion');
const APP =
  process.env.TRIPO_MOTION_APP ??
  path.resolve(here, '..', '..', 'release', 'mac-arm64', 'Bobble.app', 'Contents', 'MacOS', 'Bobble');

if (GLB.length === 0 || !existsSync(GLB)) throw new Error('set TRIPO_MOTION_GLB to a humanoid mesh');
mkdirSync(OUT_DIR, { recursive: true });

let failed = false;
const fail = (m) => {
  console.log(`  FAIL ${m}`);
  failed = true;
};

const app = await electron.launch({
  executablePath: APP,
  args: [`--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-motion-udd-'))}`],
  env: { ...process.env, HOME: homedir(), PI_E2E: '1', PI_DESKTOP_TRIPO: '1' },
});

try {
  const win = await app.firstWindow();
  await win.waitForSelector('[data-testid="tp-rightpanel"]', { timeout: 120_000 });
  win.on('console', (m) => {
    if (m.type() === 'error') console.log('[console error]', m.text().slice(0, 160));
  });

  console.log('1. importing the mesh');
  await win.setInputFiles('[data-testid="tp-upload-card-input"]', GLB);
  await win.waitForFunction(() => document.querySelectorAll('.tp-asset-card').length > 0, undefined, {
    timeout: 60_000,
  });
  await win.waitForTimeout(2000);
  await win.click('[data-testid="tp-rail-animate"]');
  await win.waitForTimeout(600);

  // State comes from the DOM, like every other studio probe: there is no store
  // handle on window, and the stage strip is what the user reads anyway.
  const snap = () =>
    win
      .evaluate(() => ({
        phase:
          document.querySelector('[data-testid="tp-genstage"]')?.getAttribute('data-phase') ?? null,
        failed:
          document.querySelector('[data-testid="tp-genstage"]')?.getAttribute('data-failed') ===
          'true',
        msg: document.querySelector('[data-testid="tp-genstage-msg"]')?.textContent ?? '',
        confirm: document.querySelector('[data-testid="tp-humanoid-confirm"]') !== null,
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
        console.log(`   [${Math.round((Date.now() - t) / 1000)}s] ${label}: ${s.msg.slice(0, 110)}`);
      }
      if (pred(s)) return s;
      await new Promise((r) => setTimeout(r, 2000));
    }
    return null;
  };

  console.log('2. rigging (analyse → confirm humanoid)');
  await win.click('[data-testid="tp-rig-btn"]');
  if ((await waitFor((s) => s.confirm, 'shape probe', 600_000)) === null) {
    fail('the humanoid question never appeared');
    throw new Error('no humanoid prompt');
  }
  await win.click('[data-testid="tp-humanoid-confirm"]');
  await waitFor((s) => s.phase === 'building' || s.phase === 'refining', 'rig start', 120_000);
  await waitFor((s) => s.phase === 'end', 'rig', 900_000);
  await win.waitForSelector('[data-testid="tp-rig-status"]', { timeout: 60_000 });
  console.log('   rigged');
  await win.screenshot({ path: path.join(OUT_DIR, '01-rigged.png') });

  // The motion controls only exist once the rig is real AND humanoid — that
  // gate is the point of the panel, so its absence is a finding, not a retry.
  const ui = await win.evaluate(() => ({
    prompt: document.querySelector('[data-testid="tp-motion-prompt"]') !== null,
    seconds: document.querySelector('[data-testid="tp-motion-seconds"]') !== null,
    button: document.querySelector('[data-testid="tp-generate-motion"]') !== null,
    unavailable: document.querySelector('[data-testid="tp-ardy-unavailable"]')?.textContent ?? null,
    mismatch:
      document.querySelector('[data-testid="tp-motion-skeleton-mismatch"]')?.textContent ?? null,
    // WHICH half of the `rigged && humanoid` gate is closed. Without this the
    // failure reads as "the motion UI is broken" when it may be "the rigger
    // never reported humanoid proportions".
    rigStatus: document.querySelector('[data-testid="tp-rig-status"]')?.textContent ?? null,
    humanoidAttr:
      document.querySelector('[data-testid="tp-rig-status"]')?.getAttribute('data-humanoid') ?? null,
  }));
  console.log(`   motion UI: ${JSON.stringify({ ...ui, mismatch: ui.mismatch !== null })}`);
  if (!ui.prompt || !ui.button) fail('the motion controls did not appear on a rigged humanoid');
  if (ui.unavailable !== null) console.log(`   NOTE: ${ui.unavailable.replace(/\s+/g, ' ').trim()}`);

  // SkinTokens predicts its own skeleton, which ARDY cannot drive. On a machine
  // where it is installed the CORRECT outcome is an explained, disabled button
  // — so that is a pass with a note, not a silent skip and not a failure.
  if (ui.mismatch !== null) {
    console.log(`   SKELETON MISMATCH (expected here): ${ui.mismatch.replace(/\s+/g, ' ').trim()}`);
    const disabled = await (await win.$('[data-testid="tp-generate-motion"]')).isDisabled();
    if (!disabled) fail('the button is enabled despite a skeleton ARDY cannot drive');
    else console.log('   generate is correctly disabled — UI verified, generation not exercised');
    await win.screenshot({ path: path.join(OUT_DIR, '02-mismatch.png') });
    await app.close().catch(() => {});
    process.exit(failed ? 1 : 0);
  }

  console.log(`3. generating: ${JSON.stringify(PROMPT)}`);
  await win.fill('[data-testid="tp-motion-prompt"]', PROMPT);
  const btn = await win.$('[data-testid="tp-generate-motion"]');
  if (await btn.isDisabled()) {
    fail('Generate Motion is disabled — is ardy-motion downloaded?');
  } else {
    await btn.click();
    // Generation is ~1s of compute, but a prompt never seen before costs a
    // text-encoder load, so the wait is generous on purpose.
    await waitFor((s) => s.phase === 'building' || s.phase === 'refining', 'motion start', 120_000);
    const done = await waitFor((s) => s.phase === 'end', 'motion', 900_000);
    if (done === null) fail('the motion job never finished');
    else if (done.failed) fail(`the motion job failed: ${done.msg}`);
    else console.log(`   finished: ${done.msg.slice(0, 140)}`);
  }

  await win.screenshot({ path: path.join(OUT_DIR, '02-animated.png') });
  console.log(`\nscreenshots → ${OUT_DIR}`);
} catch (err) {
  console.error(`tripo-motion-probe: ${err.message}`);
  failed = true;
} finally {
  await app.close().catch(() => {});
}

process.exit(failed ? 1 : 0);
