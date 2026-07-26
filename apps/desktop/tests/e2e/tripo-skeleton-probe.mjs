import { mkdirSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';
const GLB = process.env.SKEL_GLB;
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
