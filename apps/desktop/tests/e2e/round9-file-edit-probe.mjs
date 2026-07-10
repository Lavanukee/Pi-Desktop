/**
 * Round-9 adversarial E2E — LIVE FILE EDITING (failure point #3).
 *
 *  A. A canvas file tab opened editable renders a raw code editor; editing it +
 *     ⌘S fires the `fs:write-file` IPC (recorded to window.__pi_canvas_ipc under
 *     E2E) carrying the edited buffer, and the tab reflects the edit.
 *  B. The real fs:write-file main handler is driven directly: an IN-ROOT path
 *     writes to disk; an OUT-OF-ROOT path is REFUSED (fence) and no file appears.
 *
 * NOTE: this exercises the edit/save/IPC/fence wiring on a FRESH editable file
 * tab (the first surface mounted). The realistic "edit a file that was written
 * LIVE (streamed then finalized)" flow is covered separately by
 * round9-file-edit-live-probe.mjs, which currently catches an app bug. Isolated
 * HOME makes the write-fence roots deterministic. Run `pnpm build` first.
 */
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
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
  if (!condition) throw new Error(`round9-file-edit-probe failed: ${message}`);
}

assert(
  existsSync(path.join(appRoot, 'dist/index.html')) &&
    existsSync(path.join(appRoot, 'dist-electron/main.js')),
  'app is not built — run `pnpm build` first',
);

// realpathSync so HOME is canonical (macOS symlinks /var → /private/var). The
// write-fence realpaths the target but compares against lexical roots, so a
// symlinked temp HOME would otherwise refuse every in-root write.
const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'pi-e2e-home-')));
const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'));
const PANEL = '[data-testid="canvas-tabs-panel"]';

const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${userDataDir}`],
  env: { ...process.env, HOME: home, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});

try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__pi_canvas === 'function', { timeout: 8000 });
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 8000 });

  // ── A. Editable raw editor + ⌘S → fs:write-file IPC (fresh editable tab) ─────
  const editPath = path.join(home, '.pi', 'agent', 'r9-edit.ts');
  await page.evaluate((editPath) => {
    window.__pi_canvas_ipc = [];
    window.__pi_canvas().openTab({
      kind: 'file',
      key: `file:${editPath}`,
      title: 'r9-edit.ts',
      filePath: editPath,
      streaming: false,
      artifact: {
        id: `file:${editPath}`,
        title: 'r9-edit.ts',
        filename: 'r9-edit.ts',
        content: { kind: 'code', text: 'export const x = 1;\n', language: 'typescript' },
      },
    });
  }, editPath);

  await page.waitForSelector(`${PANEL} .pd-canvas-code .cm-content`, { timeout: 8000 });
  const editable = await page.getAttribute(
    `${PANEL} .pd-canvas-code .cm-content`,
    'contenteditable',
  );
  assert(editable === 'true', `the raw editor should be editable (contenteditable=${editable})`);

  await page.click(`${PANEL} .pd-canvas-code .cm-content`);
  await page.keyboard.press('Meta+a');
  await page.keyboard.type('export const edited = 42;');
  await page.keyboard.press('Meta+s');

  await page.waitForFunction(
    (p) =>
      (window.__pi_canvas_ipc ?? []).some(
        (c) => c.channel === 'fs:write-file' && c.req?.path === p,
      ),
    editPath,
    { timeout: 8000 },
  );
  const saveCall = await page.evaluate(
    (p) =>
      (window.__pi_canvas_ipc ?? []).find(
        (c) => c.channel === 'fs:write-file' && c.req?.path === p,
      ),
    editPath,
  );
  assert(
    saveCall?.req?.text?.includes('edited = 42'),
    `⌘S did not save the edited buffer (got ${JSON.stringify(saveCall?.req?.text)})`,
  );
  const editedTab = await page.evaluate(
    (p) =>
      window
        .__pi_canvas()
        .getState()
        .tabs.find((t) => t.key === `file:${p}`)?.artifact?.content.text ?? '',
    editPath,
  );
  assert(editedTab.includes('edited = 42'), 'the file tab did not reflect the saved edit');

  // ── B. Out-of-root refusal: drive the real fs:write-file handler directly ────
  const inRoot = path.join(home, '.pi', 'agent', 'r9-inroot.txt');
  const outside = path.join(tmpdir(), `r9-outside-${Date.now()}.txt`);
  const results = await page.evaluate(
    async ({ inRoot, outside }) => {
      const ok = await window.piDesktop.invoke('fs:write-file', {
        path: inRoot,
        content: 'IN-ROOT-OK',
      });
      const refused = await window.piDesktop.invoke('fs:write-file', {
        path: outside,
        content: 'SHOULD-REFUSE',
      });
      return { ok, refused };
    },
    { inRoot, outside },
  );
  assert(
    results.ok?.ok === true,
    `in-root write should succeed, got ${JSON.stringify(results.ok)}`,
  );
  assert(
    existsSync(inRoot) && readFileSync(inRoot, 'utf8') === 'IN-ROOT-OK',
    'in-root file was not written to disk',
  );
  assert(results.refused?.ok === false, 'out-of-root write should be REFUSED');
  assert(
    /outside an allowed/i.test(results.refused?.error ?? ''),
    `refusal error should name the fence, got ${JSON.stringify(results.refused?.error)}`,
  );
  assert(!existsSync(outside), 'the refused out-of-root file must NOT exist on disk');

  console.log(
    'round9-file-edit-probe OK — an editable canvas file tab took a ⌘S edit that fired fs:write-file with the edited buffer and reflected it on the tab; the real write handler wrote an in-root path and REFUSED an out-of-root path (no file created)',
  );
} finally {
  await app.close();
}
