/**
 * BOOT-PROOF probe for the ESM-only-pi-SDK crash fix.
 *
 * Launches the BUILT electron-main (the CJS bundle that used to `require()` the
 * ESM-only pi SDK and die with ERR_PACKAGE_PATH_NOT_EXPORTED before any window
 * appeared) via Playwright with PI_DESKTOP_CORP=1 PI_E2E=1 — the exact env that
 * pulls in the corp role-agent runtime. Asserts:
 *   1. app.firstWindow() resolves within 30s,
 *   2. [data-testid="composer-input"] renders,
 *   3. the captured stdout/stderr contains NEITHER "App threw an error during
 *      load" NOR "ERR_PACKAGE_PATH_NOT_EXPORTED".
 * Captures a screenshot, then closes the app + kills any orphan llama-server.
 */
import { existsSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../apps/desktop');

const screenshotPath = path.join(tmpdir(), `pi-boot-proof-${Date.now()}.png`);

function assert(condition, message) {
  if (!condition) throw new Error(`boot-proof FAILED: ${message}`);
}

assert(
  existsSync(path.join(appRoot, 'dist/index.html')) &&
    existsSync(path.join(appRoot, 'dist-electron/main.js')),
  'app is not built — run the desktop build first',
);

const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-boot-udd-'));
const home = mkdtempSync(path.join(tmpdir(), 'pi-boot-home-'));

let output = '';
const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${userDataDir}`],
  env: { ...process.env, HOME: home, PI_DESKTOP_CORP: '1', PI_E2E: '1' },
});
// Tap the real electron-main stdout/stderr so we can prove the load error is gone.
app.process().stdout?.on('data', (d) => {
  output += d.toString();
});
app.process().stderr?.on('data', (d) => {
  output += d.toString();
});

let ok = false;
try {
  // (1) a window must appear within 30s — the crash never produced one.
  const page = await app.firstWindow({ timeout: 30_000 });
  // (2) the composer must render (proof the renderer mounted, not just a blank shell).
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 30_000 });
  await page.screenshot({ path: screenshotPath });

  // (3) no boot-load crash in the captured main output.
  assert(
    !output.includes('App threw an error during load'),
    `main stdout/stderr contained the load error:\n${output}`,
  );
  assert(
    !output.includes('ERR_PACKAGE_PATH_NOT_EXPORTED'),
    `main stdout/stderr contained ERR_PACKAGE_PATH_NOT_EXPORTED:\n${output}`,
  );
  ok = true;
  console.log(`boot-proof OK — window + composer appeared, no load error. screenshot: ${screenshotPath}`);
} finally {
  try {
    await app.close();
  } catch {
    // best-effort
  }
}

if (!ok) process.exit(1);
