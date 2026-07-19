/**
 * OVERNIGHT RUN — launch the built app HEADED, submit a LARGE 3D-game task to the
 * production harness, then HOLD THE APP OPEN indefinitely (never auto-close), so a
 * long unmonitored run's full state (the built game, the situation room, the whole
 * transcript) survives for review in the morning.
 *
 * Deliberately hands-off: it types the prompt once, confirms it started, writes a
 * single startup marker, then just keeps the process (and therefore the Electron
 * window) alive for OBS_HOLD_HOURS. It does NOT poll, screenshot, or close.
 *
 * Run (after `pnpm build`):  node tests/e2e/overnight-run.mjs
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const PROMPT =
  process.env.OBS_PROMPT ??
  'Build a polished, production-ready 3D browser game using Three.js: a third-person ' +
    'endless runner where the player dodges and jumps over procedurally-generated obstacles ' +
    'on an infinite track that speeds up over time. Include a start menu, a live score and ' +
    'distance HUD, particle effects on collision, ambient music and sound effects, and a ' +
    'game-over screen with restart and a saved high score. It should open in a browser ' +
    '(load Three.js via an import map). Organize it into clear modules.';
// How long to hold the window open. Well past the morning; the run finishes into
// the situation room long before this and the window simply stays up until then.
const HOLD_MS = Number(process.env.OBS_HOLD_HOURS ?? 14) * 60 * 60 * 1000;

const OUT = process.env.OBS_OUT ?? path.join(homedir(), 'Desktop', 'pi-overnight-run');
mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, 'overnight.log');
const mark = (obj) =>
  appendFileSync(LOG, `${JSON.stringify({ t: new Date().toISOString(), ...obj })}\n`);

if (
  !existsSync(path.join(appRoot, 'dist/index.html')) ||
  !existsSync(path.join(appRoot, 'dist-electron/main.js'))
) {
  console.error('overnight-run: app not built — run `pnpm build` first');
  process.exit(1);
}

const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-overnight-udd-'));
mark({ ev: 'launching', appRoot, out: OUT, holdHours: HOLD_MS / 3_600_000, prompt: PROMPT });
const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${userDataDir}`],
  env: { ...process.env, PI_DESKTOP_CORP: '1', PI_E2E: '1' },
});
try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 60000 });
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 60000 });
  const input = page.locator('[data-testid="composer-input"]');
  await input.click();
  await input.pressSequentially(PROMPT, { delay: 8 });
  await input.press('Enter');
  mark({ ev: 'submitted' });

  // Confirm the corp turn actually started (a fresh workspace or the inline turn),
  // then fall back to a send-click ONCE if neither appears — so we never leave a
  // typed-but-unsubmitted prompt sitting overnight.
  const started = await page
    .locator('[data-testid="corp-chat-stream"], [data-testid="corp-chat-starting"]')
    .first()
    .waitFor({ timeout: 150000 })
    .then(() => true)
    .catch(() => false);
  if (!started) {
    const send = page.locator('[data-testid="composer-send"]');
    if ((await send.count()) > 0) await send.click().catch(() => {});
  }
  mark({ ev: 'started', started });

  // HOLD: keep the process (and the window) alive. Do nothing else — no polling,
  // no close. The run finishes into the situation room and the window stays up.
  mark({ ev: 'holding', note: 'window stays open; run left unmonitored' });
  await page.waitForTimeout(HOLD_MS);
} catch (err) {
  mark({ ev: 'ERROR', error: err?.message ?? String(err) });
  // Even on an error, hold the window open so whatever state exists survives.
  await new Promise((r) => setTimeout(r, HOLD_MS));
} finally {
  await app.close();
  mark({ ev: 'closed' });
}
