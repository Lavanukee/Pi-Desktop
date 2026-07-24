import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '/Users/jedd/Desktop/OSS-harness/apps/desktop/node_modules/playwright-core/index.mjs';

const DIST = '/Users/jedd/.claude/jobs/8b8d3832/tmp/animgen/dist';
const OUT = '/Users/jedd/Desktop/OSS-harness/apps/desktop/src/tripo/assets/anim-previews';
mkdirSync(OUT, { recursive: true });

const PRESETS = [
  'angry_01', 'afraid', 'agree', 'angry_02', 'cheer', 'clap', 'dance_01', 'hello',
  'idle', 'jump', 'kick', 'point', 'run', 'sad_01', 'walk', 'wave',
];

const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=metal', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
await page.route('http://animgen.local/**', async (route) => {
  const url = new URL(route.request().url());
  let p = url.pathname;
  if (p === '/') p = '/index.html';
  if (p === '/model.fbx') return route.fulfill({ body: readFileSync('/Users/jedd/Downloads/model.fbx'), contentType: 'application/octet-stream' });
  if (p === '/dance.fbx') return route.fulfill({ body: readFileSync('/Users/jedd/Downloads/source/Macarena Dance.fbx'), contentType: 'application/octet-stream' });
  try {
    const body = readFileSync(DIST + p);
    const ct = p.endsWith('.html') ? 'text/html' : p.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
    return route.fulfill({ body, contentType: ct });
  } catch {
    return route.fulfill({ status: 404, body: 'nf' });
  }
});
await page.goto('http://animgen.local/');
await page.waitForFunction(() => window.__ready === 1, undefined, { timeout: 20000 });
const info = await page.evaluate(() => window.__load());
console.log('loaded:', JSON.stringify(info));

let total = 0;
for (const preset of PRESETS) {
  const seconds = preset === 'dance_01' ? 3.2 : 1.6;
  const { webmB64, posterB64 } = await page.evaluate(
    ([p, s]) => window.__record(p, s),
    [preset, seconds],
  );
  const webm = Buffer.from(webmB64, 'base64');
  const poster = Buffer.from(posterB64.split(',')[1], 'base64');
  writeFileSync(`${OUT}/${preset}.webm`, webm);
  writeFileSync(`${OUT}/${preset}.jpg`, poster);
  total += webm.length + poster.length;
  console.log(`  ${preset}: webm ${(webm.length / 1024).toFixed(0)}KB poster ${(poster.length / 1024).toFixed(0)}KB`);
}
console.log(`TOTAL ${(total / 1024 / 1024).toFixed(2)}MB → ${OUT}`);

// Manifest module with static vite-resolvable URLs.
const lines = PRESETS.map(
  (p) =>
    `  ${p}: {\n    video: new URL('./${p}.webm', import.meta.url).href,\n    poster: new URL('./${p}.jpg', import.meta.url).href,\n  },`,
).join('\n');
writeFileSync(
  `${OUT}/index.ts`,
  `/**\n * Animation-preset previews: short REAL skeletal-animation videos rendered\n * offline on the Mixamo humanoid dummy (~/Downloads/model.fbx) — the Macarena\n * clip for dance_01, procedurally-authored bone clips for the rest (see\n * scripts note in AnimatePanel). Cards show the mid-motion JPEG poster and\n * play the webm on hover. Generated assets — do not hand-edit.\n */\nexport interface AnimPreview {\n  readonly video: string;\n  readonly poster: string;\n}\n\nexport const ANIM_PREVIEWS: Record<string, AnimPreview> = {\n${lines}\n};\n`,
);
console.log('manifest written');
await browser.close();
