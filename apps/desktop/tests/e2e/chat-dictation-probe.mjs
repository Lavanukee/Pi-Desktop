import { mkdtempSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';
const require = createRequire(import.meta.url);
const appRoot = '/Users/jedd/Desktop/OSS-harness/apps/desktop';
const app = await electron.launch({
  executablePath: require('electron'),
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(),'mic-udd-'))}`],
  env: { ...process.env, HOME: realpathSync(mkdtempSync(path.join(tmpdir(),'mic-home-'))),
         PI_BIN: '/Users/jedd/Desktop/OSS-harness/packages/engine/tools/mock-pi/mock-pi.mjs', PI_E2E: '1' },
});
const page = await app.firstWindow();
page.on('console', (m) => console.log('  [console]', m.type(), m.text().slice(0, 200)));
page.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 200)));
await page.waitForSelector('[data-testid="composer-mic"]', { timeout: 20000 });
const box = await page.locator('[data-testid="composer-mic"]').boundingBox();
console.log('  mic button present:', JSON.stringify(box));
// Click it: with no mic permission in a headless-ish run it must fail CLEANLY.
// Ask the page directly what getUserMedia does here, before touching the UI.
const probe = await page.evaluate(async () => {
  if (navigator.mediaDevices?.getUserMedia === undefined) return 'no mediaDevices API';
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    const n = s.getAudioTracks().length;
    for (const t of s.getTracks()) t.stop();
    return `granted, ${n} audio track(s)`;
  } catch (e) {
    return `${e.name}: ${e.message}`;
  }
});
console.log('  getUserMedia:', probe);
const devices = await page.evaluate(async () =>
  (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput').length);
console.log('  audio input devices:', devices);
await page.click('[data-testid="composer-mic"]');
await page.waitForTimeout(2500);
const bar = await page.locator('[data-testid="dictation-bar"]').count();
const err = await page.evaluate(() => document.body.innerText.match(/[Mm]icrophone[^\n]*/)?.[0] ?? null);
console.log('  dictation bar shown:', bar, '| message:', err);
console.log('  app still alive:', !page.isClosed());
await app.close();
