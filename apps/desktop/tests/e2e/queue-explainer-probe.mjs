/**
 * Queueing / concurrency UX E2E — drives the states via the __pi_store hook and
 * screenshots each one for visual review, plus asserts the wiring:
 *   (1) a queued message renders its computed REASON line + the "Why isn't my
 *       message sending?" link;
 *   (2) clicking the link opens the modal with the right blurb + a running-chat
 *       row carrying Pause + Stop;
 *   (3) while a turn is live the composer shows Pause LEFT of Stop;
 *   (4) a paused chat shows the "Paused · Resume" strip once it settles idle.
 *
 * Injecting store state (rather than driving a real turn) makes the queued/switch
 * scenario deterministic — mock-pi can't produce a two-model race. Run `npm run
 * build` first. Exit 0 on success; screenshots land in OUT_DIR (printed below).
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

const OUT_DIR = process.env.QUEUE_PROBE_OUT ?? path.join(tmpdir(), 'queue-explainer-shots');
mkdirSync(OUT_DIR, { recursive: true });

function assert(cond, msg) {
  if (!cond) throw new Error(`queue-explainer-probe failed: ${msg}`);
}

const home = mkdtempSync(path.join(tmpdir(), 'pi-e2e-home-'));
const sessionsDir = path.join(home, '.pi', 'agent', 'sessions', 'proj');
mkdirSync(sessionsDir, { recursive: true });
const line = (o) => JSON.stringify(o);
const fileA = path.join(sessionsDir, 'alpha.jsonl');
writeFileSync(
  fileA,
  [
    line({ type: 'session', version: 3, id: 'sess-alpha', timestamp: 't', cwd: '/tmp' }),
    line({
      type: 'message',
      id: 'u1',
      parentId: null,
      timestamp: 't',
      message: { role: 'user', content: 'Tell me about apples', timestamp: 1 },
    }),
    line({
      type: 'message',
      id: 'a1',
      parentId: 'u1',
      timestamp: 't',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Apples are great.' }], timestamp: 1 },
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
  await page.click('text=Tell me about apples');
  await page.waitForSelector('text=Apples are great.', { timeout: 8000 });

  // (A) Inject a "generating + a queued switch-model message" state.
  await page.evaluate(() => {
    const store = window.__pi_store();
    store.setState((s) => ({
      windowTitle: 'Apples chat',
      promptInFlight: false,
      agent: {
        ...s.agent,
        isStreaming: true,
        model: { id: 'gemma-4-12b-it', name: 'Gemma 4 12B', provider: 'llamacpp' },
      },
      messages: [
        { kind: 'user', id: 'u1', text: 'Tell me about apples', timestamp: 1 },
        {
          kind: 'assistant',
          id: 'a1',
          blocks: [{ type: 'text', text: 'Apples are pomaceous fruits of the tree Malus domestica…' }],
          timestamp: 2,
          isStreaming: true,
        },
      ],
      queuedSends: [
        {
          text: 'Now switch to the big model and analyse this in depth',
          images: [],
          reason: {
            kind: 'busy-switch-model',
            targetModelName: 'Gemma 4 31B',
            loadedModelName: 'Gemma 4 12B',
          },
        },
      ],
    }));
  });

  await page.waitForSelector('[data-testid="queued-message"]', { timeout: 8000 });
  await page.waitForSelector('[data-testid="why-queued-link"]', { timeout: 8000 });
  const reasonLine = await page.textContent('[data-testid="queued-message"]');
  assert(
    reasonLine !== null && reasonLine.includes('switch to Gemma 4 31B'),
    `queued reason line should name the switch target; got: ${reasonLine}`,
  );
  // Composer shows Pause LEFT of Stop while busy.
  await page.waitForSelector('[data-testid="composer-pause"]', { timeout: 8000 });
  await page.waitForSelector('[data-testid="composer-stop"]', { timeout: 8000 });
  const order = await page.evaluate(() => {
    const pause = document.querySelector('[data-testid="composer-pause"]');
    const stop = document.querySelector('[data-testid="composer-stop"]');
    if (pause === null || stop === null) return 'missing';
    // Pause is left of Stop ⇒ its right edge is at/left of Stop's left edge.
    return pause.getBoundingClientRect().left < stop.getBoundingClientRect().left
      ? 'pause-left'
      : 'stop-left';
  });
  assert(order === 'pause-left', `Pause must sit left of Stop; got ${order}`);
  await page.screenshot({ path: path.join(OUT_DIR, '01-queued-and-composer.png') });

  // (B) Open the explainer modal.
  await page.click('[data-testid="why-queued-link"]');
  await page.waitForSelector('[data-testid="why-queued-modal"]', { timeout: 8000 });
  await page.waitForSelector('[data-testid="modal-running-chat"]', { timeout: 8000 });
  const modalText = await page.textContent('[data-testid="why-queued-modal"]');
  assert(
    modalText !== null && modalText.includes('Gemma 4 31B') && modalText.includes('Gemma 4 12B'),
    `modal blurb should name both models; got: ${modalText}`,
  );
  assert(
    modalText.includes('one model at a time'),
    'modal blurb should explain the one-model-at-a-time swap',
  );
  await page.waitForSelector('[data-testid="modal-pause"]', { timeout: 8000 });
  await page.waitForSelector('[data-testid="modal-stop"]', { timeout: 8000 });
  const rowText = await page.textContent('[data-testid="modal-running-chat"]');
  assert(
    rowText !== null && rowText.includes('Apples chat') && rowText.includes('Gemma 4 12B'),
    `running-chat row should show the title + loaded model; got: ${rowText}`,
  );
  await page.screenshot({ path: path.join(OUT_DIR, '02-why-queued-modal.png') });

  // Close the modal (Esc) before the next state.
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-testid="why-queued-modal"]', { state: 'detached', timeout: 8000 });

  // (C) A same-model queue → the plainer sequential-wait reason (no swap).
  await page.evaluate(() => {
    window.__pi_store().setState({
      queuedSends: [
        {
          text: 'and what colour are they usually?',
          images: [],
          reason: { kind: 'busy-same-model', loadedModelName: 'Gemma 4 12B' },
        },
      ],
    });
  });
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="queued-message"]');
      return el !== null && el.textContent.includes('sends when the current reply finishes');
    },
    { timeout: 8000 },
  );

  // (D) Paused → the "Paused · Resume" strip once idle.
  await page.evaluate((file) => {
    window.__pi_store().setState((s) => ({
      agent: { ...s.agent, isStreaming: false },
      promptInFlight: false,
      queuedSends: [],
      pausedChat: { sessionFile: file, userText: 'Tell me about apples' },
    }));
  }, fileA);
  await page.waitForSelector('[data-testid="composer-paused"]', { timeout: 8000 });
  await page.waitForSelector('[data-testid="composer-resume"]', { timeout: 8000 });
  await page.screenshot({ path: path.join(OUT_DIR, '03-paused-resume.png') });

  console.log(`queue-explainer-probe OK — screenshots in ${OUT_DIR}`);
} finally {
  await app.close();
}
