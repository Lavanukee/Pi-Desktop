/**
 * OBSERVED 3D-GAME RUN — the acceptance gate.
 *
 * Launches the BUILT app HEADED with the production harness on
 * (PI_DESKTOP_CORP=1), types the Three.js prompt into the composer exactly as a
 * user would (char-by-char, so it's visibly typed), submits, and then monitors
 * the LIVE situation room to a terminal state — logging phase/progress every 30s
 * with a screenshot each poll, so the run can be narrated + reviewed. The app
 * stays visible the whole time. On termination it captures the produced game
 * from the corp workspace into the output dir.
 *
 * Run (after `pnpm build`):  node tests/e2e/observed-3d-run.mjs
 * Output: ~/Desktop/pi-3d-observed-run/  (run.jsonl, main.log, poll-*.png, game/)
 */
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const PROMPT =
  'Build a production-ready 3D browser game using Three.js and TypeScript. ' +
  'It should have a start menu, multiple levels, a scoring system, and sound effects.';
const CAP_MS = Number(process.env.OBS_CAP_MIN ?? 100) * 60 * 1000; // safety net above the 90-min budget
const POLL_MS = Number(process.env.OBS_POLL_SEC ?? 30) * 1000;

const OUT = process.env.OBS_OUT ?? path.join(homedir(), 'Desktop', 'pi-3d-observed-run');
mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, 'run.jsonl');
const MAIN_LOG = path.join(OUT, 'main.log');
function logline(obj) {
  const rec = { t: new Date().toISOString(), ...obj };
  appendFileSync(LOG, JSON.stringify(rec) + '\n');
  console.log(JSON.stringify(rec));
}

// ── preflight ──────────────────────────────────────────────────────────────
if (
  !existsSync(path.join(appRoot, 'dist/index.html')) ||
  !existsSync(path.join(appRoot, 'dist-electron/main.js'))
) {
  console.error('observed-3d-run: app not built — run `pnpm build` first');
  process.exit(1);
}
const modelPath = path.join(
  homedir(),
  '.cache/pi-desktop/models',
  'qwen3.5-4b-mtp',
  'Qwen3.5-4B-Q8_0.gguf',
);
if (!existsSync(modelPath)) {
  console.error(
    `observed-3d-run: corp model missing at ${modelPath} — download qwen3.5-4b-mtp Q8_0`,
  );
  process.exit(1);
}

// The corp workspace root (main uses app.getPath('temp')/pi-desktop-corp).
const corpRoot = path.join(tmpdir(), 'pi-desktop-corp');
function newestWorkspace() {
  if (!existsSync(corpRoot)) return null;
  const dirs = readdirSync(corpRoot)
    .map((d) => path.join(corpRoot, d))
    .filter((p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    })
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return dirs[0] ?? null;
}
function fileTree(root, base = root, acc = []) {
  if (acc.length > 400) return acc;
  for (const name of readdirSync(root)) {
    const p = path.join(root, name);
    const st = statSync(p);
    if (st.isDirectory()) fileTree(p, base, acc);
    else acc.push({ path: path.relative(base, p), bytes: st.size });
  }
  return acc;
}

// ── launch (HEADED) ──────────────────────────────────────────────────────────
const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-observed-udd-'));
logline({ ev: 'launching', appRoot, out: OUT, prompt: PROMPT });
const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${userDataDir}`],
  env: { ...process.env, PI_DESKTOP_CORP: '1', PI_E2E: '1' },
});
const proc = app.process();
proc.stdout?.on('data', (d) => appendFileSync(MAIN_LOG, d));
proc.stderr?.on('data', (d) => appendFileSync(MAIN_LOG, d));

function readRoom() {
  const room = document.querySelector('[data-testid="situation-room"]');
  return {
    status: room?.getAttribute('data-status') ?? null,
    phase: document.querySelector('.pd-sitroom-phase')?.textContent?.trim() ?? null,
    contracts: document.querySelector('.pd-sitroom-contracts')?.textContent?.trim() ?? null,
    nodes: document.querySelectorAll('.pd-sitroom-node').length,
  };
}

const t0 = Date.now();
let terminal = null;
try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 30000 });
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 30000 });
  logline({ ev: 'app-ready' });

  // Type the prompt like a user (visible), then submit with Enter.
  const input = page.locator('[data-testid="composer-input"]');
  await input.click();
  await input.pressSequentially(PROMPT, { delay: 15 });
  await page.screenshot({ path: path.join(OUT, 'typed.png') });
  logline({ ev: 'prompt-typed' });
  await input.press('Enter');

  // The situation room takes over the canvas. If Enter didn't submit, click Send.
  try {
    await page.waitForSelector('[data-testid="situation-room"]', { timeout: 20000 });
  } catch {
    logline({ ev: 'enter-no-submit', note: 'falling back to composer-send click' });
    const send = page.locator('[data-testid="composer-send"]');
    if ((await send.count()) > 0) await send.click();
    await page.waitForSelector('[data-testid="situation-room"]', { timeout: 30000 });
  }
  logline({ ev: 'situation-room-open', ...(await page.evaluate(readRoom)) });

  // ── monitor to terminal or cap ─────────────────────────────────────────────
  let i = 0;
  let lastPhase = null;
  while (Date.now() - t0 < CAP_MS) {
    await page.waitForTimeout(POLL_MS);
    i += 1;
    const snap = await page.evaluate(readRoom);
    const elapsedMin = Number(((Date.now() - t0) / 60000).toFixed(1));
    logline({ ev: 'poll', i, elapsedMin, ...snap });
    await page.screenshot({ path: path.join(OUT, `poll-${String(i).padStart(3, '0')}.png`) });
    if (snap.phase && snap.phase !== lastPhase) {
      lastPhase = snap.phase;
      logline({ ev: 'phase-change', elapsedMin, phase: snap.phase, status: snap.status });
    }
    if (snap.status === 'done' || snap.status === 'error' || snap.status === 'aborted') {
      terminal = snap.status;
      break;
    }
    if (snap.status === 'blocked') {
      logline({ ev: 'blocked', note: 'situation room reports blocked — may await a permission' });
    }
  }

  const finalElapsedMin = Number(((Date.now() - t0) / 60000).toFixed(1));
  await page.screenshot({ path: path.join(OUT, 'final.png') });
  const final = await page.evaluate(readRoom);
  logline({ ev: terminal ? 'TERMINAL' : 'CAP', terminal, finalElapsedMin, ...final });

  // Capture the produced game from the corp workspace.
  const ws = newestWorkspace();
  if (ws) {
    const tree = fileTree(ws);
    const totalBytes = tree.reduce((s, f) => s + f.bytes, 0);
    logline({ ev: 'workspace', ws, fileCount: tree.length, totalBytes });
    try {
      cpSync(ws, path.join(OUT, 'game'), { recursive: true });
      logline({ ev: 'game-copied', to: path.join(OUT, 'game') });
    } catch (e) {
      logline({ ev: 'game-copy-failed', error: e?.message ?? String(e) });
    }
  } else {
    logline({ ev: 'workspace', ws: null, note: 'no corp workspace found' });
  }

  // Brief grace so the concluded room is visible, then close.
  await page.waitForTimeout(15000);
} catch (err) {
  logline({ ev: 'ERROR', error: err?.message ?? String(err) });
  try {
    const p = await app.firstWindow();
    await p.screenshot({ path: path.join(OUT, 'error.png') });
  } catch {
    /* ignore */
  }
} finally {
  await app.close();
  logline({ ev: 'closed', terminal, elapsedMin: Number(((Date.now() - t0) / 60000).toFixed(1)) });
}
