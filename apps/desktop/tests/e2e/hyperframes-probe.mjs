/**
 * Does the HyperFrames still renderer actually render, and actually SEEK?
 *
 * The unit tests cover timing, naming and document assembly against a fake
 * window. They cannot tell you the thing that matters: whether pinning a paused
 * CSS animation to a virtual clock genuinely produces different pixels per
 * frame. If the seek silently does nothing, every frame renders identically and
 * the whole feature is a directory of duplicate PNGs that looks like a success.
 *
 * So this drives the REAL Electron path and compares the bytes.
 *
 *   npx esbuild tests/e2e/hyperframes-probe.mjs --bundle --platform=node \
    --format=esm --external:electron --outfile=<out>.mjs && npx electron <out>.mjs
 *
 * (bundled because the electron build emits one main.js, not per-module files)
 */
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import { createStillRenderer } from '../../electron/gen/hyperframes-still.ts';
import { openStillWindow } from '../../electron/gen/hyperframes-window.ts';

/** A scene whose only motion is a CSS animation — exactly what the seek drives. */
const SCENE = `
<div class="bar"></div>
<style>
  body { background: #101018; }
  .bar { position: absolute; top: 40%; left: 0; width: 20%; height: 20%;
         background: #ff3b6b; animation: slide 2s linear forwards; }
  @keyframes slide { from { left: 0%; } to { left: 80%; } }
</style>`;

async function main() {
  await app.whenReady();
  const previews = [];
  const dir = mkdtempSync(path.join(tmpdir(), 'hf-probe-'));
  const render = createStillRenderer({
    openWindow: openStillWindow,
    writeFile: async (file, data) => {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(file, data);
    },
  });

  const outputs = await render(
    {
      prompt: SCENE,
      modelId: 'hyperframes',
      width: 480,
      height: 270,
      seconds: 2,
      fps: 2,
      seeds: [7],
    },
    dir,
    (e) => {
      // What the canvas actually consumes: step/total for the readout and
      // previewPath for the live thumbnail. If previewPath is ever absent the
      // render becomes a spinner that resolves all at once — jedd's ask.
      if (e.event === 'progress') {
        previews.push(e.previewPath);
        process.stdout.write(`  frame ${e.step}/${e.total} → ${e.previewPath ?? 'NO PREVIEW'}\n`);
      }
    },
  );

  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.png'))
    .sort();
  console.log(`\nrendered ${outputs.length} frames into ${dir}`);
  if (files.length === 0) {
    console.error('FAIL: no frames on disk');
    app.exit(1);
    return;
  }

  const bytes = files.map((f) => readFileSync(path.join(dir, f)));
  const sizes = bytes.map((b) => b.length);
  console.log(`sizes: ${sizes.join(', ')}`);

  // The real question. Identical frames mean the seek did nothing.
  const distinct = new Set(bytes.map((b) => b.toString('base64'))).size;
  console.log(`distinct frames: ${distinct} of ${files.length}`);

  const first = bytes[0];
  const last = bytes[bytes.length - 1];
  const nonEmpty = sizes.every((s) => s > 1000);
  const moved = !first.equals(last);

  console.log(`\nframes are non-trivial : ${nonEmpty ? 'yes' : 'NO'}`);
  console.log(`first differs from last: ${moved ? 'yes' : 'NO'}`);
  console.log(`seek produced motion   : ${distinct > 1 ? 'yes' : 'NO'}`);

  const livePreviews = previews.filter((p) => typeof p === 'string').length;
  console.log(`live canvas previews  : ${livePreviews} of ${files.length}`);

  const ok = nonEmpty && moved && distinct > 1 && livePreviews === files.length;
  console.log(ok ? '\nPASS — the renderer renders and the seek works.' : '\nFAIL');
  app.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('probe threw:', err);
  app.exit(1);
});
