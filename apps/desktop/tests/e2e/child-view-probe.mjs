/**
 * MP3/MP4 — nested child dropdown + viewing a child. A subagent/role (its own pi
 * instance) appears indented under its parent chat in the sidebar; clicking it
 * shows its transcript through the SAME thread UI (thinking blocks, tool rows).
 * Injects a child transcript via the __child_store hook. `npm run build` first.
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

const OUT_DIR = process.env.CHILD_VIEW_OUT ?? path.join(tmpdir(), 'child-view-shots');
mkdirSync(OUT_DIR, { recursive: true });
const assert = (c, m) => {
  if (!c) throw new Error(`child-view-probe failed: ${m}`);
};

const home = mkdtempSync(path.join(tmpdir(), 'pi-e2e-home-'));
const sessionsDir = path.join(home, '.pi', 'agent', 'sessions', 'proj');
mkdirSync(sessionsDir, { recursive: true });
const l = (o) => JSON.stringify(o);
const alphaFile = path.join(sessionsDir, 'alpha.jsonl');
writeFileSync(
  alphaFile,
  [
    l({ type: 'session', version: 3, id: 'sess-alpha', timestamp: 't', cwd: '/tmp' }),
    l({
      type: 'message',
      id: 'u1',
      parentId: null,
      timestamp: 't',
      message: { role: 'user', content: 'plan a launch', timestamp: 1 },
    }),
    l({
      type: 'message',
      id: 'a1',
      parentId: 'u1',
      timestamp: 't',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Delegating to a subagent.' }],
        timestamp: 1,
      },
    }),
  ].join('\n'),
);

const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'))}`],
  env: { ...process.env, HOME: home, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});

try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 8000 });
  await page.waitForFunction(() => window.__child_store !== undefined, { timeout: 8000 });
  await page.click('text=plan a launch');
  await page.waitForSelector('text=Delegating to a subagent.', { timeout: 8000 });

  // Inject a child agent under this chat with a realistic transcript (thinking +
  // tool call + text), as the fold would have produced from its event stream.
  await page.evaluate((parentId) => {
    const store = window.__child_store.getState();
    store.ensureChild('sub-1', parentId, 'Research subagent');
    store.replaceMessages('sub-1', [
      { kind: 'user', id: 'u1', text: 'Research quantum error correction', timestamp: 1 },
      {
        kind: 'assistant',
        id: 'a1',
        timestamp: 2,
        isStreaming: false,
        blocks: [
          { type: 'thinking', thinking: 'Let me look at the recent papers in the folder.' },
          { type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'ls papers/' } },
          { type: 'text', text: 'Found 3 papers. The surface-code approach looks most promising.' },
        ],
      },
      {
        kind: 'toolResult',
        id: 'r1',
        toolCallId: 't1',
        toolName: 'bash',
        text: 'surface-code.pdf\nldpc.pdf\ncat-qubits.pdf',
        isError: false,
        timestamp: 3,
      },
    ]);
    store.setRunning('sub-1', false);
  }, alphaFile);

  // MP3: the child appears as an indented row under its parent in the sidebar.
  await page.waitForSelector('[data-testid="child-rows"]', { timeout: 8000 });
  await page.waitForSelector('[data-testid="child-row-sub-1"]', { timeout: 8000 });
  const rowText = await page.textContent('[data-testid="child-row-sub-1"]');
  assert(rowText.includes('Research subagent'), `child row should show its title: ${rowText}`);
  await page.screenshot({ path: path.join(OUT_DIR, '01-nested-dropdown.png') });

  // MP4: clicking the child opens its transcript through the same thread UI.
  await page.click('[data-testid="child-row-sub-1"]');
  await page.waitForSelector('[data-testid="child-chat-view"]', { timeout: 8000 });
  await page.waitForSelector('text=Research quantum error correction', { timeout: 8000 });
  const viewText = await page.textContent('[data-testid="child-chat-view"]');
  assert(viewText.includes('Research subagent'), 'child view header shows the title');
  assert(
    viewText.includes('Research quantum error correction'),
    'child view shows the user prompt',
  );
  assert(
    viewText.includes('surface-code approach looks most promising'),
    'child view shows the assistant response',
  );
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT_DIR, '02-child-transcript.png') });

  // Back returns to the main chat.
  await page.click('[data-testid="child-chat-back"]');
  await page.waitForSelector('text=Delegating to a subagent.', { timeout: 8000 });

  console.log(
    'child-view-probe OK — nested dropdown lists the child (MP3); clicking shows its transcript via the same thread UI (MP4)',
  );
} finally {
  await app.close();
}
