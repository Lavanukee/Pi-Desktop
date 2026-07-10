#!/usr/bin/env node
/**
 * Visual verification harness: builds the Ladle site, serves it locally, and
 * screenshots EVERY story under all 4 flavor/mode combos with playwright-core
 * headless Chromium, then writes an HTML contact sheet.
 *
 * Usage: node scripts/screenshot-stories.mjs [--skip-build] [--out <dir>]
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = path.join(pkgDir, 'build');
const args = process.argv.slice(2);
const outDir = args.includes('--out')
  ? path.resolve(args[args.indexOf('--out') + 1])
  : path.join(pkgDir, 'screenshots');

const COMBOS = [
  { flavor: 'claude', mode: 'light' },
  { flavor: 'claude', mode: 'dark' },
  { flavor: 'codex', mode: 'light' },
  { flavor: 'codex', mode: 'dark' },
];

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

function serve(dir) {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = path.join(dir, urlPath === '/' ? 'index.html' : urlPath);
    if (!existsSync(file)) file = path.join(dir, 'index.html'); // SPA fallback
    try {
      const body = readFileSync(file);
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function resolveChromium() {
  const bundled = chromium.executablePath();
  if (bundled && existsSync(bundled)) return { executablePath: bundled };
  const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (existsSync(systemChrome)) return { executablePath: systemChrome };
  throw new Error('No Chromium found: install playwright browsers or Google Chrome.');
}

async function main() {
  if (!args.includes('--skip-build') || !existsSync(path.join(buildDir, 'meta.json'))) {
    console.log('building ladle…');
    execSync('pnpm exec ladle build', { cwd: pkgDir, stdio: 'inherit' });
  }

  const meta = JSON.parse(readFileSync(path.join(buildDir, 'meta.json'), 'utf8'));
  const storyIds = Object.keys(meta.stories);
  if (storyIds.length === 0) throw new Error('no stories found in meta.json');

  mkdirSync(outDir, { recursive: true });
  const { server, port } = await serve(buildDir);
  const launchOpts = await resolveChromium();
  const browser = await chromium.launch({ headless: true, ...launchOpts });
  const context = await browser.newContext({
    viewport: { width: 920, height: 760 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  const shots = [];
  for (const story of storyIds) {
    for (const { flavor, mode } of COMBOS) {
      const url = `http://127.0.0.1:${port}/?story=${story}&mode=preview&theme=${mode}&flavor=${flavor}`;
      await page.goto(url, { waitUntil: 'networkidle' });
      // Let fonts settle and entrance animations finish.
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(700);
      const file = `${story}--${flavor}-${mode}.png`;
      await page.screenshot({ path: path.join(outDir, file), fullPage: true });
      shots.push({ story, flavor, mode, file });
      process.stdout.write(`\r${shots.length}/${storyIds.length * COMBOS.length} ${file}     `);
    }
  }
  process.stdout.write('\n');

  await browser.close();
  server.close();

  const rows = storyIds
    .map((story) => {
      const cells = COMBOS.map(({ flavor, mode }) => {
        const file = `${story}--${flavor}-${mode}.png`;
        return `<figure><img loading="lazy" src="${file}" alt="${story} ${flavor} ${mode}"><figcaption>${flavor} · ${mode}</figcaption></figure>`;
      }).join('\n');
      return `<section><h2>${story}</h2><div class="grid">${cells}</div></section>`;
    })
    .join('\n');

  const html = `<!doctype html>
<meta charset="utf-8">
<title>Pi Desktop UI — story contact sheet</title>
<style>
  body { font: 13px/1.5 system-ui, sans-serif; margin: 24px; background: #eee; color: #111; }
  h1 { font-size: 18px; }
  h2 { font-size: 13px; font-family: ui-monospace, monospace; margin: 28px 0 8px; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
  figure { margin: 0; background: #fff; border-radius: 6px; padding: 6px; box-shadow: 0 1px 3px rgba(0,0,0,.15); }
  img { width: 100%; height: auto; display: block; border-radius: 4px; }
  figcaption { color: #666; font-size: 11px; padding-top: 4px; }
</style>
<h1>Pi Desktop UI — every story × claude/codex × light/dark (${shots.length} shots)</h1>
${rows}`;
  writeFileSync(path.join(outDir, 'contact-sheet.html'), html);
  console.log(`wrote ${shots.length} screenshots + contact-sheet.html to ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
