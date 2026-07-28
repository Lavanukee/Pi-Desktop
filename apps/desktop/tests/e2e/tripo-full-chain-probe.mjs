/**
 * tripo-full-chain-probe.mjs — the whole studio, by clicking, start to finish.
 *
 * generate a humanoid → texture it → rig it → animate it with ARDY.
 *
 * Every one of those stages has been verified on its own; what has NOT been
 * verified is that a person can reach the end of the chain from the UI, which is
 * the only version of "it works" that matters. The stages hand each other an
 * asset version, and that handover is exactly where a stage that passes its own
 * test still leaves the next one with nothing to run on.
 *
 *   ENGINE     'cube3d' (default, fast, geometry only) or 'trellis2' (slower,
 *              produces the colour volume the texture stage bakes from)
 *   PROMPT     what to generate
 *   TIMEOUT_M  minutes allowed per stage (default 25)
 *
 * Reports each stage as reached/skipped/failed rather than dying at the first
 * problem: knowing texture worked and rigging did not is worth more than one
 * exception.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { backgroundLaunch } from './_focus.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = process.env.ENGINE ?? 'cube3d';
const PROMPT = process.env.PROMPT ?? 'a standing human character, arms out to the sides, T-pose';
const STAGE_MS = Number(process.env.TIMEOUT_M ?? 25) * 60_000;
const OUT_DIR =
  process.env.OUT ?? path.resolve(here, '..', '..', '..', '..', '.corp-runs', 'full-chain');
const APP = process.env.APP ?? '/Applications/Bobble.app/Contents/MacOS/Bobble';

mkdirSync(OUT_DIR, { recursive: true });
const results = [];
const note = (stage, outcome, detail = '') => {
  results.push({ stage, outcome, detail });
  console.log(`[${outcome.toUpperCase()}] ${stage}${detail ? ` — ${detail}` : ''}`);
};

const background = backgroundLaunch();
const app = await electron.launch({
  executablePath: APP,
  args: [`--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-chain-udd-'))}`],
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
  win.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' && !t.startsWith('Loading media from')) {
      console.log('  [console error]', t.slice(0, 140));
    }
  });

  const snap = () =>
    win
      .evaluate(() => {
        const el = document.querySelector('[data-testid="tp-genstage"]');
        return {
          phase: el?.getAttribute('data-phase') ?? null,
          failed: el?.getAttribute('data-failed') === 'true',
          msg: document.querySelector('[data-testid="tp-genstage-msg"]')?.textContent ?? '',
          confirm: document.querySelector('[data-testid="tp-humanoid-confirm"]') !== null,
          error: document.querySelector('[data-testid="tp-start-error"]')?.textContent ?? null,
        };
      })
      .catch(() => null);

  /** Wait for a predicate, logging each new stage message so a long run is
   * legible while it happens rather than only in hindsight. */
  const waitFor = async (pred, label, ms) => {
    const t = Date.now();
    let last = '';
    while (Date.now() - t < ms) {
      const s = await snap();
      if (s === null) return null;
      if (s.msg !== last && s.msg.length > 0) {
        last = s.msg;
        console.log(
          `   [${Math.round((Date.now() - t) / 1000)}s] ${label}: ${s.msg.slice(0, 110)}`,
        );
      }
      if (pred(s)) return s;
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  };
  /**
   * A stage is finished when the strip reaches 'end' — but 'end' is ALREADY the
   * phase left behind by the previous stage, so waiting for it directly matches
   * instantly and reports a stage that never started as passed. Wait for the
   * job to actually start first. That false pass is why the texture result in
   * the first green run could not be trusted.
   */
  const runToEnd = async (label, ms = STAGE_MS) => {
    const started = await waitFor(
      (s) => s.phase === 'building' || s.phase === 'refining',
      `${label} start`,
      Math.min(ms, 300_000),
    );
    if (started === null) return { phase: null, failed: true, msg: 'the job never started' };
    return waitFor((s) => s.phase === 'end', label, ms);
  };

  // ── 1. generate ─────────────────────────────────────────────────────────
  console.log(`\n1. generate (${ENGINE}): ${JSON.stringify(PROMPT)}`);
  await win.click('[data-testid="tp-rail-model"]');
  await win.waitForTimeout(600);
  // The panel opens in IMAGE mode, where the text prompt is not rendered at
  // all — the first run of this probe timed out looking for a textarea that
  // only exists once text input is selected.
  await win.click('[data-testid="tp-input-tab-text"]');
  await win.waitForTimeout(400);
  // Cube3D vs TRELLIS is a Segmented, whose options carry no ids of their own.
  const engineLabel = ENGINE === 'cube3d' ? 'Cube 3D' : 'TRELLIS';
  await win
    .click(`[data-testid="tp-engine"] >> text=${engineLabel}`)
    .catch(() => console.log(`   (engine picker not present — using the default)`));
  await win.fill('[data-testid="tp-prompt"]', PROMPT);
  await win.waitForTimeout(300);
  // `tp-generate-btn` is the Generate Model action. NOT `tp-genmodel-btn` —
  // that is the model-picker dropdown next to it, and waiting on it reported
  // "Generate is disabled" for four runs while the screenshot plainly showed a
  // live blue button. The engine sidecar also boots in the background on a
  // fresh profile, so the wait is long on purpose.
  const genBtn = await win
    .waitForSelector('[data-testid="tp-generate-btn"]:not([disabled])', { timeout: 900_000 })
    .catch(() => null);
  if (genBtn === null) {
    note('generate', 'failed', 'the Generate button is missing or disabled');
  } else {
    await genBtn.click();
    const done = await runToEnd('generate');
    const s = await snap();
    if (done === null) note('generate', 'failed', 'timed out');
    else if (done.failed) note('generate', 'failed', done.msg.slice(0, 120));
    else note('generate', 'ok', done.msg.slice(0, 90));
    if (s?.error) console.log(`   start error: ${s.error}`);
  }
  await win.screenshot({ path: path.join(OUT_DIR, '01-generated.png') });

  const haveModel = await win.evaluate(
    () => document.querySelectorAll('.tp-asset-card').length > 0,
  );
  if (!haveModel) {
    note('chain', 'failed', 'no asset was produced — the rest cannot run');
    throw new Error('no asset');
  }

  // ── 2. texture ──────────────────────────────────────────────────────────
  // Cube3D emits geometry ONLY (no colour volume), so the texture stage has
  // nothing to bake from. That is a property of the generator, not a failure of
  // the chain, and it is reported as skipped rather than passed over silently.
  console.log('\n2. texture');
  await win.click('[data-testid="tp-rail-texture"]').catch(() => {});
  await win.waitForTimeout(800);
  const texBtn = await win.$('[data-testid="tp-texture-btn"]');
  if (texBtn === null) {
    const why = await win.textContent('[data-testid="tp-stage-unrunnable"]').catch(() => null);
    note(
      'texture',
      'skipped',
      why?.replace(/\s+/g, ' ').trim().slice(0, 120) ?? 'no texture button',
    );
  } else if (await texBtn.isDisabled()) {
    note('texture', 'skipped', 'the texture button is disabled for this model');
  } else {
    await texBtn.click();
    const done = await runToEnd('texture');
    // The engine declining because a Cube3D mesh carries no colour volume is a
    // SKIP — the stage is not applicable to this model, and calling that a
    // failure buries the real ones.
    const why = (await snap())?.msg ?? '';
    if (/no colour data|nothing to texture/i.test(why))
      note('texture', 'skipped', why.slice(0, 110));
    else if (done === null) note('texture', 'failed', 'timed out');
    else if (done.failed) note('texture', 'failed', done.msg.slice(0, 120));
    else note('texture', 'ok', done.msg.slice(0, 90));
  }
  await win.screenshot({ path: path.join(OUT_DIR, '02-textured.png') });

  // ── 3. rig ──────────────────────────────────────────────────────────────
  console.log('\n3. rig');
  await win.click('[data-testid="tp-rail-animate"]');
  await win.waitForTimeout(800);
  const rigBtn = await win.$('[data-testid="tp-rig-btn"]');
  if (rigBtn === null || (await rigBtn.isDisabled())) {
    note('rig', 'failed', 'the rig button is missing or disabled');
  } else {
    await rigBtn.click();
    const asked = await waitFor((s) => s.confirm, 'shape probe', STAGE_MS);
    if (asked === null) {
      note('rig', 'failed', 'the humanoid question never appeared');
    } else {
      // Answering YES is what routes the rig to ARDY's cskel27; answering no
      // would hand it to SkinTokens and there would be no motion to generate.
      await win.click('[data-testid="tp-humanoid-confirm"]');
      const done = await runToEnd('rig');
      const status = await win.textContent('[data-testid="tp-rig-status"]').catch(() => null);
      if (done === null) note('rig', 'failed', 'timed out');
      else if (done.failed) note('rig', 'failed', done.msg.slice(0, 120));
      else note('rig', 'ok', status?.replace(/\s+/g, ' ').trim() ?? done.msg.slice(0, 90));
    }
  }
  await win.screenshot({ path: path.join(OUT_DIR, '03-rigged.png') });

  // ── 4. motion ───────────────────────────────────────────────────────────
  console.log('\n4. motion (ARDY)');
  const motionUi = await win.evaluate(() => ({
    prompt: document.querySelector('[data-testid="tp-motion-prompt"]') !== null,
    button: document.querySelector('[data-testid="tp-generate-motion"]') !== null,
    rigHumanoid:
      document.querySelector('[data-testid="tp-rig-status"]')?.getAttribute('data-humanoid') ??
      null,
  }));
  if (!motionUi.prompt || !motionUi.button) {
    note('motion', 'failed', `controls absent (rig humanoid=${motionUi.rigHumanoid})`);
  } else {
    await win.fill('[data-testid="tp-motion-prompt"]', 'A person walks forward.');
    await win.waitForTimeout(300);
    const mBtn = await win.$('[data-testid="tp-generate-motion"]');
    if (await mBtn.isDisabled()) {
      note('motion', 'failed', 'Generate Motion is disabled');
    } else {
      await mBtn.click();
      await waitFor(
        (s) => s.phase === 'building' || s.phase === 'refining',
        'motion start',
        180_000,
      );
      const done = await runToEnd('motion');
      if (done === null) note('motion', 'failed', 'timed out');
      else if (done.failed) note('motion', 'failed', done.msg.slice(0, 120));
      else note('motion', 'ok', done.msg.slice(0, 90));
    }
  }
  await win.screenshot({ path: path.join(OUT_DIR, '04-animated.png') });
} catch (err) {
  console.error(`\ntripo-full-chain-probe: ${err.message}`);
} finally {
  await app.close().catch(() => {});
}

console.log('\n──────── chain ────────');
for (const r of results)
  console.log(`  ${r.outcome.padEnd(8)} ${r.stage}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`screenshots → ${OUT_DIR}`);
// An empty result list means it fell over before any stage was even attempted,
// which is a failure — the first run exited 0 on exactly that.
process.exit(results.length === 0 || results.some((r) => r.outcome === 'failed') ? 1 : 0);
