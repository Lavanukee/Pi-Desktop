/**
 * Bobble 3D studio — version-tree + rig-gating probe, against the REAL engine.
 *
 * Proves the things that used to be broken or faked:
 *   1. Running a stage op does NOT spawn a second asset — the asset count stays
 *      at 1 and the History tab grows a node.
 *   2. The retopo result reports QUAD topology (the viewer reads the real
 *      polygon counts off the GLB, not the triangulated stand-in).
 *   3. Motion UI is invisible until the model is actually rigged.
 *   4. Rigging asks "humanoid?" from a real shape measurement before it runs.
 *
 * Needs the gen3d engine installed (autoremesher + the meshtools venv). Run
 * `pnpm --filter @pi-desktop/desktop build` first — this loads dist.
 */
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(appRoot, '../..');
const mockPi = path.join(repoRoot, 'packages/engine/tools/mock-pi/mock-pi.mjs');
const OUT_DIR = process.env.TRIPO_VER_OUT ?? path.join(tmpdir(), 'tripo-versions-shots');
mkdirSync(OUT_DIR, { recursive: true });

// The model to put through the pipeline. Any GLB/OBJ on disk works; the point
// is that it has a REAL path so the engine can read it.
const MODEL = process.env.TRIPO_VER_MODEL ?? '';

const assert = (c, m) => {
  if (!c) throw new Error(`tripo-versions-probe failed: ${m}`);
};
assert(MODEL.length > 0, 'set TRIPO_VER_MODEL to a model file on disk');

const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'pi-e2e-home-')));
const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'))}`],
  env: {
    ...process.env,
    HOME: home,
    PI_BIN: mockPi,
    PI_E2E: '1',
    PI_DESKTOP_TRIPO: '1',
    // The REAL engine cache — we want autoremesher + the rigger installed.
    GEN3D_CACHE_DIR: path.join(homedir(), '.cache/pi-desktop/gen3d'),
  },
});

const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
const shot = (name) => win.screenshot({ path: path.join(OUT_DIR, `${name}.png`) });

// ── open the 3D studio ────────────────────────────────────────────────────
await win.waitForSelector('[data-testid="tp-rightpanel"]', { timeout: 60_000 });
await shot('01-studio');

// ── import a real file (real disk path → stage ops can run on it) ─────────
await win.setInputFiles('[data-testid="tp-upload-card-input"]', MODEL);
await win.waitForSelector('[data-testid="tp-asset-grid"] .tp-asset-card', { timeout: 30_000 });
// Count on the Assets tab — the grid only renders while that tab is active.
const assetCount = async () => {
  await win.click('[data-testid="tp-tab-assets"]');
  await win.waitForSelector('[data-testid="tp-asset-grid"]', { timeout: 10_000 });
  return win.evaluate(() => document.querySelectorAll('.tp-asset-card').length);
};
assert((await assetCount()) === 1, `exactly one asset after import (got ${await assetCount()})`);
await shot('02-imported');

// ── run retopology through the engine ─────────────────────────────────────
await win.click('[data-testid="tp-rail-retopo"]').catch(() => {});
await win.waitForSelector('[data-testid="tp-panel-retopo"]', { timeout: 10_000 });
// The uv/Python sidecar takes a few seconds to boot; the catalog only reports
// AutoRemesher as installed once it answers.
await win
  .waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="tp-retopo-btn"]');
      return el !== null && !/Download/i.test(el.textContent ?? '');
    },
    undefined,
    { timeout: 90_000 },
  )
  .catch(async () => {
    const label = await win.textContent('[data-testid="tp-retopo-btn"]').catch(() => '?');
    throw new Error(
      `AutoRemesher must be installed + the sidecar up for this probe (button said "${label?.trim()}")`,
    );
  });
const retopoBtn = await win.$('[data-testid="tp-retopo-btn"]');
console.log('retopo button:', (await retopoBtn.textContent())?.trim());
await retopoBtn.click();

// Wait for the job to finish (the engine emits done).
await win.waitForFunction(
  () => {
    const el = document.querySelector('[data-testid="tp-genstage"]');
    return el !== null && el.getAttribute('data-phase') === 'end';
  },
  undefined,
  { timeout: 300_000 },
);
await shot('03-retopo-done');

// 1. NO new asset — the op appended a version instead.
const after = await assetCount();
assert(after === 1, `retopo must NOT spawn a second asset (asset count = ${after})`);

// 2. The history tree grew.
await win.click('[data-testid="tp-tab-history"]');
await win.waitForSelector('[data-testid="tp-ver-tree"]', { timeout: 10_000 });
const nodes = await win.evaluate(
  () => document.querySelectorAll('[data-testid="tp-ver-tree"] .tp-ver-row').length,
);
assert(nodes === 2, `history tree should have 2 nodes (got ${nodes})`);
await shot('04-history-tree');

// 3. Real quad topology on screen.
const stats = await win.evaluate(() => {
  const el = document.querySelector('[data-testid="tp-stats"]');
  return el === null ? document.body.innerText : el.textContent;
});
console.log('stats readout:', String(stats).slice(0, 200).replace(/\s+/g, ' '));
assert(/Quad/i.test(String(stats)), 'the retopo result must report QUAD topology');

// ── rig gating ────────────────────────────────────────────────────────────
await win.click('[data-testid="tp-rail-animate"]').catch(() => {});
await win.waitForSelector('[data-testid="tp-panel-animate"]', { timeout: 10_000 });
const motionGridBefore = await win.$('[data-testid="tp-anim-grid"]');
assert(motionGridBefore === null, 'motion library must be HIDDEN before the model is rigged');
const graphBtnBefore = await win.$('[data-testid="tp-open-graph"]');
assert(graphBtnBefore === null, 'state machine must be HIDDEN before the model is rigged');
await shot('05-animate-gated');

const rigBtn = await win.$('[data-testid="tp-rig-btn"]');
assert(rigBtn !== null, 'rig button present');
await rigBtn.click();

// The shape probe asks "humanoid?" — it must ASK, not decide.
await win.waitForSelector('[data-testid="tp-humanoid-ask"]', { timeout: 120_000 });
const askText = await win.textContent('[data-testid="tp-humanoid-ask"]');
console.log('humanoid question:', askText?.trim().slice(0, 160).replace(/\s+/g, ' '));
await shot('06-humanoid-ask');

await win.click('[data-testid="tp-humanoid-confirm"]');
await win.waitForSelector('[data-testid="tp-rig-status"]', { timeout: 300_000 });
const rigStatus = await win.textContent('[data-testid="tp-rig-status"]');
console.log('rig status:', rigStatus?.trim().replace(/\s+/g, ' '));
await shot('07-rigged');

// Still ONE asset; the tree is now three deep.
const afterRig = await assetCount();
assert(afterRig === 1, `rig must NOT spawn a second asset (asset count = ${afterRig})`);
await win.click('[data-testid="tp-tab-history"]');
await win.waitForSelector('[data-testid="tp-ver-tree"]', { timeout: 10_000 });
const nodesAfterRig = await win.evaluate(
  () => document.querySelectorAll('[data-testid="tp-ver-tree"] .tp-ver-row').length,
);
assert(nodesAfterRig === 3, `history tree should have 3 nodes after rig (got ${nodesAfterRig})`);
await shot('08-history-after-rig');

// ── branch switching: make an OLDER node current, then re-run an op from it ──
await win.click('[data-testid="tp-tab-history"]');
await win.waitForSelector('[data-testid="tp-ver-tree"]', { timeout: 10_000 });
const rootId = await win.evaluate(() => {
  const first = document.querySelector('[data-testid="tp-ver-tree"] .tp-ver-row');
  return first?.getAttribute('data-testid')?.replace('tp-ver-', '') ?? null;
});
if (rootId === null) throw new Error('could not find the root version row');
await win.click(`[data-testid="tp-ver-make-${rootId}"]`);
await win.waitForTimeout(600);
const currentIsRoot = await win.evaluate(
  (id) => document.querySelector(`[data-testid="tp-ver-${id}"]`)?.getAttribute('data-current') === 'true',
  rootId,
);
assert(currentIsRoot, 'switching the working version back to the root must stick');
await shot('09-switched-to-root');

// Re-run retopo FROM the root — that must BRANCH, not overwrite the first result.
// The PREVIOUS job's completion bar lingers for a few seconds, so wait for it to
// clear before starting: otherwise the "job finished" check below matches the
// old bar and we measure the tree before the new job has even run.
await win.waitForFunction(
  () => document.querySelector('[data-testid="tp-genstage"]') === null,
  undefined,
  { timeout: 30_000 },
);
await win.click('[data-testid="tp-rail-retopo"]');
await win.click('[data-testid="tp-retopo-btn"]');
await win.waitForFunction(
  () => document.querySelector('[data-testid="tp-genstage"]') !== null,
  undefined,
  { timeout: 30_000 },
);
await win.waitForFunction(
  () => {
    const el = document.querySelector('[data-testid="tp-genstage"]');
    return el !== null && el.getAttribute('data-phase') === 'end';
  },
  undefined,
  { timeout: 300_000 },
);
const stillOne = await assetCount();
assert(stillOne === 1, `branching must not spawn an asset (got ${stillOne})`);
await win.click('[data-testid="tp-tab-history"]');
await win.waitForSelector('[data-testid="tp-ver-tree"]', { timeout: 10_000 });
const branched = await win.evaluate(() => ({
  nodes: document.querySelectorAll('[data-testid="tp-ver-tree"] .tp-ver-row').length,
  branchTags: document.querySelectorAll('.tp-ver-branch-tag').length,
}));
console.log('after branching:', JSON.stringify(branched));
assert(branched.nodes === 4, `tree should have 4 nodes after branching (got ${branched.nodes})`);
assert(branched.branchTags >= 2, `siblings must be tagged as a branch (got ${branched.branchTags})`);
await shot('10-branched');

// ── persistence: the tree must survive a reload ──────────────────────────────
const beforeReload = await win.evaluate(() => localStorage.getItem('bobble3d.assetTree.v1'));
assert(beforeReload !== null && beforeReload.length > 10, 'tree persisted to localStorage');
await win.reload();
await win.waitForSelector('[data-testid="tp-rightpanel"]', { timeout: 60_000 });
const afterReload = await assetCount();
assert(afterReload === 1, `the asset must survive a reload (got ${afterReload})`);
await win.click('[data-testid="tp-asset-grid"] .tp-asset-card');
await win.click('[data-testid="tp-tab-history"]');
await win.waitForSelector('[data-testid="tp-ver-tree"]', { timeout: 10_000 });
const restored = await win.evaluate(
  () => document.querySelectorAll('[data-testid="tp-ver-tree"] .tp-ver-row').length,
);
assert(restored === 4, `the whole tree must survive a reload (got ${restored})`);
console.log('tree restored after reload:', restored, 'nodes');
await shot('11-after-reload');

console.log(`\ntripo-versions-probe PASSED — shots in ${OUT_DIR}`);
await app.close();
