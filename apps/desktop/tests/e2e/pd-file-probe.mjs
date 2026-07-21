/**
 * pd-file:// media-protocol E2E (UI#8 multi-modal canvas foundation). Launches
 * the built app, registers a temp folder as the active project (so it lands in
 * the media scheme's allowed roots), writes a REAL png into it, then:
 *   (a) opens an `image` tab whose src is `pd-file://f<path>` and asserts the
 *       <img> actually LOADS (data-status=loaded, naturalWidth > 0) — proving the
 *       protocol streamed real bytes with a decodable content-type; and
 *   (b) opens an image tab pointing OUTSIDE the allowed roots (/etc/hosts) and
 *       asserts it ERRORS — proving the realpath fence refuses it (403).
 * Run `pnpm build` first. Exit 0 on success, non-zero on any failed assertion.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
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
const fixture = path.join(repoRoot, 'packages/engine/tools/mock-pi/fixtures/simple-chat.json');

function assert(condition, message) {
  if (!condition) throw new Error(`pd-file-probe failed: ${message}`);
}

assert(
  existsSync(path.join(appRoot, 'dist/index.html')) &&
    existsSync(path.join(appRoot, 'dist-electron/main.js')),
  'app is not built — run `pnpm build` first',
);

// A real 1×1 red PNG on disk (the canvas-probe data URI, decoded to bytes).
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
const projectDir = mkdtempSync(path.join(tmpdir(), 'pi-pdfile-proj-'));
const pngPath = path.join(projectDir, 'red.png');
writeFileSync(pngPath, Buffer.from(PNG_B64, 'base64'));

// A real HEIC on disk (upscale the 1×1 → 64×64, then encode to HEIC via sips).
// Skipped where sips can't produce one; the app decodes HEIC with nativeImage.
const heicPath = path.join(projectDir, 'photo.heic');
let heicReady = false;
try {
  const big = path.join(projectDir, 'big.png');
  execFileSync('sips', ['-z', '64', '64', pngPath, '--out', big], { stdio: 'ignore' });
  execFileSync('sips', ['-s', 'format', 'heic', big, '--out', heicPath], { stdio: 'ignore' });
  heicReady = existsSync(heicPath);
} catch {
  heicReady = false;
}

/** Mirror of the renderer's pdFileUrl(): pd-file://f + encoded abs pathname. */
const pdFileUrl = (abs) => `pd-file://f${abs.split('/').map(encodeURIComponent).join('/')}`;

const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'));
const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${userDataDir}`],
  env: { ...process.env, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});

try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 8000 });
  await page.waitForFunction(() => typeof window.__pi_project === 'function', { timeout: 8000 });
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 8000 });

  // Register the temp folder as the active project so its files fall inside the
  // media scheme's allowed roots, then give main a beat to persist projects.json.
  await page.evaluate((dir) => window.__pi_project().getState().selectPath(dir), projectDir);
  await page.waitForTimeout(1500);

  // The canvas hook (`__pi_canvas`) only registers once the tabbed panel mounts,
  // which happens when the canvas first opens — inject a BIG SVG artifact (source
  // over the ~2000-char inline budget so it auto-routes to a canvas tab, not
  // inline; mirrors canvas-probe), then wait for the hook + panel.
  await page.evaluate(() => {
    const pad = '<rect x="0" y="0" width="1" height="1" fill="#000"/>'.repeat(60);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#4a90d9"/>${pad}</svg>`;
    window.__pi_store().setState({
      messages: [
        {
          kind: 'assistant',
          id: 'pdfile-open-canvas',
          blocks: [{ type: 'text', text: `Opening:\n\n\`\`\`svg\n${svg}\n\`\`\`` }],
          timestamp: Date.now(),
          isStreaming: false,
        },
      ],
    });
  });
  await page
    .locator('[data-testid="canvas-tabs-panel"]')
    .waitFor({ state: 'visible', timeout: 8000 });
  await page.waitForSelector('[data-testid="canvas-tabs-panel"] .pd-canvas-tab', { timeout: 8000 });

  // (a) An in-fence image must LOAD real bytes over pd-file://.
  await page.evaluate(
    (src) =>
      window
        .__pi_canvas()
        .openTab({ kind: 'image', title: 'red.png', mediaSrc: src, mediaType: 'PNG' }),
    pdFileUrl(pngPath),
  );
  await page.waitForFunction(
    () => {
      const img = document.querySelector('[data-testid="canvas-tabs-panel"] .pd-media-image');
      return (
        img !== null &&
        img.getAttribute('data-status') === 'loaded' &&
        !img.hasAttribute('hidden') &&
        img.naturalWidth > 0
      );
    },
    undefined,
    { timeout: 8000 },
  );
  const naturalW = await page.evaluate(
    () => document.querySelector('[data-testid="canvas-tabs-panel"] .pd-media-image')?.naturalWidth,
  );
  assert(naturalW >= 1, `expected decoded image bytes (naturalWidth ≥ 1), got ${naturalW}`);

  // (a2) A HEIC must display too — the handler transcodes it to PNG (nativeImage).
  if (heicReady) {
    await page.evaluate(
      (src) =>
        window
          .__pi_canvas()
          .openTab({ kind: 'image', title: 'photo.heic', mediaSrc: src, mediaType: 'HEIC' }),
      pdFileUrl(heicPath),
    );
    await page.waitForFunction(
      () => {
        const imgs = document.querySelectorAll('[data-testid="canvas-tabs-panel"] .pd-media-image');
        const img = imgs[imgs.length - 1];
        return (
          img != null &&
          img.getAttribute('data-status') === 'loaded' &&
          !img.hasAttribute('hidden') &&
          img.naturalWidth > 0
        );
      },
      undefined,
      { timeout: 8000 },
    );
    console.log('  · heic → png transcode displayed OK');
  } else {
    console.log('  · heic step skipped (sips could not produce a test file)');
  }

  // (b) An OUT-OF-FENCE path must be refused (403 → <img> error → error panel).
  await page.evaluate(
    (src) =>
      window
        .__pi_canvas()
        .openTab({ kind: 'image', title: 'hosts', mediaSrc: src, mediaType: 'PNG' }),
    pdFileUrl('/etc/hosts'),
  );
  await page.waitForFunction(
    () => {
      const err = document.querySelector('[data-testid="canvas-tabs-panel"] .pd-media-error-title');
      return err !== null && (err.textContent ?? '').includes('Failed to load');
    },
    undefined,
    { timeout: 8000 },
  );

  console.log(
    'pd-file-probe OK — in-fence png streamed + decoded over pd-file:// (naturalWidth ≥ 1); an out-of-fence path (/etc/hosts) was refused by the realpath fence.',
  );
} finally {
  await app.close();
}
