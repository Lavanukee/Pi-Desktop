/**
 * search-card-probe.mjs — the web-search results card, in the real app.
 *
 * Checks the two things jedd asked for after looking at a live search:
 *   1. rows carry the SITE'S OWN icon (a data: URI resolved through main), not a
 *      grey letter chip;
 *   2. clicking a row opens that link in the app's canvas browser — no OS
 *      window, no DuckDuckGo page taking over the screen.
 *
 * It does not need the model: the card is rendered from a tool result, so the
 * probe folds a web_search result straight into the store and reads the DOM.
 * Network is real (the icons come from the sites themselves), so a run with no
 * connection reports the letter-chip fallback rather than failing.
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(appRoot, '../../.corp-runs', 'search-card');
mkdirSync(OUT, { recursive: true });

const app = await electron.launch({
  executablePath: require('electron'),
  args: [appRoot],
  env: { ...process.env, PI_E2E: '1', PI_E2E_BACKGROUND: '1' },
});

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 30_000 });
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 30_000 });

  // A real web_search tool result, in the text shape the tool returns.
  const TOOL_TEXT = [
    '3 result(s) via duckduckgo',
    '',
    '[1] Example Domain',
    '    https://example.com/',
    '    This domain is for use in illustrative examples.',
    '',
    '[2] Wikipedia',
    '    https://en.wikipedia.org/wiki/Main_Page',
    '    The free encyclopedia anyone can edit.',
    '',
    '[3] GitHub',
    '    https://github.com/',
    '    Where the world builds software.',
  ].join('\n');

  await page.evaluate((text) => {
    const store = window.__pi_store();
    store.getState().setMessagesExternal([
      { kind: 'user', id: 'u1', text: 'search the web', timestamp: 0 },
      {
        kind: 'assistant',
        id: 'a1',
        timestamp: 0,
        isStreaming: false,
        blocks: [
          {
            type: 'toolCall',
            id: 'call-1',
            name: 'web_search',
            arguments: { query: 'examples' },
          },
        ],
      },
      { kind: 'toolResult', id: 'r1', toolCallId: 'call-1', toolName: 'web_search', text, timestamp: 0 },
    ]);
  }, TOOL_TEXT);

  await page.waitForSelector('.pd-websearch-row', { timeout: 15_000 });
  // Icons resolve over the network through main — give them a moment to land.
  await page.waitForTimeout(6000);
  await page.screenshot({ path: path.join(OUT, 'card.png') });

  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('.pd-websearch-row')].map((r) => ({
      tag: r.tagName,
      href: r.getAttribute('href') ?? r.getAttribute('title'),
      img: r.querySelector('.pd-websearch-favicon-img')?.getAttribute('src')?.slice(0, 24) ?? null,
      chip: r.querySelector('.pd-websearch-favicon-chip')?.textContent ?? null,
    })),
  );
  console.log(JSON.stringify(rows, null, 2));

  check('the card rendered its rows', rows.length === 3, `${rows.length} rows`);
  const withIcons = rows.filter((r) => r.img?.startsWith('data:image/'));
  check(
    'rows carry the SITE’S OWN icon as a data: URI (not a letter chip)',
    withIcons.length > 0,
    `${withIcons.length}/${rows.length} resolved${withIcons.length === 0 ? ' — offline?' : ''}`,
  );
  check(
    'nothing loads a REMOTE image (the CSP still forbids it)',
    rows.every((r) => r.img === null || r.img.startsWith('data:')),
  );

  // Clicking a row opens it in the CANVAS browser — not a new OS window.
  const before = await page.evaluate(() => document.querySelectorAll('.pd-canvas-tab').length);
  // Dispatch on the element itself: the thread's own overlays sit above the row
  // for a synthetic pointer click, and what is under test is the handler, not
  // Playwright's hit-testing.
  await page.evaluate(() => {
    document
      .querySelector('.pd-websearch-row')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(2500);
  const canvas = await page.evaluate(() => ({
    tabs: [...document.querySelectorAll('.pd-canvas-tab')].map((t) => ({
      label: t.querySelector('.pd-canvas-tab-label')?.textContent ?? '',
      kind: t.getAttribute('data-kind'),
    })),
  }));
  await page.screenshot({ path: path.join(OUT, 'after-click.png') });
  console.log('canvas tabs:', JSON.stringify(canvas.tabs));
  check(
    'clicking a result opened the canvas BROWSER (the tab renames to the page title)',
    canvas.tabs.some((t) => t.kind === 'browser'),
    `tabs before=${before}, now=${JSON.stringify(canvas.tabs)}`,
  );
  /*
   * The canvas browser is its own WebContents, so Playwright surfaces it as a
   * second "window" — that one is the thing we asked for. What must NOT exist is
   * a THIRD: an `<a target="_blank">` opening the page again outside the app,
   * which is what happened while the row was still a link (preventDefault does
   * not cancel a new-window request). The row being a BUTTON is the fix, and is
   * asserted directly rather than inferred.
   */
  const contents = app.windows().map((w) => w.url());
  check(
    'every row is a button, so no target="_blank" path exists at all',
    rows.every((r) => r.tag === 'BUTTON'),
    rows.map((r) => r.tag).join(','),
  );
  check(
    'exactly ONE new surface opened, and it is the canvas browser on that link',
    contents.length === 2 && contents.filter((u) => u.startsWith('https://example.com')).length === 1,
    contents.join(' | '),
  );

  console.log(`\nScreenshots: ${OUT}`);
} finally {
  await app.close().catch(() => {});
}
process.exit(failures === 0 ? 0 : 1);
