/**
 * Deterministic Mac cursor-overlay probe — drives the overlay window DIRECTLY
 * (no real app control, no model, no TCC needed) through the PI_E2E-only
 * `mac:debug` channel and verifies, structurally and visually:
 *
 *   - the overlay window exists exactly over the requested rect, is
 *     always-on-top and non-focusable (a click-through phantom, never a
 *     perceivable window);
 *   - cursor moves land where they were sent (screen→local mapping) and the
 *     DOM reflects each state: Thinking pulse, click ripples, typing bubble
 *     with live text preview, key-combo label;
 *   - screenshots of every state are saved for human review (the cursor +
 *     bubble must look premium: gradient fill, white outline, glow).
 *
 * Run `npm run build` first. Shots default to $TMPDIR/mac-overlay-shots
 * (override with MAC_OVERLAY_OUT).
 */
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(appRoot, '../..');
const mockPi = path.join(repoRoot, 'packages/engine/tools/mock-pi/mock-pi.mjs');
const OUT_DIR = process.env.MAC_OVERLAY_OUT ?? path.join(tmpdir(), 'mac-overlay-shots');

const fail = (m) => {
  throw new Error(`mac-overlay-probe failed: ${m}`);
};

if (process.platform !== 'darwin') {
  console.log('mac-overlay-probe: SKIP — macOS only');
  process.exit(0);
}
if (!existsSync(path.join(appRoot, 'dist/index.html'))) {
  console.error('mac-overlay-probe: app not built — run `npm run build` first');
  process.exit(1);
}
mkdirSync(OUT_DIR, { recursive: true });

const RECT = { x: 120, y: 120, w: 900, h: 620 };

const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'))}`],
  env: { ...process.env, PI_E2E: '1', PI_BIN: mockPi },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.piDesktop?.invoke === 'function', {
    timeout: 20000,
  });

  const dbg = (op, params) =>
    page.evaluate((req) => window.piDesktop.invoke('mac:debug', req), { op, params });

  // ── show the overlay over a fixed rect ────────────────────────────────────
  const shown = await dbg('overlay-show', RECT);
  if (shown.ok !== true) fail(`overlay-show: ${shown.error}`);

  // The overlay is its own BrowserWindow → its page appears in app.windows().
  let overlay = null;
  for (let i = 0; i < 60 && overlay == null; i++) {
    overlay = app.windows().find((w) => w.url().includes('overlay.html')) ?? null;
    if (overlay == null) await sleep(200);
  }
  if (overlay == null) fail('overlay window (overlay.html) never appeared');

  // ── structural window checks (main-process truth) ─────────────────────────
  const winInfo = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) =>
      w.webContents.getURL().includes('overlay.html'),
    );
    if (!win) return null;
    return {
      bounds: win.getBounds(),
      alwaysOnTop: win.isAlwaysOnTop(),
      focusable: win.isFocusable(),
      visible: win.isVisible(),
      focused: win.isFocused(),
    };
  });
  if (winInfo == null) fail('overlay BrowserWindow not found in main');
  if (!winInfo.alwaysOnTop) fail('overlay is not always-on-top');
  if (winInfo.focusable) fail('overlay must be non-focusable (it stole focusability)');
  if (winInfo.focused) fail('overlay took focus — it must never');
  if (!winInfo.visible) fail('overlay not visible after overlay-show');
  const b = winInfo.bounds;
  if (b.x !== RECT.x || b.y !== RECT.y || b.width !== RECT.w || b.height !== RECT.h) {
    fail(`overlay bounds ${JSON.stringify(b)} != requested ${JSON.stringify(RECT)}`);
  }
  console.log('window checks OK:', JSON.stringify(winInfo));

  const info = await dbg('overlay-info');
  if (info.result?.visible !== true) fail('overlay-info says not visible');

  // Deterministic screenshots: paint a backdrop (the real window is
  // transparent) and pin the caret/dots animations where useful.
  await overlay.evaluate(() => {
    document.body.style.background = '#eceef2';
  });

  // ── state: thinking (resting pulse) ───────────────────────────────────────
  await dbg('overlay-cursor', { x: RECT.x + 320, y: RECT.y + 200 });
  await dbg('overlay-status', { status: 'thinking' });
  await sleep(650); // let travel + fade-in settle
  await overlay.screenshot({ path: path.join(OUT_DIR, '01-thinking-light.png') });

  const domThinking = await overlay.evaluate(() => ({
    transform: document.getElementById('cursor-wrap').style.transform,
    wrapOpacity: getComputedStyle(document.getElementById('cursor-wrap')).opacity,
    bubbleShown: document.getElementById('bubble').classList.contains('show'),
    pulse: document.getElementById('bubble').classList.contains('pulse'),
    text: document.getElementById('btext').textContent,
    dots: document.getElementById('bdots').classList.contains('on'),
  }));
  if (domThinking.transform !== 'translate3d(320px, 200px, 0px)') {
    fail(`cursor transform wrong: ${domThinking.transform} (screen→local mapping broken)`);
  }
  if (domThinking.wrapOpacity !== '1') fail('cursor not fully visible while resting');
  if (!domThinking.bubbleShown || !domThinking.pulse || domThinking.text !== 'Thinking') {
    fail(`thinking bubble wrong: ${JSON.stringify(domThinking)}`);
  }
  if (!domThinking.dots) fail('thinking dots not animating');

  // ── state: mid-travel (never teleports) ───────────────────────────────────
  const moveP = dbg('overlay-cursor', { x: RECT.x + 700, y: RECT.y + 460 });
  await sleep(120); // capture mid-flight (travel is 300ms)
  await overlay.screenshot({ path: path.join(OUT_DIR, '02-moving-midflight.png') });
  await moveP;

  // ── state: clicking (press dip + ripples) ─────────────────────────────────
  const clickP = dbg('overlay-click', { x: RECT.x + 450, y: RECT.y + 300 });
  await sleep(430); // 300ms travel inside the op + catch ripples early
  const domClick = await overlay.evaluate(() => ({
    ripples: document.querySelectorAll('.ripple').length,
    text: document.getElementById('btext').textContent,
  }));
  await overlay.screenshot({ path: path.join(OUT_DIR, '03-clicking-ripple.png') });
  await clickP;
  if (domClick.ripples < 1) fail('no click ripple rendered');
  if (domClick.text !== 'Clicking') fail(`click bubble text: ${domClick.text}`);

  // ── state: typing (dots + live preview) ───────────────────────────────────
  await dbg('overlay-typing', { text: 'Hello from Pi — background typing' });
  await sleep(250);
  const domType = await overlay.evaluate(() => ({
    text: document.getElementById('btext').textContent,
    dots: document.getElementById('bdots').classList.contains('on'),
  }));
  await overlay.screenshot({ path: path.join(OUT_DIR, '04-typing.png') });
  if (!domType.text.startsWith('Typing') || !domType.text.includes('Hello from Pi')) {
    fail(`typing bubble text: ${domType.text}`);
  }
  if (!domType.dots) fail('typing dots not shown');

  // ── state: key combo label ────────────────────────────────────────────────
  await dbg('overlay-key', { combo: 'cmd+shift+s' });
  await sleep(200);
  const domKey = await overlay.evaluate(() => document.getElementById('btext').textContent);
  await overlay.screenshot({ path: path.join(OUT_DIR, '05-key-combo.png') });
  if (domKey !== 'Pressing ⌘⇧S') fail(`key bubble label: ${domKey}`);

  // ── dark backdrop variant (glow must read on dark too) ────────────────────
  await overlay.evaluate(() => {
    document.body.style.background = '#1e2030';
  });
  await dbg('overlay-status', { status: 'thinking' });
  await dbg('overlay-cursor', { x: RECT.x + 520, y: RECT.y + 260 });
  await sleep(500);
  await overlay.screenshot({ path: path.join(OUT_DIR, '06-thinking-dark.png') });

  // ── hide puts the phantom away ────────────────────────────────────────────
  await dbg('overlay-hide');
  const hidden = await dbg('overlay-info');
  if (hidden.result?.visible !== false) fail('overlay still visible after overlay-hide');

  console.log(`mac-overlay-probe OK — shots in ${OUT_DIR}`);
} finally {
  await app.close();
}
