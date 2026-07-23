/**
 * Deterministic Mac cursor-overlay probe — drives the overlay window DIRECTLY
 * (no real app control, no model, no TCC needed) through the PI_E2E-only
 * `mac:debug` channel and verifies, structurally and visually:
 *
 *   - the overlay window is the tracked rect PLUS a symmetric buffer margin
 *     (so the cursor can protrude past the app edge and the pill renders fully),
 *     always-on-top and non-focusable (a click-through phantom, never a
 *     perceivable window);
 *   - cursor moves land where they were sent (buffer-offset screen→local
 *     mapping) and the DOM reflects each state: Thinking pulse, click ripples,
 *     typing bubble with live text preview, key-combo label;
 *   - the cursor sitting ON the app's own edge is NOT clipped, and the status
 *     pill flips/clamps near a corner instead of being sheared off;
 *   - the overlay follows a controlled-window move LIVE (fast tracker + a
 *     synchronous retarget), not snapping only when the drag is released;
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
  // The window is the tracked rect PLUS a symmetric buffer margin on every side
  // (so the cursor can protrude past the app edge and the pill can render fully).
  const b = winInfo.bounds;
  const bufX = (b.width - RECT.w) / 2;
  const bufY = (b.height - RECT.h) / 2;
  if (bufX <= 0 || bufY <= 0) {
    fail(`overlay window ${JSON.stringify(b)} is not larger than target ${JSON.stringify(RECT)}`);
  }
  if (bufX !== bufY) fail(`overlay buffer asymmetric: x=${bufX} y=${bufY}`);
  const BUFFER = bufX;
  // Centres must align (buffer applied symmetrically), so the padding truly
  // surrounds the tracked window rather than shifting it.
  if (b.x + b.width / 2 !== RECT.x + RECT.w / 2 || b.y + b.height / 2 !== RECT.y + RECT.h / 2) {
    fail(`overlay not centred on target: ${JSON.stringify(b)} vs ${JSON.stringify(RECT)}`);
  }
  if (b.x !== RECT.x - BUFFER || b.y !== RECT.y - BUFFER) {
    fail(`overlay origin ${JSON.stringify(b)} != target-minus-buffer(${BUFFER})`);
  }
  console.log(`window checks OK (buffer=${BUFFER}):`, JSON.stringify(winInfo));

  const info = await dbg('overlay-info');
  if (info.result?.visible !== true) fail('overlay-info says not visible');
  // overlay-info reports the RAW tracked rect (not the padded window).
  const ib = info.result?.bounds;
  if (!ib || ib.x !== RECT.x || ib.y !== RECT.y || ib.w !== RECT.w || ib.h !== RECT.h) {
    fail(`overlay-info bounds ${JSON.stringify(ib)} != tracked rect ${JSON.stringify(RECT)}`);
  }

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
  // Local mapping is offset by the buffer: screen (RECT.x+320) → local 320+BUFFER.
  const expectXform = `translate3d(${320 + BUFFER}px, ${200 + BUFFER}px, 0px)`;
  if (domThinking.transform !== expectXform) {
    fail(`cursor transform ${domThinking.transform} != ${expectXform} (mapping/buffer broken)`);
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

  // ── buffer: cursor AT the app edge must not clip ──────────────────────────
  // Reset the backdrop light and drive the cursor to the tracked window's
  // bottom-right CORNER (a screen point on the app's own edge). With the buffer
  // margin its whole glyph must still render inside the padded window.
  await overlay.evaluate(() => {
    document.body.style.background = '#eceef2';
  });
  await dbg('overlay-status', { status: 'thinking' });
  await dbg('overlay-cursor', { x: RECT.x + RECT.w, y: RECT.y + RECT.h });
  await sleep(450);
  const edge = await overlay.evaluate(() => {
    const c = document.getElementById('cursor').getBoundingClientRect();
    return {
      innerW: window.innerWidth,
      innerH: window.innerHeight,
      rect: { left: c.left, top: c.top, right: c.right, bottom: c.bottom },
    };
  });
  await overlay.screenshot({ path: path.join(OUT_DIR, '07-cursor-at-edge.png') });
  if (
    edge.rect.left < 0 ||
    edge.rect.top < 0 ||
    edge.rect.right > edge.innerW ||
    edge.rect.bottom > edge.innerH
  ) {
    fail(
      `cursor glyph clipped at edge: ${JSON.stringify(edge.rect)} outside ` +
        `0..${edge.innerW} x 0..${edge.innerH}`,
    );
  }

  // ── pill flips / clamps near the edge (never sheared off) ─────────────────
  // The cursor near the right+bottom edge would push the pill (default: right &
  // below the cursor) out of view; it must flip to the other side and stay
  // fully inside the padded window.
  await dbg('overlay-typing', { text: 'Reticulating the edge-anchored pill preview text' });
  await sleep(300);
  const pill = await overlay.evaluate(() => {
    const bub = document.getElementById('bubble');
    const r = bub.getBoundingClientRect();
    return {
      flipX: bub.classList.contains('flip-x'),
      flipY: bub.classList.contains('flip-y'),
      innerW: window.innerWidth,
      innerH: window.innerHeight,
      rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
    };
  });
  await overlay.screenshot({ path: path.join(OUT_DIR, '08-pill-flipped-edge.png') });
  if (!pill.flipX && !pill.flipY) {
    fail(`pill did not flip near the corner: ${JSON.stringify(pill)}`);
  }
  if (
    pill.rect.left < -1 ||
    pill.rect.top < -1 ||
    pill.rect.right > pill.innerW + 1 ||
    pill.rect.bottom > pill.innerH + 1
  ) {
    fail(`pill not clamped inside padded window: ${JSON.stringify(pill)}`);
  }

  // ── live tracking: the overlay follows a window move with NO snap lag ──────
  // Drive the REAL tracking loop off a synthetic bounds source (no TCC / real
  // app). The window must reposition to the target rect + buffer.
  const A = { x: 300, y: 260, w: 760, h: 520 };
  const winBounds = () =>
    app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) =>
        x.webContents.getURL().includes('overlay.html'),
      );
      return w ? w.getBounds() : null;
    });
  await dbg('overlay-fake-control', A);
  await sleep(120);
  let wb = await winBounds();
  const expectPadded = (r) => ({
    x: r.x - BUFFER,
    y: r.y - BUFFER,
    width: r.w + BUFFER * 2,
    height: r.h + BUFFER * 2,
  });
  const eqBounds = (got, want) =>
    got &&
    got.x === want.x &&
    got.y === want.y &&
    got.width === want.width &&
    got.height === want.height;
  if (!eqBounds(wb, expectPadded(A))) {
    fail(`fake-control: window ${JSON.stringify(wb)} != ${JSON.stringify(expectPadded(A))}`);
  }

  // Move the synthetic window; the fast tracker must catch up within a few
  // ticks (this is the drag-follow that used to snap only on release).
  const B = { x: 520, y: 420, w: 760, h: 520 };
  await dbg('overlay-fake-move', B);
  let followed = false;
  for (let i = 0; i < 40 && !followed; i++) {
    await sleep(20);
    wb = await winBounds();
    followed = eqBounds(wb, expectPadded(B));
  }
  if (!followed) {
    fail(
      `tracker did not follow the moved window: ${JSON.stringify(wb)} != ${JSON.stringify(expectPadded(B))}`,
    );
  }
  console.log('live tracking OK: overlay followed the moved window');

  // Synchronous retarget (the tracker's move path) lands in the SAME call — no
  // 'reset' round-trip lag between the window moving and the overlay following.
  const C = { x: 140, y: 180, w: 900, h: 600 };
  await dbg('overlay-retarget', C);
  wb = await winBounds();
  if (!eqBounds(wb, expectPadded(C))) {
    fail(`retarget not synchronous: ${JSON.stringify(wb)} != ${JSON.stringify(expectPadded(C))}`);
  }
  console.log('synchronous retarget OK: overlay followed in the same tick');

  // ── hide puts the phantom away ────────────────────────────────────────────
  await dbg('overlay-hide');
  const hidden = await dbg('overlay-info');
  if (hidden.result?.visible !== false) fail('overlay still visible after overlay-hide');

  console.log(`mac-overlay-probe OK — shots in ${OUT_DIR}`);
} finally {
  await app.close();
}
