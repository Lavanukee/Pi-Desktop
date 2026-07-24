/**
 * Round-9 adversarial E2E — LIVE EDIT DIFF (the str_replace twin of the live
 * write, round9-file-write-probe).
 *
 * A str_replace-style EDIT tool call opens the target file in a canvas file tab
 * and shows a LIVE DIFF — the deletions (old_string) as `−` rows and the
 * additions (new_string) as `+` rows — following the hunk as its args STREAM
 * (old string first, then the new string growing). The shared DiffView / diff.css
 * renders it (`.pd-diff`), exactly like the collapsed activity chain's edit row.
 *
 * On completion the tab FINALIZES FROM DISK — it drops the diff and flips to the
 * authoritative on-disk bytes (made to differ from the hunk's new_string via a
 * disk-only marker, so a passing finalize proves the file was actually re-read)
 * and stops streaming. This mirrors the write path's finalize so the tab settles
 * into a normal, editable file view.
 *
 * STREAMING GRANULARITY: pi tool-call args may arrive in chunks or all-at-once.
 * The probe drives the realistic chunked case (path → old_string → partial
 * new_string → full) to prove the live-follow; an all-at-once edit simply shows
 * the full diff for the running window instead. Run `pnpm build` first.
 */
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
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
  if (!condition) throw new Error(`round9-file-edit-diff-probe failed: ${message}`);
}

assert(
  existsSync(path.join(appRoot, 'dist/index.html')) &&
    existsSync(path.join(appRoot, 'dist-electron/main.js')),
  'app is not built — run `pnpm build` first',
);

const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'));
const workDir = mkdtempSync(path.join(tmpdir(), 'pi-e2e-work-'));
const editPath = path.join(workDir, 'edit-diff.ts');
// The old text (removed by the edit) + the disk-only finalize marker. The on-disk
// file is the POST-edit state (what the tool would have written); its marker is
// NOT in the streamed new_string, so a finalized tab that shows it proves the
// authoritative disk re-read.
const OLD_LINE = 'export const answer = 1;';
const NEW_LINE = 'export const answer = 42;';
const DISK_MARKER = 'DISK-FINALIZED-c0ffee';
writeFileSync(editPath, `${NEW_LINE}\n// ${DISK_MARKER}\n`, 'utf8');

const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${userDataDir}`],
  env: { ...process.env, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});

const tabKey = `file:${editPath}`;
const PANEL = '[data-testid="canvas-tabs-panel"]';

const fileTab = (page) =>
  page.evaluate((k) => {
    const t = window
      .__pi_canvas()
      .getState()
      .tabs.find((t) => t.key === k);
    if (!t) return null;
    return {
      streaming: t.streaming === true,
      hasDiff: Array.isArray(t.diff) && t.diff.length > 0,
      diffText: (t.diff ?? []).flatMap((f) => f.lines.map((l) => `${l.kind}:${l.text}`)).join('\n'),
      text: t.artifact?.content.text ?? '',
    };
  }, tabKey);

try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__pi_canvas === 'function', { timeout: 8000 });
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 8000 });

  // A STREAMING edit: `arguments` is empty and the raw `argsText` grows delta by
  // delta (how a tool call actually streams). A FINALIZED edit carries parsed
  // `arguments` + a tool result.
  const editMsg = ({ argsText, args, withResult }) =>
    page.evaluate(
      ({ argsText, args, withResult }) => {
        const messages = [
          {
            kind: 'assistant',
            id: 'r9-edit',
            blocks: [
              {
                type: 'toolCall',
                id: 'call_r9_edit',
                name: 'str_replace',
                arguments: args ?? {},
                ...(argsText !== undefined ? { argsText } : {}),
              },
            ],
            timestamp: Date.now(),
            isStreaming: !withResult,
          },
        ];
        if (withResult) {
          messages.push({
            kind: 'toolResult',
            id: 'tr-call_r9_edit',
            toolCallId: 'call_r9_edit',
            assistantId: 'r9-edit',
            toolName: 'str_replace',
            text: 'edited file',
            isError: false,
            timestamp: Date.now(),
          });
        }
        window.__pi_store().setState({ messages });
      },
      { argsText, args, withResult },
    );

  // Delta 1 — path closed, old_string closed, new_string PARTIAL. The tab opens
  // with a live diff: the deletion is known, the addition is still arriving.
  await editMsg({
    argsText: `{"path":${JSON.stringify(editPath)},"old_string":${JSON.stringify(
      OLD_LINE,
    )},"new_string":"export const answer = 4`,
  });
  await page.waitForFunction(
    (k) => {
      const t = window
        .__pi_canvas()
        .getState()
        .tabs.find((t) => t.key === k);
      return t !== undefined && t.streaming === true && Array.isArray(t.diff) && t.diff.length > 0;
    },
    tabKey,
    { timeout: 8000 },
  );
  await page.waitForSelector(PANEL, { timeout: 8000 });
  // The shared DiffView is on screen with a `−` deletion + a `+` (partial) addition.
  await page.waitForSelector(`${PANEL} .pd-canvas-tabpanel .pd-diff .pd-diff-row--del`, {
    timeout: 8000,
  });
  await page.waitForSelector(`${PANEL} .pd-canvas-tabpanel .pd-diff .pd-diff-row--add`, {
    timeout: 8000,
  });

  const midStream = await fileTab(page);
  assert(midStream?.streaming === true, 'edit tab should be streaming during the hunk');
  assert(midStream.hasDiff, 'edit tab should carry a live diff while streaming');
  assert(
    midStream.diffText.includes(`del:${OLD_LINE}`),
    `the diff should show the removed line, got:\n${midStream.diffText}`,
  );
  assert(
    midStream.diffText.includes('add:export const answer = 4'),
    `the diff should show the (partial) added line, got:\n${midStream.diffText}`,
  );
  assert(
    !midStream.text.includes(DISK_MARKER),
    'the disk marker must NOT be present mid-stream (it is only on disk)',
  );

  // Delta 2 — the new_string finishes streaming. The addition GROWS to the full
  // replacement line (the live-follow of additions).
  await editMsg({
    argsText: `{"path":${JSON.stringify(editPath)},"old_string":${JSON.stringify(
      OLD_LINE,
    )},"new_string":${JSON.stringify(NEW_LINE)}`,
  });
  await page.waitForFunction(
    (k) => {
      const t = window
        .__pi_canvas()
        .getState()
        .tabs.find((t) => t.key === k);
      const diffText = (t?.diff ?? []).flatMap((f) => f.lines.map((l) => l.text)).join('\n');
      return diffText.includes('export const answer = 42;');
    },
    tabKey,
    { timeout: 8000 },
  );

  // The diff is visible in the actual tab body (not just in state).
  await page.waitForFunction(
    (marker) =>
      (
        document.querySelector('[data-testid="canvas-tabs-panel"] .pd-canvas-tabpanel .pd-diff')
          ?.textContent ?? ''
      ).includes(marker),
    'answer = 42;',
    { timeout: 8000 },
  );

  // Finalize — parsed args + a tool result → settle from disk: the diff is
  // dropped, the tab flips to the on-disk bytes (DISK_MARKER) and stops streaming.
  await editMsg({
    args: { path: editPath, old_string: OLD_LINE, new_string: NEW_LINE },
    withResult: true,
  });
  await page.waitForFunction(
    ({ k, marker }) => {
      const t = window
        .__pi_canvas()
        .getState()
        .tabs.find((t) => t.key === k);
      return (
        t !== undefined &&
        t.streaming !== true &&
        (t.diff === undefined || t.diff.length === 0) &&
        (t.artifact?.content.text ?? '').includes(marker)
      );
    },
    { k: tabKey, marker: DISK_MARKER },
    { timeout: 8000 },
  );

  const finalized = await fileTab(page);
  assert(!finalized.hasDiff, 'the diff should be cleared once the edit finalizes');
  assert(finalized.streaming === false, 'finalized edit tab should no longer be streaming');
  assert(
    finalized.text.includes(DISK_MARKER),
    'finalize did not read the authoritative on-disk content',
  );
  // The settled surface is the file body (code), no longer the diff.
  await page.waitForSelector(`${PANEL} .pd-canvas-tabpanel .pd-canvas-code`, { timeout: 8000 });
  const diffGone = await page.evaluate(
    () =>
      document.querySelector('[data-testid="canvas-tabs-panel"] .pd-canvas-tabpanel .pd-diff') ===
      null,
  );
  assert(diffGone, 'the DiffView should be gone after the edit settles to the file');

  console.log(
    'round9-file-edit-diff-probe OK — a str_replace edit opened a live diff (deletions + additions) that followed the streaming hunk, then finalized from disk (dropped the diff, flipped to the authoritative on-disk bytes, and stopped streaming)',
  );
} finally {
  await app.close();
}
