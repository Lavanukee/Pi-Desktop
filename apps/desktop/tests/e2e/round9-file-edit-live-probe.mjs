/**
 * Round-9 adversarial E2E — EDIT A FILE THAT WAS WRITTEN LIVE (failure point #3,
 * the realistic flow). This is the natural user story: the model writes a file
 * live into a canvas file tab (it streams → read-only), finishes, and the user
 * then edits that same tab in raw view and hits ⌘S.
 *
 * The tab is a real on-disk `.ts` (code → raw view). After the write finalizes
 * (streaming:false) the editor MUST become editable so ⌘S can save. This probe
 * asserts exactly that (editor becomes editable + ⌘S fires fs:write-file).
 *
 * REGRESSION HISTORY: on the initial build under test this FAILED — CodeSurface
 * read `editable` only at mount (mount-once effect in
 * packages/canvas/src/surfaces/code-surface.tsx), so a file tab whose surface
 * first mounted while STREAMING (read-only) never became editable after finalize
 * and the live-written file could not be edited/saved. It began passing after a
 * change to code-surface.tsx. Keep this probe as the regression guard for that
 * flow. Run `pnpm build` first.
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
  if (!condition) throw new Error(`round9-file-edit-live-probe failed: ${message}`);
}

assert(
  existsSync(path.join(appRoot, 'dist/index.html')) &&
    existsSync(path.join(appRoot, 'dist-electron/main.js')),
  'app is not built — run `pnpm build` first',
);

const home = mkdtempSync(path.join(tmpdir(), 'pi-e2e-home-'));
const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'));
const PANEL = '[data-testid="canvas-tabs-panel"]';

// A real file under an allowed write root (~/.pi/agent) so the write+edit path is
// legitimate; content differs from the streamed hint to exercise finalize.
const writePath = path.join(home, '.pi', 'agent', 'live-edit.ts');
mkdirSync(path.dirname(writePath), { recursive: true });
writeFileSync(writePath, 'export const finalized = 1;\n', 'utf8');

const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${userDataDir}`],
  env: { ...process.env, HOME: home, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});

const tabKey = `file:${writePath}`;

try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__pi_canvas === 'function', { timeout: 8000 });
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 8000 });

  const writeMsg = (content, withResult) =>
    page.evaluate(
      ({ writePath, content, withResult }) => {
        const messages = [
          {
            kind: 'assistant',
            id: 'r9-live-edit',
            blocks: [
              {
                type: 'toolCall',
                id: 'call_live_edit',
                name: 'write',
                arguments: { path: writePath, content },
              },
            ],
            timestamp: Date.now(),
            isStreaming: !withResult,
          },
        ];
        if (withResult) {
          messages.push({
            kind: 'toolResult',
            id: 'tr-call_live_edit',
            toolCallId: 'call_live_edit',
            assistantId: 'r9-live-edit',
            toolName: 'write',
            text: 'wrote file',
            isError: false,
            timestamp: Date.now(),
          });
        }
        window.__pi_store().setState({ messages });
      },
      { writePath, content, withResult },
    );

  // Model writes the file LIVE (streams) — the surface mounts read-only.
  await writeMsg('export const draft = 1;', false);
  await page.waitForSelector(`${PANEL} .pd-canvas-code .cm-content`, { timeout: 8000 });

  // Write completes → finalize; the tab is now a static on-disk file.
  await writeMsg('export const draft = 1;', true);
  await page.waitForFunction(
    (k) =>
      window
        .__pi_canvas()
        .getState()
        .tabs.find((t) => t.key === k)?.streaming !== true,
    tabKey,
    { timeout: 8000 },
  );

  // The just-written file must now be editable so the user can fix + ⌘S it.
  const editable = await page.getAttribute(
    `${PANEL} .pd-canvas-code .cm-content`,
    'contenteditable',
  );
  assert(
    editable === 'true',
    `a live-written file tab is not editable after finalize (contenteditable=${editable}) — the raw editor stays read-only, so ⌘S cannot save. APP BUG: CodeSurface captures \`editable\` only at mount and is not remounted when streaming→finalize; the canvas tabpanel does not key the surface per tab. Suspected: packages/canvas/src/surfaces/code-surface.tsx (mount-once editable) + packages/canvas/src/tabs/canvas-tabs.tsx (DefaultSurface not keyed by tab id / streaming).`,
  );

  // If it were editable, the edit + save should round-trip.
  await page.evaluate(() => {
    window.__pi_canvas_ipc = [];
  });
  await page.click(`${PANEL} .pd-canvas-code .cm-content`);
  await page.keyboard.press('Meta+a');
  await page.keyboard.type('export const fixed = 99;');
  await page.keyboard.press('Meta+s');
  await page.waitForFunction(
    (p) =>
      (window.__pi_canvas_ipc ?? []).some(
        (c) => c.channel === 'fs:write-file' && c.req?.path === p,
      ),
    writePath,
    { timeout: 6000 },
  );

  console.log(
    'round9-file-edit-live-probe OK — a live-written file tab became editable after finalize and ⌘S saved the edit',
  );
} finally {
  await app.close();
}
