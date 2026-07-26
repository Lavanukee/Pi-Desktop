/**
 * END-TO-END pipeline probe for the Bobble 3D studio — drives EVERY stage
 * through the REAL UI with the REAL engines and records, per stage, what
 * actually happened.
 *
 * This is the probe that answers "does the studio work?" rather than "does the
 * button exist?". Each stage runs to completion (some take minutes), captures a
 * screenshot of the app in the state that stage produced, and writes a verdict
 * into report.json. A stage that fails does NOT abort the run — the point is a
 * complete honest picture, so later stages still get their turn where they can.
 *
 * Heavy ML is serialised by construction: the engine runs one job subprocess at
 * a time and this probe never dispatches a second before the first reports
 * `end`.
 *
 * Usage (needs the models installed under ~/.cache/pi-desktop/gen3d):
 *   node apps/desktop/tests/e2e/tripo-e2e-pipeline-probe.mjs
 *   TRIPO_E2E_STAGES=image,imageedit,img3d node …    # subset, in this order
 *   TRIPO_E2E_OUT=/tmp/shots TRIPO_E2E_RES=low node …
 *
 * `npm run build` first — it loads apps/desktop/dist.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = process.env.TRIPO_E2E_OUT ?? path.join(tmpdir(), 'tripo-e2e-pipeline');
const RES = process.env.TRIPO_E2E_RES ?? 'low';
// Order matters and is the pipeline's own: texture BEFORE segment/retopo, so it
// runs on the generation's own output. Texturing re-bakes from the colour
// volume the generation saved, and a retopologised or segmented mesh lives in a
// different job dir than those colours — running it last therefore tests the
// path-plumbing, not the texture bake.
const ALL_STAGES = [
  'image',
  'imageedit',
  'img3d',
  'text3d',
  'texture',
  'segment',
  'retopo',
  'rig',
  'skeleton',
  'animate',
];
const STAGES = (process.env.TRIPO_E2E_STAGES ?? ALL_STAGES.join(',')).split(',').filter(Boolean);
mkdirSync(OUT, { recursive: true });

/** Prompt chosen to read as humanoid — the rig gate and the whole motion half
 * of the Animate panel are hidden unless the shape probe says humanoid. */
const IMAGE_PROMPT =
  'a full-body toy robot action figure standing upright facing the camera, two arms, two legs, ' +
  'plain white studio background, centered, product photo';
const EDIT_PROMPT = 'make the robot bright orange';
const TEXT3D_PROMPT = 'a simple wooden stool with three legs';

const report = [];
const t0 = Date.now();
const log = (...a) =>
  console.log(`[${String(Math.round((Date.now() - t0) / 1000)).padStart(5)}s]`, ...a);
const flush = () => writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));

const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${path.join(tmpdir(), `tripo-e2e-udd-${Date.now()}`)}`],
  // The REAL home: the 117 GB weight cache and the gen3d sandbox live there,
  // and Electron's app.getPath('home') ignores a $HOME override anyway.
  env: { ...process.env, HOME: homedir(), PI_E2E: '1', PI_DESKTOP_TRIPO: '1' },
});

const win = await app.firstWindow();
win.on('console', (m) => {
  if (m.type() === 'error') log('  [renderer error]', m.text().slice(0, 180));
});

/**
 * Screenshot, tolerating a dead window. A heavy stage CAN take the renderer
 * down (observed once: the app died ~8m into a CubePart segmentation), and a
 * probe whose job is to report honestly must survive that and keep its earlier
 * verdicts rather than throwing them away on the way out.
 */
const shot = async (name) => {
  const file = path.join(OUT, `${name}.png`);
  try {
    await win.waitForTimeout(500);
    await win.screenshot({ path: file });
    log(`  shot: ${name}.png`);
  } catch {
    log(`  shot: ${name}.png SKIPPED — window is gone`);
  }
  return file;
};

/** Everything the studio can tell us about its own state, straight off the DOM. */
const snapshot = () =>
  win.evaluate(() => {
    const stage = document.querySelector('[data-testid="tp-genstage"]');
    const cards = [...document.querySelectorAll('.tp-asset-card')].map((el) => ({
      id: (el.getAttribute('data-testid') ?? '').replace(/^tp-asset-/, ''),
      selected: el.getAttribute('data-selected') === 'true',
      versions: Number(
        document.querySelector(
          `[data-testid="tp-asset-steps-${(el.getAttribute('data-testid') ?? '').replace(/^tp-asset-/, '')}"]`,
        )?.textContent ?? '1',
      ),
    }));
    const host = document.querySelector('[data-testid="tp-canvas-host"]');
    return {
      phase: stage?.getAttribute('data-phase') ?? null,
      failed: stage?.getAttribute('data-failed') === 'true',
      msg: document.querySelector('[data-testid="tp-genstage-msg"]')?.textContent ?? '',
      title: document.querySelector('[data-testid="tp-genstage-title"]')?.textContent ?? '',
      pct:
        document.querySelector('[data-testid="tp-genbar"]')?.getAttribute('aria-valuenow') ?? null,
      chunks: [...document.querySelectorAll('.tp-chunk')].map(
        (c) =>
          `${c.querySelector('.tp-chunk-label')?.textContent ?? '?'}[${c.getAttribute('data-state')}]`,
      ),
      cards,
      stats: document.querySelector('[data-testid="tp-stats"]')?.textContent ?? '',
      canvasReady: host?.getAttribute('data-tp-canvas-ready') === '1',
      startError: document.querySelector('[data-testid="tp-start-error"]')?.textContent ?? null,
    };
  });

/**
 * Wait for the job that `fire()` starts to reach `end`, logging every visible
 * change. Returns the final snapshot plus how long it took.
 */
async function runJob(label, fire, timeoutMs) {
  const started = Date.now();
  await fire();
  // A refused request never creates a job — surface that instead of hanging.
  await win.waitForTimeout(1500);
  const early = await snapshot();
  if (early.startError !== null && early.phase === null) {
    return { ok: false, why: `refused: ${early.startError}`, seconds: 0, snap: early };
  }
  let last = '';
  let snap = early;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    snap = await snapshot().catch(() => null);
    if (snap === null)
      return { ok: false, why: 'renderer stopped answering', seconds: -1, snap: {} };
    const key = `${snap.phase}|${snap.pct}|${snap.chunks.join(' ')}|${snap.msg}`;
    if (key !== last) {
      last = key;
      log(
        `  ${label}: ${snap.phase ?? '—'} ${snap.pct ?? '–'}% ${snap.chunks.join(' ')} — ${snap.msg.slice(0, 90)}`,
      );
    }
    if (snap.phase === 'end') break;
    await win.waitForTimeout(3000);
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  if (snap.phase !== 'end') return { ok: false, why: `timed out after ${seconds}s`, seconds, snap };
  if (snap.failed) return { ok: false, why: `engine reported failure: ${snap.msg}`, seconds, snap };
  return { ok: true, why: snap.msg, seconds, snap };
}

const dismiss = async () => {
  const d = win.locator('[data-testid="tp-genstage-dismiss"]');
  if (await d.count()) await d.click().catch(() => {});
  await win.waitForTimeout(400);
};

const record = (stage, status, detail, shots, seconds) => {
  report.push({ stage, status, detail, shots, seconds });
  flush();
  log(`>>> ${stage.toUpperCase()}: ${status} — ${detail}`);
};

try {
  await win.waitForLoadState('domcontentloaded');
  await win.setViewportSize({ width: 1600, height: 1000 });
  await win.waitForSelector('[data-testid="tp-root"]', { timeout: 120_000 });
  await win.evaluate(() => {
    document.documentElement.setAttribute('data-flavor', 'bobble');
    document.documentElement.setAttribute('data-mode', 'dark');
  });
  // The catalog populates asynchronously; the panels stay in "download" mode
  // until it lands, and clicking too early opens the download panel instead.
  await win
    .waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="tp-generate-btn"]');
        return el !== null && !/Download/i.test(el.textContent ?? '');
      },
      undefined,
      { timeout: 180_000 },
    )
    .catch(() => log('WARNING: generate button still reads "Download" — engine may not be ready'));
  log('studio ready');
  await shot('00-studio-ready');

  // Low resolution keeps a full ten-stage sweep inside a sane wall clock; the
  // pipeline exercised is identical, only the structure grid is coarser.
  await win.click('[data-testid="tp-rail-model"]');
  await win
    .locator('[data-testid="tp-resolution"] button', {
      hasText: RES === 'low' ? '512' : RES === 'medium' ? '1024' : '1536',
    })
    .click()
    .catch(() => {});

  // ── 1. IMAGE GENERATION (Mage-Flow) ───────────────────────────────────
  if (STAGES.includes('image')) {
    await win.click('[data-testid="tp-rail-image"]');
    await win.fill('[data-testid="tp-image-prompt"]', IMAGE_PROMPT);
    const r = await runJob(
      'image',
      () => win.click('[data-testid="tp-image-generate-btn"]'),
      25 * 60_000,
    );
    const ok = r.ok && (await win.locator('[data-testid="tp-image-preview"]').count()) > 0;
    const s = await shot('01-image-generated');
    record(
      'image generation (Mage-Flow)',
      ok ? 'PASS' : 'FAIL',
      ok ? `image rendered in the panel (${r.seconds}s)` : r.why,
      [s],
      r.seconds,
    );
    await dismiss();
  }

  // ── 2. IMAGE EDIT BEFORE 3D (Mage-Flow-Edit) ──────────────────────────
  if (STAGES.includes('imageedit')) {
    await win.click('[data-testid="tp-rail-image"]');
    const before = await win.locator('[data-testid="tp-image-preview"]').count();
    if (before === 0) {
      record('image edit (Mage-Flow-Edit)', 'SKIP', 'no generated image to edit', [], 0);
    } else {
      await win.fill('[data-testid="tp-image-edit-prompt"]', EDIT_PROMPT);
      const r = await runJob(
        'edit',
        () => win.click('[data-testid="tp-image-edit-btn"]'),
        25 * 60_000,
      );
      // A real edit adds a SECOND image version — the stepper only exists then.
      const versions = await win.locator('[data-testid="tp-image-steps"]').count();
      const ok = r.ok && versions > 0;
      const s = await shot('02-image-edited');
      record(
        'image edit (Mage-Flow-Edit)',
        ok ? 'PASS' : 'FAIL',
        ok ? `edit landed beside the original as a second version (${r.seconds}s)` : r.why,
        [s],
        r.seconds,
      );
      await dismiss();
    }
  }

  // ── 3. IMAGE → 3D (TRELLIS-2), auto-texture ON ────────────────────────
  if (STAGES.includes('img3d')) {
    await win.click('[data-testid="tp-rail-image"]');
    if ((await win.locator('[data-testid="tp-image-make3d"]').count()) === 0) {
      record('image→3D (TRELLIS-2)', 'SKIP', 'no image in the panel to convert', [], 0);
    } else {
      const r = await runJob(
        'img3d',
        () => win.click('[data-testid="tp-image-make3d"]'),
        60 * 60_000,
      );
      await win
        .waitForSelector('[data-testid="tp-canvas-host"][data-tp-canvas-ready="1"]', {
          timeout: 60_000,
        })
        .catch(() => {});
      const snap = await snapshot();
      const ok = r.ok && snap.cards.length > 0 && snap.canvasReady;
      const s = await shot('03-image-to-3d');
      record(
        'image→3D (TRELLIS-2)',
        ok ? 'PASS' : 'FAIL',
        ok
          ? `mesh in the viewport, ${snap.cards.length} asset card(s), stats "${snap.stats}" (${r.seconds}s)`
          : r.why,
        [s],
        r.seconds,
      );
      await dismiss();
    }
  }

  // ── 4. TEXT → 3D (Cube3D) ─────────────────────────────────────────────
  if (STAGES.includes('text3d')) {
    await win.click('[data-testid="tp-rail-model"]');
    await win.click('[data-testid="tp-input-tab-text"]');
    await win.locator('[data-testid="tp-engine"] button', { hasText: 'Cube 3D' }).click();
    await win.fill('[data-testid="tp-prompt"]', TEXT3D_PROMPT);
    const r = await runJob(
      'text3d',
      () => win.click('[data-testid="tp-generate-btn"]'),
      45 * 60_000,
    );
    const snap = await snapshot();
    const s = await shot('04-text-to-3d');
    record(
      'text→3D (Cube3D)',
      r.ok ? 'PASS' : 'FAIL',
      r.ok ? `Cube3D mesh in the viewport, stats "${snap.stats}" (${r.seconds}s)` : r.why,
      [s],
      r.seconds,
    );
    await dismiss();
  }

  /** Re-select the TRELLIS asset (the humanoid one) for the downstream stages. */
  const loadFirstAsset = async () => {
    await win.click('[data-testid="tp-tab-assets"]').catch(() => {});
    const cards = win.locator('.tp-asset-card .tp-asset-hit');
    const n = await cards.count();
    if (n === 0) return false;
    // Cards are newest-first; the TRELLIS run is the older one when Cube3D also ran.
    await cards
      .nth(STAGES.includes('text3d') && n > 1 ? n - 1 : 0)
      .click()
      .catch(() => {});
    await win.waitForTimeout(2500);
    return true;
  };

  // ── 5. TEXTURING (TRELLIS re-bake from the generation's colour volume) ──
  if (STAGES.includes('texture')) {
    await loadFirstAsset();
    await win.click('[data-testid="tp-rail-texture"]');
    const runnable =
      (await win.locator('[data-testid="tp-texture-btn"]:not([disabled])').count()) > 0;
    if (!runnable) {
      record('texturing', 'SKIP', 'run button disabled — nothing runnable loaded', [], 0);
    } else {
      const r = await runJob(
        'texture',
        () => win.click('[data-testid="tp-texture-btn"]'),
        60 * 60_000,
      );
      await win.click('[data-testid="tp-rmode-textured"]').catch(() => {});
      const s = await shot('07-textured');
      record(
        'texturing',
        r.ok ? 'PASS' : 'FAIL',
        r.ok ? `textured version produced (${r.seconds}s)` : r.why,
        [s],
        r.seconds,
      );
      await dismiss();
    }
  }

  // ── 6. SEGMENTATION (CubePart) ────────────────────────────────────────
  if (STAGES.includes('segment')) {
    const have = await loadFirstAsset();
    if (!have) {
      record('segmentation (CubePart)', 'SKIP', 'no asset loaded to segment', [], 0);
    } else {
      await win.click('[data-testid="tp-rail-segment"]');
      const r = await runJob(
        'segment',
        () => win.click('[data-testid="tp-segment-btn"]'),
        60 * 60_000,
      );
      const parts = await win.locator('[data-testid="tp-parts-list"] .tp-part-row').count();
      const s = await shot('05-segmented');
      record(
        'segmentation (CubePart)',
        r.ok ? 'PASS' : 'FAIL',
        r.ok ? `${parts} part(s) listed in the panel (${r.seconds}s)` : r.why,
        [s],
        r.seconds,
      );
      await dismiss();
    }
  }

  // ── 7. RETOPOLOGY (QuadriFlow) ────────────────────────────────────────
  if (STAGES.includes('retopo')) {
    await win.click('[data-testid="tp-rail-retopo"]');
    const runnable =
      (await win.locator('[data-testid="tp-retopo-btn"]:not([disabled])').count()) > 0;
    if (!runnable) {
      record(
        'retopology (QuadriFlow)',
        'SKIP',
        'run button disabled — nothing runnable loaded',
        [],
        0,
      );
    } else {
      const r = await runJob(
        'retopo',
        () => win.click('[data-testid="tp-retopo-btn"]'),
        40 * 60_000,
      );
      const snap = await snapshot();
      const s = await shot('06-retopo');
      // Wireframe on, so the "Topology: Quad vs triangles drawn" claim is visible.
      await win.click('[data-testid="tp-wire-toggle"]').catch(() => {});
      const s2 = await shot('06b-retopo-wireframe');
      await win.click('[data-testid="tp-wire-toggle"]').catch(() => {});
      record(
        'retopology (QuadriFlow)',
        r.ok ? 'PASS' : 'FAIL',
        r.ok
          ? `remesh returned, stats "${snap.stats}" (${r.seconds}s) — inspect 06*.png for mesh QUALITY`
          : r.why,
        [s, s2],
        r.seconds,
      );
      await dismiss();
    }
  }

  // ── 8. RIGGING (SkinTokens) ───────────────────────────────────────────
  if (STAGES.includes('rig')) {
    await win.click('[data-testid="tp-rail-animate"]');
    const canRig = (await win.locator('[data-testid="tp-rig-btn"]:not([disabled])').count()) > 0;
    if (!canRig) {
      const why = (await win.locator('[data-testid="tp-rig-unavailable"]').count())
        ? await win.textContent('[data-testid="tp-rig-unavailable"]')
        : 'rig button disabled';
      record(
        'rigging (SkinTokens)',
        'FAIL',
        why ?? 'rig button disabled',
        [await shot('08-rig-blocked')],
        0,
      );
    } else {
      // Two jobs: the shape PROBE, then the rig the user confirms.
      const probe = await runJob(
        'shape-probe',
        () => win.click('[data-testid="tp-rig-btn"]'),
        30 * 60_000,
      );
      await win.waitForTimeout(1000);
      const asked = (await win.locator('[data-testid="tp-humanoid-ask"]').count()) > 0;
      const askShot = await shot('08-humanoid-question');
      if (!asked) {
        record(
          'rigging (SkinTokens)',
          'FAIL',
          `shape probe produced no humanoid question — ${probe.why}`,
          [askShot],
          probe.seconds,
        );
      } else {
        const humanoid = await win.getAttribute('[data-testid="tp-humanoid-ask"]', 'data-humanoid');
        const r = await runJob(
          'rig',
          () => win.click('[data-testid="tp-humanoid-confirm"]'),
          40 * 60_000,
        );
        const rigged = (await win.locator('[data-testid="tp-rig-status"]').count()) > 0;
        const s = await shot('09-rigged');
        record(
          'rigging (SkinTokens)',
          rigged ? 'PASS' : 'FAIL',
          rigged
            ? `rig status shown, shape probe said humanoid=${humanoid} (${probe.seconds + r.seconds}s)`
            : r.why,
          [askShot, s],
          probe.seconds + r.seconds,
        );
        await dismiss();
      }
    }
  }

  // ── 9. SKELETON OVERLAY IN THE VIEWPORT ───────────────────────────────
  if (STAGES.includes('skeleton')) {
    const btn = win.locator('[data-testid="tp-skeleton-btn"]');
    if ((await btn.count()) === 0) {
      record(
        'skeleton overlay',
        'FAIL',
        'the viewport skeleton toggle never appeared (hasSkeleton false)',
        [await shot('10-no-skeleton-btn')],
        0,
      );
    } else {
      await btn.click();
      await win.waitForTimeout(1200);
      const on = await btn.getAttribute('data-active');
      const s = await shot('10-skeleton-overlay');
      record(
        'skeleton overlay',
        on === 'true' ? 'PASS' : 'FAIL',
        `toggle active=${on} — inspect 10-skeleton-overlay.png for drawn bones`,
        [s],
        0,
      );
    }
  }

  // ── 10. ANIMATION ─────────────────────────────────────────────────────
  if (STAGES.includes('animate')) {
    await win.click('[data-testid="tp-rail-animate"]');
    await win.waitForTimeout(600);
    const grid = await win.locator('[data-testid="tp-anim-grid"] .tp-anim-card').count();
    const ardyBlocked = (await win.locator('[data-testid="tp-ardy-unavailable"]').count()) > 0;
    const nonHumanoid = (await win.locator('[data-testid="tp-nonhumanoid-note"]').count()) > 0;
    const shots = [await shot('11-animate-panel')];
    if (grid > 0) {
      // Place two motions and open the state machine.
      const cards = win.locator('[data-testid="tp-anim-grid"] .tp-anim-card');
      await cards.nth(0).click();
      await cards.nth(1).click();
      await win.click('[data-testid="tp-open-graph"]');
      await win
        .waitForSelector('[data-testid="tp-blend-graph"]', { timeout: 10_000 })
        .catch(() => {});
      shots.push(await shot('12-state-machine'));
      const nodes = await win.locator('.tp-node[data-testid^="tp-node-st-"]').count();
      await win.click('[data-testid="tp-graph-close"]').catch(() => {});
      record(
        'animation',
        'PARTIAL',
        `${grid} bundled sample clips, state machine built ${nodes} node(s). ARDY motion generation is ` +
          `${ardyBlocked ? 'shown as UNAVAILABLE on this Mac (Linux+NVIDIA only)' : 'NOT gated'} — no motion is generated locally.`,
        shots,
        0,
      );
    } else {
      record(
        'animation',
        'FAIL',
        nonHumanoid
          ? 'motion library hidden: the rig did not read as humanoid'
          : 'motion library empty (model not rigged, so the whole motion half stays hidden)',
        shots,
        0,
      );
    }
  }
} catch (err) {
  log('PROBE ERROR', err?.stack ?? String(err));
  report.push({
    stage: '(probe)',
    status: 'ERROR',
    detail: String(err?.message ?? err),
    shots: [],
    seconds: 0,
  });
  flush();
  await shot('ZZ-error');
} finally {
  flush();
  console.log('\n──────────── PIPELINE VERDICT ────────────');
  for (const r of report) console.log(`${r.status.padEnd(7)} ${r.stage} — ${r.detail}`);
  console.log(`\nshots + report.json in ${OUT}`);
  await app.close().catch(() => {});
}
