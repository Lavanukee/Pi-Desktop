/**
 * Round-9 adversarial E2E — LIVE RENDERING (jedd's explicit failure point #1).
 *
 * Drives the app end-to-end via the chat store so the REAL detection + routing
 * path runs (segmentMessageText → useArtifactCanvasRouting → the docked surface):
 *
 *  A. A streamed ```html artifact (>2000 chars, unclosed fence = mid-stream)
 *     auto-opens a canvas HTML tab whose surface is the sandboxed harness iframe
 *     (.pd-canvas-html). The pd-preview:// harness boots and posts {type:'ready'}
 *     to the parent, then {type:'applied', seq} for each morphdom patch — proving
 *     the frame is INTERACTIVE. As more deltas stream, the applied seq climbs and
 *     the SAME iframe DOM node persists (a stamp survives) with an unchanged src:
 *     the frame patches in place, NEVER reloads.
 *  B. The rendered/raw toggle flips the HTML tab to a syntax-highlighted raw
 *     source editor (.pd-canvas-raw .pd-canvas-code) and back.
 *  C. A streamed ```svg artifact routes to a canvas SVG tab (.pd-canvas-svg svg),
 *     updates its drawn marker LIVE across deltas, and its rendered/raw toggle
 *     flips to the raw svg source and back.
 *
 * Cross-origin note: sandbox="allow-scripts" (opaque origin) means the probe
 * cannot read into the iframe; liveness is observed via the frame→parent
 * postMessage side-channel (ready/applied/seq) + DOM node identity, which is the
 * strongest external proof of "interactive, no reload". Run `pnpm build` first.
 */
import { existsSync, mkdtempSync } from 'node:fs';
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
  if (!condition) throw new Error(`round9-live-render-probe failed: ${message}`);
}

assert(
  existsSync(path.join(appRoot, 'dist/index.html')) &&
    existsSync(path.join(appRoot, 'dist-electron/main.js')),
  'app is not built — run `pnpm build` first',
);

const PANEL = '[data-testid="canvas-tabs-panel"]';
const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'));
const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${userDataDir}`],
  env: { ...process.env, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});

/** Push one assistant message (single text block) into the thread. */
const streamText = (page, id, text) =>
  page.evaluate(
    ({ id, text }) => {
      window.__pi_store().setState({
        messages: [
          {
            kind: 'assistant',
            id,
            blocks: [{ type: 'text', text }],
            timestamp: Date.now(),
            isStreaming: true,
          },
        ],
      });
    },
    { id, text },
  );

try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 8000 });
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 8000 });

  // Capture the frame→parent pd-canvas side-channel (ready/applied/resize + seq).
  await page.evaluate(() => {
    window.__pd_frame_msgs = [];
    window.addEventListener('message', (e) => {
      if (e?.data && e.data.channel === 'pd-canvas') {
        window.__pd_frame_msgs.push({ type: e.data.type, seq: e.data.seq ?? null });
      }
    });
  });

  // ── A. Streamed ```html → live canvas iframe, interactive, no reload ─────────
  const htmlBody = (extra) =>
    `<div id="app"><h1>PI-HTML-LIVE</h1>${'<p>filler paragraph for size</p>'.repeat(120)}${extra}</div>`;
  const htmlFence = (extra) => `\`\`\`html\n${htmlBody(extra)}\n`; // UNCLOSED = mid-stream
  assert(htmlBody('').length > 2000, 'html payload must exceed the 2000-char inline budget');

  await streamText(page, 'r9html', htmlFence(''));
  await page.waitForSelector(PANEL, { timeout: 8000 });
  await page.waitForSelector(`${PANEL} .pd-canvas-tabpanel .pd-canvas-html`, { timeout: 8000 });

  // Stamp the iframe node so we can prove identity survives deltas (no remount).
  const iframeSrc = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="canvas-tabs-panel"] .pd-canvas-html');
    el.setAttribute('data-probe-stamp', 'html-1');
    return el.getAttribute('src');
  });
  assert(
    typeof iframeSrc === 'string' && iframeSrc.startsWith('pd-preview://'),
    `html iframe src should be the pd-preview harness, got ${JSON.stringify(iframeSrc)}`,
  );

  // The harness must actually boot inside the sandboxed frame → it posts 'ready'
  // to the parent. This is the proof the frame is a live, scriptable surface.
  await page.waitForFunction(
    () => (window.__pd_frame_msgs ?? []).some((m) => m.type === 'ready'),
    undefined,
    { timeout: 10000 },
  );

  // Stream 3 more growth deltas; the frame must morphdom-PATCH each (applied seq
  // climbs) with NO remount/reload of the iframe.
  for (let i = 1; i <= 3; i++) {
    await streamText(page, 'r9html', htmlFence(`<section data-d="${i}">delta ${i}</section>`));
    await page.waitForTimeout(120);
  }
  const afterDeltas = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="canvas-tabs-panel"] .pd-canvas-html');
    const msgs = window.__pd_frame_msgs ?? [];
    const applied = msgs
      .filter((m) => m.type === 'applied')
      .map((m) => m.seq)
      .filter((s) => typeof s === 'number');
    return {
      sameNode: el?.getAttribute('data-probe-stamp') === 'html-1',
      src: el?.getAttribute('src') ?? null,
      maxApplied: applied.length ? Math.max(...applied) : 0,
      appliedCount: applied.length,
    };
  });
  assert(
    afterDeltas.sameNode,
    'the html iframe was REMOUNTED across streaming deltas (reload) — identity stamp lost',
  );
  assert(afterDeltas.src === iframeSrc, 'the html iframe src changed across deltas (reload)');
  assert(
    afterDeltas.maxApplied >= 2,
    `the harness frame did not morphdom-patch subsequent deltas (max applied seq ${afterDeltas.maxApplied}, count ${afterDeltas.appliedCount}) — the frame is not live mid-stream`,
  );

  // ── B. HTML rendered/raw toggle → syntax-highlighted raw source, then back ───
  await page.click(`${PANEL} .pd-canvas-view-toggle button:has-text("Raw")`);
  await page.waitForSelector(`${PANEL} .pd-canvas-raw .pd-canvas-code`, { timeout: 8000 });
  const rawHasHtml = await page.evaluate(() => {
    const raw = document.querySelector('[data-testid="canvas-tabs-panel"] .pd-canvas-raw');
    return (raw?.textContent ?? '').includes('PI-HTML-LIVE');
  });
  assert(rawHasHtml, 'raw view did not show the html source');
  assert(
    (await page.locator(`${PANEL} .pd-canvas-html`).count()) === 0,
    'the iframe should be gone in raw view',
  );
  await page.click(`${PANEL} .pd-canvas-view-toggle button:has-text("Rendered")`);
  await page.waitForSelector(`${PANEL} .pd-canvas-html`, { timeout: 8000 });

  // ── C. Streamed ```svg → live canvas svg, marker updates, raw toggle ─────────
  const svgPad = '<rect x="0" y="0" width="1" height="1" fill="#000"/>'.repeat(60);
  const svg = (marker) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><circle cx="60" cy="60" r="48" fill="#4a90d9"/>${svgPad}<text x="60" y="66" font-size="10" text-anchor="middle" fill="#fff">${marker}</text></svg>`;
  const svgFence = (marker) => `Drawing:\n\n\`\`\`svg\n${svg(marker)}\n\`\`\``;
  assert(svg('X').length > 2000, 'svg payload must exceed the 2000-char inline budget');

  await streamText(page, 'r9svg', svgFence('SVG-MARK-A'));
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="canvas-tabs-panel"] .pd-canvas-svg');
      return el?.querySelector('svg') !== null && (el.textContent ?? '').includes('SVG-MARK-A');
    },
    undefined,
    { timeout: 8000 },
  );
  // Live update: change the drawn marker across a delta; the same svg surface
  // must re-render the new marker (proof the drawing updates as code streams).
  await streamText(page, 'r9svg', svgFence('SVG-MARK-B'));
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="canvas-tabs-panel"] .pd-canvas-svg');
      return el?.querySelector('svg') !== null && (el.textContent ?? '').includes('SVG-MARK-B');
    },
    undefined,
    { timeout: 8000 },
  );

  // SVG rendered/raw toggle → raw svg source, then back to the drawn svg.
  await page.click(`${PANEL} .pd-canvas-view-toggle button:has-text("Raw")`);
  await page.waitForSelector(`${PANEL} .pd-canvas-raw .pd-canvas-code`, { timeout: 8000 });
  const rawHasSvg = await page.evaluate(() => {
    const raw = document.querySelector('[data-testid="canvas-tabs-panel"] .pd-canvas-raw');
    const t = raw?.textContent ?? '';
    return t.includes('<svg') && t.includes('SVG-MARK-B');
  });
  assert(rawHasSvg, 'raw view did not show the svg source');
  await page.click(`${PANEL} .pd-canvas-view-toggle button:has-text("Rendered")`);
  await page.waitForSelector(`${PANEL} .pd-canvas-svg svg`, { timeout: 8000 });

  console.log(
    'round9-live-render-probe OK — streamed html routed to a live pd-preview iframe (frame posted ready + applied patches, seq climbed, same node/src across deltas = no reload); rendered/raw toggle flipped html to a highlighted source editor and back; streamed svg rendered + updated its drawn marker live; svg rendered/raw toggle flipped to source and back',
  );
} finally {
  await app.close();
}
