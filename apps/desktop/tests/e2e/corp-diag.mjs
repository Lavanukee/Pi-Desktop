/**
 * CORP LIVE DIAGNOSTIC — launches the built app, runs a prompt, and dumps the
 * REAL feed / canvas / store state at each poll + at terminal, so live-integration
 * bugs (empty canvas tabs, duplicate indicators, missing product, non-clickable
 * tool calls, web-search failures) can be diagnosed from ground truth instead of
 * screenshots. Read the JSONL it writes; it does NOT rely on the situation room.
 *
 * Run (after pnpm build):  OBS_PROMPT="..." node tests/e2e/corp-diag.mjs
 * Output: <repo>/.corp-runs/pi-corp-diag/diag.jsonl (+ poll-*.png)
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PROMPT =
  process.env.OBS_PROMPT ??
  'Build a single-file browser Snake game. It MUST be one index.html that opens directly in a browser with no build step. Start screen with a Play button, arrow-key controls, growing snake, food, score, game-over restart. Neon styling.';
const OUT = process.env.OBS_OUT ?? path.join(appRoot, '..', '..', '.corp-runs', 'pi-corp-diag');
mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, 'diag.jsonl');
const CAP_MS = Number(process.env.OBS_CAP_MIN ?? 12) * 60 * 1000;
function logline(o) {
  appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), ...o }) + '\n');
}

if (!existsSync(path.join(appRoot, 'dist/index.html'))) {
  console.error('corp-diag: build first');
  process.exit(1);
}

// The in-page probe: everything we want to know about the live corp UI state.
function probe() {
  const out = { canvasTabs: [], feed: null, spinners: 0, toolRows: [], done: false };
  try {
    const cv = window.__pi_canvas?.();
    const st = cv?.getState?.();
    if (st) {
      out.canvasTabs = st.tabs.map((tb) => ({
        kind: tb.kind,
        key: tb.key,
        title: tb.title,
        active: tb.id === st.activeTabId,
        streaming: tb.streaming ?? false,
        artifactLen:
          (tb.artifact && (tb.artifact.text?.length ?? tb.artifact.content?.length)) ?? 0,
        mirrorLen: tb.data?.mirrorText?.length ?? 0,
        added: tb.addedLines ?? null,
      }));
    }
  } catch (e) {
    out.canvasErr = String(e);
  }
  try {
    const cs = window.__corpStore?.getState?.();
    if (cs) {
      const nodes = cs.situation?.chart?.nodes ?? [];
      out.corp = {
        nodeCount: nodes.length,
        nodes: Object.entries(cs.workerBlocks ?? {})
          .map(([id, blocks]) => ({
            id: id.slice(0, 12),
            kinds: blocks.map((b) => b.kind[0]).join(''),
            writes: blocks
              .filter((b) => b.kind === 'text' && /<function=(?:write|edit)>/.test(b.text))
              .map((b) => /<parameter=path>([^<]+)/.exec(b.text)?.[1]?.trim() ?? '?'),
            fileBlocks: blocks
              .filter((b) => b.kind === 'file')
              .map((b) => `${b.path}(+${b.addedLines})`),
          }))
          .filter((n) => n.kinds.length > 0),
      };
    }
  } catch (e) {
    out.corpErr = String(e);
  }
  try {
    const stream = document.querySelector('[data-testid="corp-chat-stream"]');
    if (stream) {
      const txt = stream.innerText ?? '';
      out.feed = { len: txt.length, tail: txt.slice(-700) };
      // count live spinners / working indicators + capture what each one is next to
      const spins = stream.querySelectorAll(
        '.animate-spin, [class*="spinner"], [class*="shimmer"], [data-working="true"], svg[class*="animate"]',
      );
      out.spinners = spins.length;
      out.spinnerTexts = Array.from(spins)
        .slice(0, 6)
        .map((s) =>
          ((s.closest('[class*="chain"],[class*="activity"],div') ?? s).innerText ?? '')
            .replace(/\s+/g, ' ')
            .slice(0, 50),
        );
      out.thinkingCount = (txt.match(/Thinking\.\.\./g) ?? []).length;
      out.done = /(^|\n)\s*Done(\s|$)/.test(txt);
      // subagent-UX probes
      const wm = txt.match(/Waiting for [^\n]{0,60}/);
      out.waitingText = wm ? wm[0] : null;
      out.finishedLine =
        document.querySelector('[data-testid="corp-finished-line"]')?.innerText ?? null;
    }
    // the live activity HUD (ground-truth of what the system thinks it's doing)
    out.hud = (document.querySelector('[data-testid="corp-debug-hud"]')?.innerText ?? '')
      .replace(/\s+/g, ' ')
      .slice(0, 400);
    // situation-room subagent rows (in the canvas situation surface, outside the stream)
    const rows = document.querySelectorAll('[data-testid="subagent-row"]');
    out.subagentRows = Array.from(rows)
      .slice(0, 12)
      .map((r) => ({
        text: (r.innerText ?? '').replace(/\s+/g, ' ').slice(0, 48),
        timer: r.querySelector('[data-testid="subagent-timer"]')?.innerText ?? null,
      }));
    if (stream) {
      const txt2 = stream.innerText ?? '';
      void txt2;
      // tool-call rows + clickability
      const rows = stream.querySelectorAll(
        '.pd-chain-step, [data-testid="tool-step"], [class*="activity"]',
      );
      out.toolRows = Array.from(rows)
        .slice(0, 20)
        .map((r) => ({
          text: (r.innerText ?? '').replace(/\s+/g, ' ').slice(0, 60),
          clickable:
            r.getAttribute('role') === 'button' ||
            typeof r.onclick === 'function' ||
            r.style.cursor === 'pointer' ||
            r.querySelector('button,[role="button"]') !== null,
        }));
    }
  } catch (e) {
    out.feedErr = String(e);
  }
  return out;
}

const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-diag-udd-'));
logline({ ev: 'launching', prompt: PROMPT });
const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${userDataDir}`],
  env: { ...process.env, PI_DESKTOP_CORP: '1', PI_E2E: '1' },
});
const t0 = Date.now();
try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 30000 });
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 30000 });
  const input = page.locator('[data-testid="composer-input"]');
  await input.click();
  await input.pressSequentially(PROMPT, { delay: 8 });
  await input.press('Enter');
  logline({ ev: 'submitted' });
  // True terminal = the durable outcome sidecar (renderer-independent), like the
  // observed launcher — NOT the per-turn "Done" text.
  const corpRoot = path.join(tmpdir(), 'pi-desktop-corp');
  const newestOutcome = () => {
    if (!existsSync(corpRoot)) return null;
    const fs = readdirSync(corpRoot)
      .filter((f) => f.startsWith('outcome-') && f.endsWith('.json'))
      .map((f) => path.join(corpRoot, f))
      .filter((p) => {
        try {
          return statSync(p).mtimeMs >= t0;
        } catch {
          return false;
        }
      })
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    return fs[0] ?? null;
  };
  const listWorkspace = () => {
    if (!existsSync(corpRoot)) return [];
    const dirs = readdirSync(corpRoot)
      .map((d) => path.join(corpRoot, d))
      .filter((p) => {
        try {
          return statSync(p).isDirectory() && statSync(p).mtimeMs >= t0;
        } catch {
          return false;
        }
      });
    const acc = [];
    const walk = (root, base) => {
      for (const n of readdirSync(root)) {
        const p = path.join(root, n);
        const s = statSync(p);
        if (s.isDirectory()) walk(p, base);
        else acc.push({ path: path.relative(base, p), bytes: s.size });
      }
    };
    for (const d of dirs) {
      try {
        walk(d, d);
      } catch {}
    }
    return acc;
  };
  let i = 0;
  let outcomeFile = null;
  let extraPolls = 0;
  while (Date.now() - t0 < CAP_MS) {
    await page.waitForTimeout(5000);
    i += 1;
    const snap = await page.evaluate(probe).catch((e) => ({ probeErr: String(e) }));
    const elapsedMin = Number(((Date.now() - t0) / 60000).toFixed(1));
    const hasBrowserTab = (snap.canvasTabs ?? []).some((tb) => tb.kind === 'browser');
    logline({ ev: 'poll', i, elapsedMin, hasBrowserTab, ...snap });
    await page
      .screenshot({ path: path.join(OUT, `poll-${String(i).padStart(2, '0')}.png`) })
      .catch(() => {});
    outcomeFile = newestOutcome();
    if (outcomeFile) {
      extraPolls += 1;
      if (extraPolls >= 3) break; // capture a few polls AFTER terminal
    }
  }
  const ws = listWorkspace();
  const idx = ws.filter((f) => /index\.html?$/i.test(f.path));
  let verdict = null;
  if (outcomeFile) {
    try {
      verdict = JSON.parse(readFileSync(outcomeFile, 'utf8'));
    } catch {}
  }
  const finalSnap = await page.evaluate(probe).catch(() => ({}));
  logline({
    ev: 'END',
    elapsedMin: Number(((Date.now() - t0) / 60000).toFixed(1)),
    terminal: outcomeFile !== null,
    workspaceFileCount: ws.length,
    indexHtml: idx.map((f) => f.path),
    workspaceSample: ws.slice(0, 30).map((f) => f.path),
    verdictOutcome: verdict?.outcome ?? null,
    verdictLen: (verdict?.verdict ?? '').length,
    finalCanvasTabs: finalSnap.canvasTabs ?? [],
  });
} catch (err) {
  logline({ ev: 'ERROR', error: err?.message ?? String(err) });
} finally {
  await app.close();
}
