/**
 * dictation-probe.mjs — drive the REAL microphone path end to end.
 *
 * Real speech goes in at the getUserMedia boundary and the chain runs exactly
 * as it does for a user: AudioWorklet taps 16 kHz float32, chunks go over IPC
 * to the warm recogniser, partials come back as events and appear in the
 * composer, and confirming replaces them with the full-context transcript.
 *
 * WHY NOT THE FAKE MICROPHONE. Chromium's `--use-file-for-fake-audio-capture`
 * is accepted here and then delivers SILENCE — MEASURED, peak RMS 0.0000 at
 * both 16 kHz and 48 kHz, with and without echo cancellation. So the probe
 * decodes the WAV in the page and hands the recorder a MediaStream carrying it.
 * Everything above the OS capture layer is the real code path; the OS capture
 * layer itself is the one thing this cannot prove.
 *
 * That matters because the parts are individually testable and the SEAMS are
 * where this has broken before: a `data:` worklet the CSP refuses, an ffmpeg
 * that a GUI process cannot see on PATH, a permission handler that was never
 * registered. Every one of those passed a unit test and failed on a click.
 *
 *   WAV        16-bit PCM mono to feed the fake mic (required)
 *   RECORD_MS  how long to "speak" before confirming (default 12000)
 *   OUT        screenshot dir (default <repo>/.corp-runs/dictation-probe)
 *
 * Exits non-zero when the chain is broken, so it can gate a build.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(appRoot, '../..');

const WAV = process.env.WAV ?? '';
const RECORD_MS = Number(process.env.RECORD_MS ?? 12_000);
const OUT = process.env.OUT ?? path.join(repoRoot, '.corp-runs', 'dictation-probe');
// PACKAGED=1 drives /Applications/Bobble.app instead of the dev tree. Worth
// running: the shipped renderer loads over a different scheme, and `script-src
// 'self'` is exactly the sort of thing that resolves differently there — which
// is how the worklet silently fell back to ScriptProcessor in the first place.
const PACKAGED = process.env.PACKAGED === '1';
const PACKAGED_BIN = '/Applications/Bobble.app/Contents/MacOS/Bobble';

if (WAV === '' || !existsSync(WAV)) {
  console.error('dictation-probe: set WAV=<16-bit PCM mono wav>');
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-dict-udd-'));
const app = await electron.launch({
  executablePath: PACKAGED ? PACKAGED_BIN : electronBinary,
  args: [
    ...(PACKAGED ? [] : [appRoot]),
    `--user-data-dir=${userDataDir}`,
    // Grant + fake the microphone. Without the first flag the permission
    // dialog never resolves headlessly; without the other two there is no
    // audio device at all in a test runner.
    // Auto-grants the permission prompt; the audio itself is injected below.
    '--use-fake-ui-for-media-stream',
  ],
  env: { ...process.env, PI_E2E: '1' },
});

let failed = false;
const fail = (msg) => {
  console.log(`  FAIL ${msg}`);
  failed = true;
};

try {
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 20_000 });
  page.on('console', (m) => {
    const t = m.text();
    if (/dictation|worklet|Permission|CSP|Refused/i.test(t)) console.log(`  [console] ${t}`);
  });

  // Speech in, at the boundary the app actually calls. Also instruments the
  // two things a screenshot cannot show: whether the AudioWorklet was really
  // used (rather than the deprecated fallback), and whether chunks left for
  // main at all.
  const wavBase64 = readFileSync(WAV).toString('base64');
  await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const decodeCtx = new AudioContext();
    const buffer = await decodeCtx.decodeAudioData(bytes.buffer);
    // `piDesktop` comes over contextBridge and is frozen, so the IPC itself
    // cannot be wrapped from here. It does not need to be: a transcript of the
    // spoken words IS proof the chunks arrived.
    window.__probe = { worklet: false, speechSeconds: buffer.duration };

    const RealWorkletNode = window.AudioWorkletNode;
    window.AudioWorkletNode = class extends RealWorkletNode {
      constructor(...a) {
        super(...a);
        window.__probe.worklet = true;
      }
    };
    navigator.mediaDevices.getUserMedia = async () => {
      const ctx = new AudioContext();
      const dest = ctx.createMediaStreamDestination();
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(dest);
      // NOT started here. The app opens the microphone and only then waits for
      // the recogniser to load, so audio played at this moment would be spoken
      // into a gap — which is right for a person (nothing says "Listening" yet)
      // but would make this probe test a random suffix of the fixture.
      window.__probe.play = () => src.start();
      return dest.stream;
    };
  }, wavBase64);

  console.log('1. clicking the mic');
  await page.click('[data-testid="composer-mic"]');

  // The row must appear where the footer controls were, and the +/model/send
  // controls must be gone while it is up.
  await page.waitForSelector('[data-testid="dictation-bar"]', { timeout: 30_000 });
  console.log('   dictation row is up');

  const layout = await page.evaluate(() => {
    const bar = document.querySelector('[data-testid="dictation-bar"]');
    const editor = document.querySelector('[data-testid="composer-input"]');
    const mic = document.querySelector('[data-testid="composer-mic"]');
    const b = bar?.getBoundingClientRect();
    const e = editor?.getBoundingClientRect();
    return {
      belowEditor: b !== undefined && e !== undefined && b.top >= e.bottom - 2,
      editorVisible: e !== undefined && e.height > 0,
      // `hidden` on the normal footer hides the whole control row.
      normalControlsHidden: mic === null || mic.getClientRects().length === 0,
      hasCancel: document.querySelector('[data-testid="dictation-cancel"]') !== null,
      hasConfirm: document.querySelector('[data-testid="dictation-stop"]') !== null,
      bars: document.querySelectorAll('.pd-dictation-bar').length,
    };
  });
  console.log(`   layout: ${JSON.stringify(layout)}`);
  if (!layout.belowEditor) fail('the dictation row is not below the text area');
  if (!layout.editorVisible) fail('the text area is hidden while dictating');
  if (!layout.normalControlsHidden) fail('the +/mic/model/send row is still showing');
  if (!layout.hasCancel) fail('no X button');
  if (!layout.hasConfirm) fail('no confirm button');

  // Waiting for `recording` proves the recogniser loaded and audio is flowing.
  await page.waitForSelector('[data-testid="dictation-bar"][data-phase="recording"]', {
    timeout: 120_000,
  });
  console.log('2. recording — the recogniser is warm');
  await page.evaluate(() => window.__probe.play());

  // The waveform has to MOVE, not just exist. Sample the bar transforms twice.
  const sample = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.pd-dictation-bar')].map((b) => b.style.transform).join('|'),
    );
  const wave1 = await sample();
  await page.waitForTimeout(700);
  const wave2 = await sample();
  if (wave1 === wave2) {
    console.log(
      `   bar levels: ${wave2
        .split('|')
        .map((t) => t.replace(/[^0-9.]/g, ''))
        .join(' ')}`,
    );
    fail('the waveform is not moving');
  } else {
    console.log('   waveform is live');
  }

  const tap = await page.evaluate(() => window.__probe);
  if (!tap.worklet) fail('the AudioWorklet did not load — it fell back to ScriptProcessor');
  else console.log('   AudioWorklet is the capture path (no CSP fallback)');

  // Partials must appear in the composer WHILE recording.
  let sawPartial = '';
  const deadline = Date.now() + RECORD_MS;
  while (Date.now() < deadline) {
    const text = await page.textContent('[data-testid="composer-input"]').catch(() => '');
    if ((text ?? '').trim() !== '') {
      if (sawPartial === '')
        console.log(`3. first live words: ${JSON.stringify(text.slice(0, 60))}`);
      sawPartial = text;
    }
    await page.waitForTimeout(400);
  }
  if (sawPartial === '') fail('no live transcript appeared while recording');
  else console.log(`   partial at confirm time: ${JSON.stringify(sawPartial.slice(0, 90))}`);

  await page.screenshot({ path: path.join(OUT, 'recording.png') });
  // The composer alone: a full-window shot of a mostly-empty chat makes the
  // one row that changed impossible to look at.
  await page
    .locator('.pd-composer')
    .first()
    .screenshot({ path: path.join(OUT, 'composer-recording.png') })
    .catch(() => {});

  console.log('4. confirming');
  await page.click('[data-testid="dictation-stop"]');
  await page.waitForSelector('[data-testid="dictation-bar"]', {
    state: 'detached',
    timeout: 90_000,
  });

  const finalText = (await page.textContent('[data-testid="composer-input"]')) ?? '';
  console.log(`   FINAL: ${JSON.stringify(finalText.trim())}`);
  if (finalText.trim() === '') fail('the composer is empty after confirming');

  // The point of the second pass: the committed text must be BETTER than what
  // was on screen mid-sentence, not merely present. These words are in the
  // fixture and are exactly the ones the streaming decoder mangles.
  // "384" vs "three hundred and eighty four" is the model's own formatting call
  // and it moves with context; either is a correct hearing of the fixture.
  const expected = ['refactor', 'grid coordinates', ['384', 'eighty four']];
  const flat = finalText.toLowerCase().replace(/-/g, ' ');
  const has = (w) => flat.includes(w.toLowerCase());
  const missing = expected
    .filter((w) => (Array.isArray(w) ? !w.some(has) : !has(w)))
    .map((w) => (Array.isArray(w) ? w.join('/') : w));
  if (missing.length > 0) fail(`the final transcript is missing ${missing.join(', ')}`);
  else console.log('   final transcript has the words streaming got wrong');

  const restored = await page.evaluate(
    () => document.querySelector('[data-testid="composer-mic"]')?.getClientRects().length > 0,
  );
  if (!restored) fail('the normal footer controls did not come back');
  else console.log('   footer controls restored');

  await page.screenshot({ path: path.join(OUT, 'after.png') });
  await page
    .locator('.pd-composer')
    .first()
    .screenshot({ path: path.join(OUT, 'composer-after.png') })
    .catch(() => {});
  console.log(`\nscreenshots → ${OUT}`);
} catch (err) {
  console.error(`dictation-probe: ${err.message}`);
  failed = true;
} finally {
  await app.close().catch(() => {});
}

process.exit(failed ? 1 : 0);
