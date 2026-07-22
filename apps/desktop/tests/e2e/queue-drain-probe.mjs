/**
 * Queue drain + copy fixes (D + E).
 *   E: when a message is queued, the "Queued · Why isn't my message sending?" hint
 *      shows BELOW the composer (not a per-bubble "sends after this reply" line).
 *   D: a message queued behind a BACKGROUND run drains the moment that run ends —
 *      the drain is level-triggered (idle), so it no longer misses the bgRun edge.
 * Run `npm run build` first. Screenshot in OUT_DIR.
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

const OUT_DIR = process.env.DRAIN_PROBE_OUT ?? path.join(tmpdir(), 'queue-drain-shots');
mkdirSync(OUT_DIR, { recursive: true });
const assert = (c, m) => {
  if (!c) throw new Error(`queue-drain-probe failed: ${m}`);
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
      message: { role: 'user', content: 'chat about apples', timestamp: 1 },
    }),
    l({
      type: 'message',
      id: 'a1',
      parentId: 'u1',
      timestamp: 't',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Apples are great.' }],
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
  await page.click('text=chat about apples');
  await page.waitForSelector('text=Apples are great.', { timeout: 8000 });

  // Inject a background run + a queued message (as if a different chat is running
  // and the user queued a send here).
  await page.evaluate(() => {
    window.__pi_store().setState((s) => ({
      bgRun: {
        sessionFile: '/tmp/other.jsonl',
        messages: [],
        streaming: true,
        title: 'Other chat',
      },
      queuedSends: [{ text: 'my queued message', images: [], reason: { kind: 'busy-same-model' } }],
    }));
  });

  // (E) The hint shows BELOW the composer; no per-bubble "sends after this reply".
  await page.waitForSelector('[data-testid="composer-queued-hint"]', { timeout: 8000 });
  const hintText = await page.textContent('[data-testid="composer-queued-hint"]');
  assert(
    hintText.includes('Queued') && hintText.includes("Why isn't my message sending?"),
    `hint copy: ${hintText}`,
  );
  const oldLine = await page.evaluate(() =>
    document.body.textContent.includes('sends after this reply'),
  );
  assert(!oldLine, 'the old "sends after this reply" line must be gone');
  await page.screenshot({ path: path.join(OUT_DIR, '01-queued-hint-below-composer.png') });

  // (D) End the background run → the queued message must DRAIN (level-triggered).
  await page.evaluate(() => {
    window.__pi_store().setState((s) => ({
      bgRun: s.bgRun === null ? null : { ...s.bgRun, streaming: false },
      agent: { ...s.agent, isStreaming: false },
    }));
  });
  await page.waitForFunction(() => window.__pi_store().getState().queuedSends.length === 0, {
    timeout: 8000,
  });
  console.log(
    'queue-drain-probe OK — queued hint below composer + queue drains when the bg run ends',
  );
} finally {
  await app.close();
}
