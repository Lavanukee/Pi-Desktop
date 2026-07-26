import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';
// Default to the newest rig the engine actually produced, so this does not
// depend on a scratch path that a reboot can clear (it did — the probe then
// failed with a raw ENOENT that read like a product bug).
const GLB =
  process.env.SKEL_GLB ??
  execSync(
    'ls -t "$HOME"/.pi/desktop/sandbox/gen3d/*/rigged.glb 2>/dev/null | head -1',
    { shell: '/bin/zsh', encoding: 'utf8' },
  ).trim();
if (GLB.length === 0) {
  console.log('SKIP: no rigged .glb found — run the rig stage first, or set SKEL_GLB');
  process.exit(0);
}
const OUT = '/tmp/skel-ui'; mkdirSync(OUT, { recursive: true });
const app = await electron.launch({
  executablePath: '/Users/jedd/Desktop/OSS-harness/apps/desktop/release/mac-arm64/Bobble.app/Contents/MacOS/Bobble',
  args: [`--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'))}`],
  env: { ...process.env, HOME: homedir(), PI_E2E: '1', PI_DESKTOP_TRIPO: '1' },
});
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
await win.waitForSelector('[data-testid="tp-rightpanel"]', { timeout: 120_000 });
await win.setInputFiles('[data-testid="tp-upload-card-input"]', GLB);
await win.waitForFunction(() => document.querySelectorAll('.tp-asset-card').length > 0, undefined, { timeout: 60_000 });
await win.waitForTimeout(4000);
const btn = await win.$('[data-testid="tp-skeleton-btn"]');
console.log('skeleton button present:', btn !== null);
if (btn === null) { console.log('FAIL: no skeleton toggle for a rigged model'); await app.close(); process.exit(1); }
await win.screenshot({ path: path.join(OUT, '01-off.png') });
await btn.click();
await win.waitForTimeout(1500);
await win.screenshot({ path: path.join(OUT, '02-on.png') });
const active = await win.getAttribute('[data-testid="tp-skeleton-btn"]', 'data-active');
console.log('toggle active after click:', active);
console.log('shots in', OUT);
await app.close().catch(() => {});
