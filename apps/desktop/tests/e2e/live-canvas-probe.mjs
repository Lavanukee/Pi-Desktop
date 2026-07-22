/**
 * Live-canvas streaming (LC1/LC2) — the CANVAS half, driven through the real
 * CanvasController via the store's file-write router:
 *   LC1: a streaming whole-file write auto-opens + FOCUSES a canvas file tab.
 *   LC2: its content DRAWS progressively as the tool args stream (grows).
 * The chat-side items (LC4 live +N, LC5 one-block terminal, LC7 no schema) are
 * verified deterministically in unit/render tests (activity-mapping.test.ts,
 * activity-step.render.test.tsx) — a synthetic store injection can't re-render
 * ChatThread the way the live sink does, so they're not asserted here.
 * Injects store state via the E2E hooks (no real model needed). `npm run build`
 * first. Screenshots in OUT_DIR.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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

const OUT_DIR = process.env.LC_PROBE_OUT ?? path.join(tmpdir(), 'live-canvas-shots');
mkdirSync(OUT_DIR, { recursive: true });
const assert = (c, m) => {
  if (!c) throw new Error(`live-canvas-probe failed: ${m}`);
};

const home = mkdtempSync(path.join(tmpdir(), 'pi-e2e-home-'));
const sessionsDir = path.join(home, '.pi', 'agent', 'sessions', 'proj');
mkdirSync(sessionsDir, { recursive: true });
const l = (o) => JSON.stringify(o);
writeFileSync(
  path.join(sessionsDir, 'alpha.jsonl'),
  [
    l({ type: 'session', version: 3, id: 'sess-alpha', timestamp: 't', cwd: '/tmp' }),
    l({
      type: 'message',
      id: 'u1',
      parentId: null,
      timestamp: 't',
      message: { role: 'user', content: 'hi', timestamp: 1 },
    }),
    l({
      type: 'message',
      id: 'a1',
      parentId: 'u1',
      timestamp: 't',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hello.' }], timestamp: 1 },
    }),
  ].join('\n'),
);

const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'))}`],
  env: { ...process.env, HOME: home, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});

// A whole-file write tool call whose argsText has streamed up to `chars` of the
// JSON. `full` is the complete argsText; slicing it mimics token-by-token arrival.
const FULL_ARGS = `{"path":"/tmp/lc-demo.py","content":"${['import sys', 'print(1)', 'print(2)', 'print(3)', 'print(4)'].join('\\n')}"}`;

const fileTab = (page) =>
  page.evaluate(() => {
    const t = window.__pi_canvas().getState();
    const tab = t.tabs.find((x) => x.kind === 'file');
    return tab
      ? {
          text: tab.artifact?.content?.text ?? '',
          streaming: tab.streaming === true,
          active: t.activeTabId === tab.id,
          path: tab.filePath ?? '',
        }
      : null;
  });

try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 8000 });
  await page.click('text=hi');
  await page.waitForFunction(() => typeof window.__pi_canvas === 'function', { timeout: 8000 });
  // Let the session switch fully settle (its async getPiState calls
  // resetCanvasForNewSession — injecting before that lands would get wiped).
  await page.waitForSelector('text=Hello.', { timeout: 8000 });
  await page.waitForTimeout(600);

  // ── LC1/LC2: stream a whole-file write in growing slices; the canvas draws it.
  const streamTo = (chars) =>
    page.evaluate(
      ({ argsText }) => {
        window.__pi_store().setState({
          messages: [
            { kind: 'user', id: 'u1', text: 'write it', timestamp: 1 },
            {
              kind: 'assistant',
              id: 'a1',
              timestamp: 2,
              isStreaming: true,
              blocks: [{ type: 'toolCall', id: 'w1', name: 'write_file', arguments: {}, argsText }],
            },
          ],
        });
      },
      { argsText: chars },
    );

  // Slice 1: path closed + first two lines of content.
  const s1 = FULL_ARGS.slice(0, FULL_ARGS.indexOf('print(2)'));
  await streamTo(s1);
  await page.waitForFunction(
    () => {
      const t = window.__pi_canvas?.().getState();
      const tab = t?.tabs.find((x) => x.kind === 'file');
      return tab !== undefined && (tab.artifact?.content?.text ?? '').includes('print(1)');
    },
    { timeout: 8000 },
  );
  const early = await fileTab(page);
  assert(early !== null, 'LC1: a file tab should auto-open for the streaming write');
  assert(early.path.includes('lc-demo.py'), `LC1: wrong file path: ${early.path}`);
  assert(early.active, 'LC1: the file tab should be FOCUSED (active)');
  assert(early.streaming, 'LC2: the file tab should be streaming');
  assert(!early.text.includes('print(3)'), 'LC2: only the streamed-so-far content should show');
  const earlyLines = early.text.split('\n').length;
  await page.screenshot({ path: path.join(OUT_DIR, '01-file-draw-early.png') });

  // Slice 2: the rest streams in → content GROWS (the draw).
  await streamTo(FULL_ARGS);
  await page.waitForFunction(
    () => {
      const t = window.__pi_canvas?.().getState();
      const tab = t?.tabs.find((x) => x.kind === 'file');
      return tab !== undefined && (tab.artifact?.content?.text ?? '').includes('print(4)');
    },
    { timeout: 8000 },
  );
  const grown = await fileTab(page);
  assert(grown.text.split('\n').length > earlyLines, 'LC2: content should GROW as it streams');
  assert(grown.text.includes('print(4)'), 'LC2: final streamed content should be present');
  assert(grown.active, 'LC1: the file tab stays focused as it streams');
  await page.screenshot({ path: path.join(OUT_DIR, '02-file-draw-grown.png') });

  console.log(
    'live-canvas-probe OK — file tab auto-opens + focuses (LC1) and draws as it streams (LC2)',
  );
} finally {
  await app.close();
}
