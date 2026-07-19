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
 * Output: <repo>/.corp-runs/pi-3d-observed-run/  (run.jsonl, main.log, poll-*.png, game/)
 */
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
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
  process.env.OBS_PROMPT ??
  'Build a production-ready 3D browser game using Three.js and TypeScript. ' +
    'It should have a start menu, multiple levels, a scoring system, and sound effects.';
const CAP_MS = Number(process.env.OBS_CAP_MIN ?? 100) * 60 * 1000; // launcher safety net (not the run budget)
const POLL_MS = Number(process.env.OBS_POLL_SEC ?? 30) * 1000;

const OUT =
  process.env.OBS_OUT ?? path.join(appRoot, '..', '..', '.corp-runs', 'pi-3d-observed-run');
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
// The DURABLE terminal signal, independent of the renderer: main writes
// outcome-<taskId>.json to the workspace ROOT the moment the run terminates
// (the CEO verdict + timing). This is the source of truth for completion — the
// DOM polls below are best-effort narration that survive the window navigating.
function newestOutcome(sinceMs) {
  if (!existsSync(corpRoot)) return null;
  const files = readdirSync(corpRoot)
    .filter((f) => f.startsWith('outcome-') && f.endsWith('.json'))
    .map((f) => path.join(corpRoot, f))
    .filter((p) => {
      try {
        return statSync(p).mtimeMs >= sinceMs;
      } catch {
        return false;
      }
    })
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return files[0] ?? null;
}
function readOutcome(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
function wsFileCount() {
  const ws = newestWorkspace();
  if (!ws) return 0;
  try {
    return fileTree(ws).length;
  } catch {
    return 0;
  }
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
  // The corp run streams inline in the chat (the model's live output) and, once it
  // promotes, the situation room opens in the canvas with a clickable subagent list.
  const starting = document.querySelector('[data-testid="corp-chat-starting"]');
  const stream = document.querySelector('[data-testid="corp-chat-stream"]');
  const subagents = document.querySelectorAll('[data-testid="subagent-row"]');
  return {
    status: stream !== null ? 'streaming' : starting !== null ? 'starting' : null,
    phase: null,
    contracts: null,
    nodes: subagents.length, // subagents listed in the situation room (>0 ⇒ promoted)
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

  // The corp turn renders inline once the FIRST event is folded — that follows the
  // server boot + the run's first emit, so it can take 30-90s (not the instant the
  // old canvas takeover appeared). A fresh corp workspace dir is an equally good
  // "it started" signal that shows up even before the first event. Wait for EITHER,
  // generously, and only fall back to a send-click if NEITHER appears (so we never
  // double-submit an already-running task).
  let started = false;
  const startDeadline = Date.now() + 150000;
  while (Date.now() < startDeadline) {
    const hasTurn = await page
      .locator('[data-testid="corp-chat-stream"], [data-testid="corp-chat-starting"]')
      .count()
      .then((n) => n > 0)
      .catch(() => false);
    const ws = newestWorkspace();
    const freshWs =
      ws !== null &&
      (() => {
        try {
          return statSync(ws).mtimeMs >= t0;
        } catch {
          return false;
        }
      })();
    if (hasTurn || freshWs) {
      started = true;
      break;
    }
    await page.waitForTimeout(2000);
  }
  if (!started) {
    logline({
      ev: 'no-start-signal',
      note: 'Enter may not have submitted — clicking composer-send once',
    });
    const send = page.locator('[data-testid="composer-send"]');
    if ((await send.count()) > 0) await send.click().catch(() => {});
    // Give the fallback a moment to take.
    await page.waitForTimeout(5000);
  }
  logline({ ev: 'corp-started', started, ...(await page.evaluate(readRoom).catch(() => ({}))) });

  // ── monitor to terminal or cap ─────────────────────────────────────────────
  // Completion is decided by the OUTCOME SIDECAR (durable, renderer-independent),
  // not the DOM — so navigating the window away can no longer strand the monitor
  // at the cap. The DOM read is best-effort narration; the workspace file count is
  // real progress that keeps ticking even when the situation room is off-screen.
  let i = 0;
  let lastPhase = null;
  let outcomeFile = null;
  while (Date.now() - t0 < CAP_MS) {
    await page.waitForTimeout(POLL_MS);
    i += 1;
    const snap = await page.evaluate(readRoom).catch(() => ({ status: null, phase: null }));
    const files = wsFileCount();
    const elapsedMin = Number(((Date.now() - t0) / 60000).toFixed(1));
    logline({ ev: 'poll', i, elapsedMin, files, ...snap });
    await page
      .screenshot({ path: path.join(OUT, `poll-${String(i).padStart(3, '0')}.png`) })
      .catch(() => {});
    if (snap.phase && snap.phase !== lastPhase) {
      lastPhase = snap.phase;
      logline({ ev: 'phase-change', elapsedMin, phase: snap.phase, status: snap.status });
    }
    // Durable terminal signal.
    outcomeFile = newestOutcome(t0);
    if (outcomeFile) {
      const oc = readOutcome(outcomeFile);
      terminal = oc?.outcome === 'failed' ? 'error' : 'done';
      logline({ ev: 'outcome-sidecar', elapsedMin, ...(oc ?? {}) });
      break;
    }
    // DOM fallback (only if the room is still mounted).
    if (snap.status === 'done' || snap.status === 'error' || snap.status === 'aborted') {
      terminal = snap.status;
      break;
    }
    if (snap.status === 'blocked') {
      logline({ ev: 'blocked', note: 'situation room reports blocked — may await a permission' });
    }
  }

  const finalElapsedMin = Number(((Date.now() - t0) / 60000).toFixed(1));
  await page.screenshot({ path: path.join(OUT, 'final.png') }).catch(() => {});
  const final = await page.evaluate(readRoom).catch(() => ({}));
  const outcome = outcomeFile ? readOutcome(outcomeFile) : null;
  logline({
    ev: terminal ? 'TERMINAL' : 'CAP',
    terminal,
    finalElapsedMin,
    verdict: outcome?.verdict ?? null,
    runElapsedMin: outcome?.elapsedMin ?? null,
    ...final,
  });

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

  // Grace so the concluded room stays visible for the observer, then close. The
  // evidence (verdict sidecar + copied game) is already captured, so this is purely
  // watch-time; raise OBS_DONE_GRACE_MIN to leave it up longer.
  const graceMs = Number(process.env.OBS_DONE_GRACE_MIN ?? 12) * 60 * 1000;
  logline({ ev: 'grace', graceMin: graceMs / 60000, note: 'window stays open; evidence captured' });
  await page.waitForTimeout(graceMs);
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
