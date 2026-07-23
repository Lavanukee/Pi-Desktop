/**
 * LIVE probe for the four field-reported Mac computer-use overlay fixes:
 *
 *   1. LIVE TRACKING — the phantom overlay must RIDE the controlled window
 *      (16ms self-scheduling tracker), not float and snap. Measured: the
 *      overlay's Electron bounds are polled while the probe "drags" the real
 *      TextEdit window via AX moves (helper `moveWindow`); per-move latency
 *      and continuous-drag smoothness are asserted and reported.
 *   2. Z-ORDER — when ANOTHER window covers the controlled one, the overlay
 *      must hide (never paint over the occluding app) and re-show when clear.
 *      Driven with a REAL occluder: the probe's own app window moved over
 *      TextEdit (occlusion is CGWindowList truth in the helper's bounds).
 *   3. SCROLL — mac_scroll must actually move content in the background.
 *      Verified in TextEdit AND System Settings: the helper's scroll-bar-
 *      verified ack plus a window-screenshot pixel diff.
 *   4. CLIP BUFFER — overlay bounds = window rect + symmetric buffer
 *      (asserted here on a real window; rendering is mac-overlay-probe's job).
 *
 * GUARDS (clear SKIP, never a fake pass): macOS, PI_MAC_E2E=1, and both TCC
 * grants for the dev Electron binary. Run `npm run build` first.
 * TextEdit / System Settings are quit afterwards only if the probe started
 * them. Artifacts → $TMPDIR/mac-live-fixes (override MAC_LIVE_OUT).
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const execFileAsync = promisify(execFile);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(appRoot, '../..');
const mockPi = path.join(repoRoot, 'packages/engine/tools/mock-pi/mock-pi.mjs');
const OUT_DIR = process.env.MAC_LIVE_OUT ?? path.join(tmpdir(), 'mac-live-fixes');

const fail = (m) => {
  throw new Error(`mac-live-fixes-probe FAILED: ${m}`);
};
const skip = (m) => {
  console.log(`mac-live-fixes-probe: SKIP — ${m}`);
  console.log('(a skipped probe is NOT a pass)');
  process.exit(0);
};

if (process.platform !== 'darwin') skip('macOS only');
if (process.env.PI_MAC_E2E !== '1') {
  skip('set PI_MAC_E2E=1 to run (drags/scrolls real apps on this machine)');
}
if (!existsSync(path.join(appRoot, 'dist/index.html'))) {
  console.error('mac-live-fixes-probe: app not built — run `npm run build` first');
  process.exit(1);
}
mkdirSync(OUT_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'))}`],
  env: { ...process.env, PI_E2E: '1', PI_BIN: mockPi },
});

let launchedTextEdit = false;
let launchedSettings = false;

/** Overlay BrowserWindow bounds straight from Electron main (ground truth). */
const overlayBounds = () =>
  app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) =>
      x.webContents.getURL().includes('overlay.html'),
    );
    return w ? { ...w.getBounds(), visible: w.isVisible(), focused: w.isFocused() } : null;
  });

/** Move/resize the MAIN app window (the probe's real occluder). */
const setMainBounds = (r) =>
  app.evaluate(({ BrowserWindow }, rect) => {
    const w = BrowserWindow.getAllWindows().find(
      (x) => !x.webContents.getURL().includes('overlay.html'),
    );
    if (!w) return null;
    w.setBounds(rect);
    return w.getBounds();
  }, r);

/** Pixel diff of two base64 PNGs via nativeImage in main (no CSP involved). */
const pixelDiff = (a, b) =>
  app.evaluate(
    ({ nativeImage }, [b64a, b64b]) => {
      const ia = nativeImage.createFromBuffer(Buffer.from(b64a, 'base64'));
      const ib = nativeImage.createFromBuffer(Buffer.from(b64b, 'base64'));
      const ba = ia.toBitmap();
      const bb = ib.toBitmap();
      const len = Math.min(ba.length, bb.length);
      let diff = 0;
      for (let i = 0; i < len; i += 4) {
        if (
          Math.abs(ba[i] - bb[i]) > 16 ||
          Math.abs(ba[i + 1] - bb[i + 1]) > 16 ||
          Math.abs(ba[i + 2] - bb[i + 2]) > 16
        ) {
          diff += 1;
        }
      }
      return { pixels: len / 4, diff, fraction: len === 0 ? 0 : diff / (len / 4) };
    },
    [a, b],
  );

try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.piDesktop?.invoke === 'function', {
    timeout: 20000,
  });
  const dbg = async (op, params) => {
    const res = await page.evaluate((req) => window.piDesktop.invoke('mac:debug', req), {
      op,
      params,
    });
    if (res.ok !== true) throw new Error(`mac:debug ${op}: ${res.error}`);
    return res.result;
  };

  // ── TCC gate (through the app's helper — the only non-lying identity) ────
  const tcc = await dbg('check');
  console.log('TCC status (dev Electron identity):', JSON.stringify(tcc));
  if (tcc.accessibility !== true || tcc.screenRecording !== true) {
    console.log('Grant in System Settings → Privacy & Security → Accessibility AND');
    console.log(`Screen Recording for "Electron" (${path.dirname(String(electronBinary))})`);
    skip(
      `TCC not granted (accessibility=${tcc.accessibility}, screenRecording=${tcc.screenRecording})`,
    );
  }

  const wasTextEditRunning = await dbg('bounds', { app: 'TextEdit' }).then(
    () => true,
    () => false,
  );

  // Park our own window in the top-left corner so it can't occlude the
  // controlled window during the tracking measurements.
  await setMainBounds({ x: 0, y: 40, width: 520, height: 420 });

  // ── launch TextEdit in the background; the overlay attaches + tracks ─────
  const launch = await dbg('launch', { app: 'TextEdit' });
  if (launch.ok !== true || typeof launch.pid !== 'number') {
    fail(`launch TextEdit: ${JSON.stringify(launch)}`);
  }
  launchedTextEdit = !wasTextEditRunning;
  const pid = launch.pid;
  // Put TextEdit in a guaranteed-clear area, right of our parked window.
  await dbg('moveWindow', { pid, x: 620, y: 160 });
  await sleep(600);

  const info0 = await dbg('overlay-info');
  console.log('overlay after launch:', JSON.stringify(info0));
  if (info0.visible !== true) fail('overlay not visible over the launched app');
  if (info0.occluded !== false) {
    fail(
      `helper did not report a clear window (occluded=${info0.occluded}) — z-order data missing`,
    );
  }

  // Defect 4: overlay window = controlled rect + symmetric clip buffer.
  const b0 = await dbg('bounds', { pid });
  const ob0 = await overlayBounds();
  if (ob0 === null) fail('overlay BrowserWindow missing');
  const bufX = (ob0.width - b0.w) / 2;
  const bufY = (ob0.height - b0.h) / 2;
  if (bufX <= 0 || bufX !== bufY) {
    fail(`overlay buffer not symmetric/positive: x=${bufX} y=${bufY} (${JSON.stringify(ob0)})`);
  }
  const BUFFER = bufX;
  if (Math.abs(ob0.x - (b0.x - BUFFER)) > 2 || Math.abs(ob0.y - (b0.y - BUFFER)) > 2) {
    fail(`overlay not centred on the window: ${JSON.stringify(ob0)} vs ${JSON.stringify(b0)}`);
  }
  console.log(`clip buffer OK: ${BUFFER}px, overlay=${JSON.stringify(ob0)}`);

  // ── 1) tracking latency: discrete AX "drag" moves ────────────────────────
  const base = { x: 620, y: 160 };
  const latencies = [];
  for (let i = 0; i < 6; i++) {
    const tx = base.x + (i % 2 === 0 ? 240 : 0);
    const ty = base.y + (i % 2 === 0 ? 70 : 0);
    const t0 = Date.now();
    await dbg('moveWindow', { pid, x: tx, y: ty });
    let landed = -1;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const ob = await overlayBounds();
      if (
        ob !== null &&
        Math.abs(ob.x - (tx - BUFFER)) <= 2 &&
        Math.abs(ob.y - (ty - BUFFER)) <= 2
      ) {
        landed = Date.now() - t0;
        break;
      }
      await sleep(8);
    }
    if (landed < 0) fail(`overlay never followed move ${i} to (${tx},${ty})`);
    latencies.push(landed);
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const worst = sorted[sorted.length - 1];
  console.log(
    `tracking latency ms (6 moves): ${JSON.stringify(latencies)} median=${median} worst=${worst}`,
  );
  // The old 500ms poll gave 0–500ms lag + snap; live tracking must beat it
  // decisively even on a loaded machine.
  if (median > 250) fail(`median tracking latency ${median}ms — not live`);
  if (worst > 1000) fail(`worst tracking latency ${worst}ms`);

  // Continuous drag: 25 small moves at 40ms; the overlay must RIDE along
  // (many distinct intermediate positions), not teleport once at the end.
  const seen = new Set();
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const ob = await overlayBounds();
      if (ob !== null) seen.add(ob.x);
      await sleep(15);
    }
  })();
  for (let i = 1; i <= 25; i++) {
    await dbg('moveWindow', { pid, x: base.x + i * 8, y: base.y });
    await sleep(40);
  }
  await sleep(350);
  sampling = false;
  await sampler;
  console.log(`continuous drag: overlay passed through ${seen.size} distinct x positions`);
  if (seen.size < 8) {
    fail(`overlay teleported (only ${seen.size} distinct positions during a 25-step drag)`);
  }
  await dbg('moveWindow', { pid, x: base.x, y: base.y });
  await sleep(300);

  // ── 2) z-order: cover TextEdit with OUR OWN app window → overlay hides ───
  const bNow = await dbg('bounds', { pid });
  await setMainBounds({ x: bNow.x - 20, y: bNow.y - 20, width: bNow.w + 40, height: bNow.h + 40 });
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find(
      (x) => !x.webContents.getURL().includes('overlay.html'),
    );
    w?.showInactive();
    w?.moveTop();
  });
  await sleep(800); // a fast tick + hide (tracker sees occluded on next read)
  const concealedInfo = await dbg('overlay-info');
  const obConcealed = await overlayBounds();
  console.log('occluded state:', JSON.stringify(concealedInfo), JSON.stringify(obConcealed));
  if (concealedInfo.occluded !== true) {
    fail(`helper did not detect the covering window (occluded=${concealedInfo.occluded})`);
  }
  if (obConcealed?.visible !== false) {
    fail('overlay still showing while the controlled window is covered by another window');
  }
  // Move our window away → the phantom must come back (clear ⇒ visible, even
  // though the model is idle — the cursor lives on the app).
  await setMainBounds({ x: 0, y: 40, width: 520, height: 420 });
  await sleep(800);
  const revealedInfo = await dbg('overlay-info');
  const obRevealed = await overlayBounds();
  if (revealedInfo.occluded !== false || obRevealed?.visible !== true) {
    fail(
      `overlay did not re-show once clear: ${JSON.stringify(revealedInfo)} ${JSON.stringify(obRevealed)}`,
    );
  }
  console.log('z-order conceal/reveal OK');
  if (obRevealed.focused) fail('overlay took focus');

  // ── 3) scroll: TextEdit (long doc, background, verified) ─────────────────
  const snap = await dbg('snapshot', { pid, cap: 60 });
  const textArea = (snap.elements ?? []).find((el) => el.role === 'AXTextArea');
  if (textArea === undefined) fail('no AXTextArea in TextEdit snapshot');
  const longText = Array.from({ length: 200 }, (_, i) => `line ${i + 1} — pi scroll probe`).join(
    '\n',
  );
  const typed = await dbg('type', { pid, index: textArea.index, text: longText });
  if (typed.found !== true) fail(`type into TextEdit failed: ${JSON.stringify(typed)}`);
  await sleep(400);

  const shotA = await dbg('screenshot', { pid });
  const scrollTE = await dbg('scroll', { pid, direction: 'down', amount: 600, dx: 0, dy: -600 });
  console.log('TextEdit scroll ack:', JSON.stringify(scrollTE));
  await sleep(400);
  const shotB = await dbg('screenshot', { pid });
  if (scrollTE.moved !== true) {
    fail(`TextEdit scroll not verified as moved: ${JSON.stringify(scrollTE)}`);
  }
  if (shotA.base64 && shotB.base64) {
    const d = await pixelDiff(shotA.base64, shotB.base64);
    console.log(`TextEdit scroll pixel diff: ${(d.fraction * 100).toFixed(2)}% of pixels`);
    writeFileSync(path.join(OUT_DIR, 'textedit-before.png'), Buffer.from(shotA.base64, 'base64'));
    writeFileSync(path.join(OUT_DIR, 'textedit-after.png'), Buffer.from(shotB.base64, 'base64'));
    if (d.fraction < 0.005) fail('TextEdit window pixels did not change after scroll');
  }

  // ── 3b) scroll: System Settings (the app that failed in the field) ───────
  const wasSettingsRunning = await dbg('bounds', { app: 'System Settings' }).then(
    () => true,
    () => false,
  );
  const settings = await dbg('launch', { app: 'System Settings' });
  if (settings.ok !== true || typeof settings.pid !== 'number') {
    fail(`launch System Settings: ${JSON.stringify(settings)}`);
  }
  launchedSettings = !wasSettingsRunning;
  const spid = settings.pid;
  await sleep(900);
  const sSnap = await dbg('snapshot', { pid: spid, cap: 60 });
  // Aim the scroll at the sidebar (always long enough to scroll): use a known
  // sidebar row's element index as the anchor when one is in the snapshot.
  const sidebarRow = (sSnap.elements ?? []).find(
    (el) =>
      ['AXRow', 'AXCell', 'AXButton', 'AXStaticText'].includes(el.role) &&
      /appearance|notifications|sound|focus|general|accessibility/i.test(el.name ?? ''),
  );
  const sShotA = await dbg('screenshot', { pid: spid });
  const sParams = { pid: spid, direction: 'down', amount: 600, dx: 0, dy: -600 };
  if (sidebarRow !== undefined) sParams.index = sidebarRow.index;
  const scrollSS = await dbg('scroll', sParams);
  console.log('System Settings scroll ack:', JSON.stringify(scrollSS));
  await sleep(500);
  const sShotB = await dbg('screenshot', { pid: spid });
  let ssMoved = scrollSS.moved === true;
  if (sShotA.base64 && sShotB.base64) {
    const d = await pixelDiff(sShotA.base64, sShotB.base64);
    console.log(`System Settings scroll pixel diff: ${(d.fraction * 100).toFixed(2)}% of pixels`);
    writeFileSync(path.join(OUT_DIR, 'settings-before.png'), Buffer.from(sShotA.base64, 'base64'));
    writeFileSync(path.join(OUT_DIR, 'settings-after.png'), Buffer.from(sShotB.base64, 'base64'));
    if (!ssMoved && d.fraction > 0.005) ssMoved = true; // pixels moved even without an AX bar
  }
  if (!ssMoved) {
    fail(
      `System Settings scroll produced no movement (ack ${JSON.stringify(scrollSS)}) — ` +
        'the field defect is NOT fixed',
    );
  }

  // Background guarantee held throughout: neither app is frontmost now.
  const front = await dbg('frontmost');
  if (/textedit|system settings/i.test(String(front.app))) {
    fail(`controlled app became frontmost: ${front.app}`);
  }

  console.log('\nmac-live-fixes-probe OK —');
  console.log(`  tracking: median ${median}ms, worst ${worst}ms, ${seen.size} drag positions`);
  console.log(`  z-order: helper occlusion truth drove hide/re-show with a real covering window`);
  console.log(`  scroll: TextEdit mode=${scrollTE.mode}, System Settings mode=${scrollSS.mode}`);
  console.log(`  artifacts in ${OUT_DIR}`);
} finally {
  if (launchedSettings) {
    try {
      await execFileAsync('osascript', ['-e', 'tell application "System Settings" to quit']);
    } catch {
      /* best effort */
    }
  }
  if (launchedTextEdit) {
    try {
      await execFileAsync('osascript', ['-e', 'tell application "TextEdit" to quit saving no']);
    } catch {
      /* best effort */
    }
  }
  await app.close();
}
