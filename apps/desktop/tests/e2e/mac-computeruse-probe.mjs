/**
 * REAL end-to-end Mac computer-use probe — a LOCAL MODEL drives a REAL app in
 * the background:
 *
 *   model → mac_launch TextEdit (opens WITHOUT focus, returns snapshot +
 *   screenshot in the same tool result) → mac_type the marker into the
 *   document (background AX setValue, pid-routed) → probe re-snapshots
 *   TextEdit and finds the marker in the text area's AX value.
 *
 * Assertions are STRUCTURAL (no OCR): the launch tool-result text carries the
 * indexed snapshot + the screenshot-attached marker; the session controls
 * TextEdit; TextEdit is NEVER the frontmost app at any poll during the run
 * (background-only guarantee); the cursor overlay is visible and never
 * focused; a final helper snapshot contains the typed marker.
 *
 * GUARDS (all print a clear SKIP, never a fake pass):
 *   - PI_MAC_E2E=1 required (this drives a real app on the machine);
 *   - Accessibility + Screen Recording must be granted to the dev Electron
 *     binary — the probe checks first and prints EXACTLY what to grant;
 *   - the local model must be downloaded (default qwen3.5-4b-mtp, override
 *     MAC_CU_MODEL).
 *
 * Run `npm run build` first. Artifacts → $TMPDIR/mac-cu-shots (override
 * MAC_CU_OUT). TextEdit is quit afterwards ONLY if the probe started it.
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
const OUT_DIR = process.env.MAC_CU_OUT ?? path.join(tmpdir(), 'mac-cu-shots');
const MODEL_ID = process.env.MAC_CU_MODEL ?? 'qwen3.5-4b-mtp';
const MARKER = `PI-MAC-E2E-${Date.now().toString(36).toUpperCase()}`;

const fail = (m) => {
  throw new Error(`mac-computeruse-probe FAILED: ${m}`);
};
const skip = (m) => {
  console.log(`mac-computeruse-probe: SKIP — ${m}`);
  console.log('(a skipped probe is NOT a pass)');
  process.exit(0);
};

if (process.platform !== 'darwin') skip('macOS only');
if (process.env.PI_MAC_E2E !== '1') {
  skip('set PI_MAC_E2E=1 to run (it launches + types into a real TextEdit on this machine)');
}
if (!existsSync(path.join(appRoot, 'dist/index.html'))) {
  console.error('mac-computeruse-probe: app not built — run `npm run build` first');
  process.exit(1);
}
mkdirSync(OUT_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'))}`],
  // Real pi (no PI_BIN) against the real ~/.pi; PI_MAC_PRECONSENT lets the
  // headless run skip the one-time consent dialog (e2e-only seam).
  env: { ...process.env, PI_E2E: '1', PI_MAC_PRECONSENT: '1' },
});

let launchedTextEdit = false;

try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 20000 });

  const dbg = async (op, params) => {
    const res = await page.evaluate((req) => window.piDesktop.invoke('mac:debug', req), {
      op,
      params,
    });
    if (res.ok !== true) throw new Error(`mac:debug ${op}: ${res.error}`);
    return res.result;
  };

  // ── TCC reality check (through the APP's helper — grants attribute to the
  //    spawning binary, so checking any other way would lie) ────────────────
  const tcc = await dbg('check');
  console.log('TCC status (dev Electron identity):', JSON.stringify(tcc));
  if (tcc.accessibility !== true || tcc.screenRecording !== true) {
    // Surface the system dialogs / register the binary in System Settings so
    // granting is a one-click toggle (this does NOT grant anything itself).
    try {
      await dbg('promptGrants');
      console.log('(triggered the macOS permission prompts — check System Settings)');
    } catch {
      /* best-effort */
    }
    console.log('');
    console.log('Mac computer-use needs two grants for the DEV Electron binary:');
    console.log('  System Settings → Privacy & Security → Accessibility  → enable "Electron"');
    console.log('  System Settings → Privacy & Security → Screen Recording → enable "Electron"');
    console.log(`  (the binary living under ${path.dirname(String(electronBinary))})`);
    console.log('  If Electron is not listed, launch the app once, trigger a mac_* tool, and');
    console.log('  macOS will add it; or drag the binary in with the “+” button.');
    skip(
      `TCC not granted (accessibility=${tcc.accessibility}, screenRecording=${tcc.screenRecording})`,
    );
  }

  // Was TextEdit already running? (Decides cleanup, and an already-open
  // TextEdit makes the "we typed into a fresh document" assertion mushy.)
  const wasRunning = await (async () => {
    try {
      await dbg('bounds', { app: 'TextEdit' });
      return true;
    } catch {
      return false;
    }
  })();
  console.log('TextEdit already running before probe:', wasRunning);

  // ── model up ──────────────────────────────────────────────────────────────
  const started = await page.evaluate(
    (id) => window.piDesktop.invoke('llm:start-server', { modelId: id }),
    MODEL_ID,
  );
  if (!started.success) {
    if (/not downloaded/i.test(started.error ?? '')) skip(`${MODEL_ID} not downloaded`);
    fail(`llm:start-server: ${started.error}`);
  }
  console.log('llm server ready:', started.baseUrl);

  await page.evaluate(() => window.piDesktop.invoke('pi:restart', {}));
  const models = await page.evaluate(() => window.piDesktop.invoke('pi:get-models', undefined));
  const target = models.models.find((m) => m.provider === 'llamacpp');
  if (target === undefined) fail(`no llamacpp model registered: ${JSON.stringify(models)}`);
  await page.evaluate(
    (t) => window.piDesktop.invoke('pi:set-model', { provider: t.provider, modelId: t.id }),
    target,
  );
  console.log('model set:', target.id);

  // ── the real ask ──────────────────────────────────────────────────────────
  const ack = await page.evaluate(
    (marker) =>
      window.piDesktop.invoke('pi:prompt', {
        message:
          'Use your Mac control tools (mac_launch / mac_type) for this task — do NOT use bash ' +
          'or AppleScript. Step 1: call mac_launch with app "TextEdit". Its result includes an ' +
          'indexed element snapshot and a screenshot — read them. Step 2: find the document ' +
          `text area (role AXTextArea) in the snapshot and call mac_type with its index and text "${marker}". ` +
          'Step 3: reply with exactly DONE. Do not open anything else and do not bring TextEdit to the front.',
      }),
    MARKER,
  );
  if (!ack.success) fail(`pi:prompt: ${ack.error}`);
  launchedTextEdit = !wasRunning; // from here on we may have started it

  // ── poll: store progress + frontmost watcher (background-only guarantee) ──
  const snap = () =>
    page.evaluate(() => {
      const ps = window.__pi_store().getState();
      return {
        streaming: ps.agent.isStreaming,
        toolCalls: ps.messages
          .filter((m) => m.kind === 'assistant')
          .flatMap((m) => m.blocks.filter((b) => b.type === 'toolCall').map((b) => b.name)),
        toolResults: ps.messages
          .filter((m) => m.kind === 'toolResult')
          .map((m) => ({ toolName: m.toolName, isError: m.isError, text: m.text })),
        mainText: ps.messages
          .filter((m) => m.kind === 'assistant')
          .flatMap((m) => m.blocks.filter((b) => b.type === 'text').map((b) => b.text))
          .join(' '),
      };
    });

  const frontmostSamples = [];
  let texteditFrontmostCount = 0;
  const deadline = Date.now() + 300_000; // 4B model, generous
  let s = await snap();
  while (Date.now() < deadline) {
    s = await snap();
    try {
      const front = await dbg('frontmost');
      frontmostSamples.push(front.app);
      if (/textedit/i.test(String(front.app))) texteditFrontmostCount += 1;
    } catch {
      /* helper busy — skip this sample */
    }
    const launched = s.toolCalls.some((n) => n === 'mac_launch');
    if (!s.streaming && launched && s.toolResults.length > 0 && s.mainText.length > 0) break;
    await sleep(600);
  }

  console.log('\n=== observed ===');
  console.log('tool calls:', JSON.stringify(s.toolCalls));
  console.log(
    'tool results:',
    JSON.stringify(
      s.toolResults.map((r) => ({
        toolName: r.toolName,
        isError: r.isError,
        text: `${r.text.slice(0, 160)}…`,
      })),
      null,
      1,
    ),
  );
  console.log('main text:', JSON.stringify(s.mainText.slice(0, 300)));
  console.log(
    `frontmost samples: ${frontmostSamples.length}, TextEdit-frontmost: ${texteditFrontmostCount}`,
  );

  await page.screenshot({ path: path.join(OUT_DIR, '01-app-after-run.png') });

  // ── assertions ────────────────────────────────────────────────────────────
  if (!s.toolCalls.includes('mac_launch')) {
    fail(`model never called mac_launch (calls: ${JSON.stringify(s.toolCalls)})`);
  }
  const launchResult = s.toolResults.find((r) => r.toolName === 'mac_launch');
  if (launchResult === undefined) fail('no mac_launch tool result in the transcript');
  if (launchResult.isError) fail(`mac_launch errored: ${launchResult.text.slice(0, 300)}`);

  // Snapshot-after-open contract, as the MODEL saw it: one result carrying the
  // no-focus note, the controlled-app statement, the indexed elements, and the
  // attached-screenshot marker.
  for (const needle of [
    'did NOT take focus',
    'controlling "TextEdit"',
    'Actionable elements',
    'window screenshot is attached',
  ]) {
    if (!launchResult.text.includes(needle)) {
      fail(`mac_launch result missing "${needle}" — got: ${launchResult.text.slice(0, 400)}`);
    }
  }

  if (!s.toolCalls.includes('mac_type')) {
    fail(`model never called mac_type (calls: ${JSON.stringify(s.toolCalls)})`);
  }
  const typeResult = s.toolResults.find((r) => r.toolName === 'mac_type' && !r.isError);
  if (typeResult === undefined) fail('no successful mac_type result');

  // Background-only, the core requirement: at NO sampled moment during the
  // run was TextEdit the frontmost app.
  if (frontmostSamples.length < 5) fail('frontmost watcher barely sampled — probe broken');
  if (texteditFrontmostCount > 0) {
    fail(`TextEdit became frontmost ${texteditFrontmostCount}× — focus was stolen`);
  }

  // The overlay is up over the controlled app and never focused.
  const overlayInfo = await dbg('overlay-info');
  console.log('overlay:', JSON.stringify(overlayInfo));
  if (overlayInfo.visible !== true) fail('cursor overlay not visible during control');
  const overlayFocus = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) =>
      x.webContents.getURL().includes('overlay.html'),
    );
    return w ? { focused: w.isFocused(), alwaysOnTop: w.isAlwaysOnTop() } : null;
  });
  if (overlayFocus === null) fail('overlay window missing in main');
  if (overlayFocus.focused) fail('overlay window took focus');

  // Ground truth: a FRESH helper snapshot of TextEdit contains the marker in
  // an editable element's AX value (structural — no OCR).
  const finalSnap = await dbg('snapshot', { app: 'TextEdit' });
  const hit = (finalSnap.elements ?? []).find(
    (el) => typeof el.value === 'string' && el.value.includes(MARKER),
  );
  if (hit === undefined) {
    fail(
      `typed marker "${MARKER}" not found in TextEdit's AX values: ` +
        JSON.stringify((finalSnap.elements ?? []).map((e) => ({ role: e.role, value: e.value }))),
    );
  }
  console.log(`marker found in TextEdit [${hit.index}] ${hit.role}`);

  // Window screenshot for jedd (focus-free per-window capture).
  const shot = await dbg('screenshot', { app: 'TextEdit' });
  if (shot.base64) {
    writeFileSync(path.join(OUT_DIR, '02-textedit-window.png'), Buffer.from(shot.base64, 'base64'));
  }

  console.log(
    `\nmac-computeruse-probe OK — model opened TextEdit in the background, saw the snapshot in ` +
      `the launch result, typed the marker via background AX, and TextEdit never took focus. ` +
      `Shots in ${OUT_DIR}`,
  );
} finally {
  // Quit TextEdit only if the probe started it (never touch a pre-existing
  // instance — jedd may have unsaved work). Our own untitled doc is discarded.
  if (launchedTextEdit) {
    try {
      await execFileAsync('osascript', ['-e', 'tell application "TextEdit" to quit saving no']);
    } catch {
      /* best-effort cleanup */
    }
  }
  await app.close();
}
