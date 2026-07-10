/**
 * Round-9 adversarial E2E — LIVE FILE WRITING (failure point #2, deeper than R7).
 *
 * A `write` tool call opens a live canvas file tab that updates across MULTIPLE
 * streaming content deltas, then FINALIZES FROM DISK when the tool result lands:
 * the tab flips to the authoritative on-disk bytes (made to differ from the
 * streamed hint, so a passing finalize proves the file was actually re-read) and
 * drops `streaming`. Run `pnpm build` first.
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
  if (!condition) throw new Error(`round9-file-write-probe failed: ${message}`);
}

assert(
  existsSync(path.join(appRoot, 'dist/index.html')) &&
    existsSync(path.join(appRoot, 'dist-electron/main.js')),
  'app is not built — run `pnpm build` first',
);

const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'));
const workDir = mkdtempSync(path.join(tmpdir(), 'pi-e2e-work-'));
const writePath = path.join(workDir, 'live-write.txt');
const DISK_MARKER = 'DISK-FINALIZED-c0ffee';
writeFileSync(writePath, `on-disk canonical content\n${DISK_MARKER}\n`, 'utf8');

const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${userDataDir}`],
  env: { ...process.env, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});

const tabKey = `file:${writePath}`;
const fileTab = (page) =>
  page.evaluate((k) => {
    const t = window
      .__pi_canvas()
      .getState()
      .tabs.find((t) => t.key === k);
    return t ? { streaming: t.streaming === true, text: t.artifact?.content.text ?? '' } : null;
  }, tabKey);

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
            id: 'r9-write',
            blocks: [
              {
                type: 'toolCall',
                id: 'call_r9_write',
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
            id: 'tr-call_r9_write',
            toolCallId: 'call_r9_write',
            assistantId: 'r9-write',
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

  // Delta 1 → the live file tab opens streaming with the first hint.
  await writeMsg('STREAM-HINT part 1', false);
  await page.waitForFunction(
    (k) => {
      const t = window
        .__pi_canvas()
        .getState()
        .tabs.find((t) => t.key === k);
      return (
        t !== undefined &&
        t.streaming === true &&
        (t.artifact?.content.text ?? '').includes('part 1')
      );
    },
    tabKey,
    { timeout: 8000 },
  );
  await page.waitForSelector('[data-testid="canvas-tabs-panel"]', { timeout: 8000 });

  // Deltas 2 + 3 → the SAME tab updates live (multiple deltas).
  await writeMsg('STREAM-HINT part 1 part 2', false);
  await page.waitForFunction(
    (k) =>
      (
        window
          .__pi_canvas()
          .getState()
          .tabs.find((t) => t.key === k)?.artifact?.content.text ?? ''
      ).includes('part 2'),
    tabKey,
    { timeout: 8000 },
  );
  await writeMsg('STREAM-HINT part 1 part 2 part 3', false);
  await page.waitForFunction(
    (k) =>
      (
        window
          .__pi_canvas()
          .getState()
          .tabs.find((t) => t.key === k)?.artifact?.content.text ?? ''
      ).includes('part 3'),
    tabKey,
    { timeout: 8000 },
  );
  const midStream = await fileTab(page);
  assert(midStream?.streaming === true, 'file tab should be streaming during the write');
  assert(
    !midStream.text.includes(DISK_MARKER),
    'the disk marker must NOT be present during streaming (it is only on disk)',
  );

  // The written content is visible in the live surface (rendered in the tab body).
  await page.waitForFunction(
    () =>
      (
        document.querySelector('[data-testid="canvas-tabs-panel"] .pd-canvas-tabpanel')
          ?.textContent ?? ''
      ).includes('part 3'),
    undefined,
    { timeout: 8000 },
  );

  // Add the tool result → finalize-from-disk: the tab re-reads the file and flips
  // to the on-disk bytes (DISK_MARKER) and stops streaming.
  await writeMsg('STREAM-HINT part 1 part 2 part 3', true);
  await page.waitForFunction(
    ({ k, marker }) => {
      const t = window
        .__pi_canvas()
        .getState()
        .tabs.find((t) => t.key === k);
      return (
        t !== undefined && t.streaming !== true && (t.artifact?.content.text ?? '').includes(marker)
      );
    },
    { k: tabKey, marker: DISK_MARKER },
    { timeout: 8000 },
  );
  const finalized = await fileTab(page);
  assert(
    finalized?.text.includes(DISK_MARKER),
    'finalize did not read the authoritative on-disk content',
  );
  assert(finalized?.streaming === false, 'finalized file tab should no longer be streaming');

  console.log(
    'round9-file-write-probe OK — a write tool call opened a live file tab that updated across 3 streaming deltas, then finalized from disk (flipped to the authoritative on-disk bytes and dropped streaming)',
  );
} finally {
  await app.close();
}
