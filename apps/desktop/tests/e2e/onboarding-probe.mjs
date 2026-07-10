/**
 * Onboarding E2E: seeds a Codex install (config.toml + a session + a skill) under
 * an isolated HOME, then walks the fresh-profile wizard
 * source → import → theme → experience → capabilities → chat, asserting the
 * imports actually landed (pi session converted, MCP registry + skill written,
 * onboarding flag persisted). Then relaunches the SAME profile and asserts the
 * wizard is skipped straight to chat. Run `pnpm build` first.
 *
 * `PI_ONBOARDING=1` opts this probe into the real on-disk first-run gate (every
 * other probe runs with onboarding treated complete so it lands in chat).
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
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
  if (!condition) throw new Error(`onboarding-probe failed: ${message}`);
}

assert(existsSync(path.join(appRoot, 'dist/index.html')), 'app is not built — run `pnpm build`');

// ── Seed a Codex install under an isolated HOME ───────────────────────────────
const home = mkdtempSync(path.join(tmpdir(), 'pi-e2e-home-'));
const codex = path.join(home, '.codex');
const sessionUuid = '019f486f-abdd-7c50-a58b-a7b72c9628d7';
const sessionCwd = '/tmp/demo';
const rolloutDir = path.join(codex, 'sessions', '2026', '07', '09');
mkdirSync(rolloutDir, { recursive: true });
mkdirSync(path.join(codex, 'skills', 'demo-skill'), { recursive: true });

writeFileSync(
  path.join(codex, 'config.toml'),
  [
    'model = "gpt-5.6-luna"',
    'model_reasoning_effort = "low"',
    '',
    '[mcp_servers.demo]',
    'command = "/opt/demo/server"',
    'args = ["--stdio"]',
  ].join('\n'),
);
writeFileSync(
  path.join(codex, 'session_index.jsonl'),
  `${JSON.stringify({ id: sessionUuid, thread_name: 'Seeded Codex thread', updated_at: '2026-07-09T19:51:45Z' })}\n`,
);
const line = (o) => JSON.stringify(o);
writeFileSync(
  path.join(rolloutDir, `rollout-2026-07-09T12-51-45-${sessionUuid}.jsonl`),
  [
    line({
      timestamp: '2026-07-09T19:51:45.100Z',
      type: 'session_meta',
      payload: { id: sessionUuid, timestamp: '2026-07-09T19:51:45.000Z', cwd: sessionCwd },
    }),
    line({
      timestamp: '2026-07-09T19:51:45.200Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hello codex' }],
      },
    }),
    line({
      timestamp: '2026-07-09T19:51:46.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'hello from the imported session' }],
      },
    }),
  ].join('\n'),
);
writeFileSync(path.join(codex, 'skills', 'demo-skill', 'SKILL.md'), '# Demo skill\n');

const commonEnv = {
  ...process.env,
  HOME: home,
  PI_BIN: mockPi,
  MOCK_PI_FIXTURE: fixture,
  PI_E2E: '1',
  PI_ONBOARDING: '1',
};

// ── Pass 1: fresh profile walks the whole wizard ──────────────────────────────
{
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'));
  const app = await electron.launch({
    executablePath: electronBinary,
    args: [appRoot, `--user-data-dir=${userDataDir}`],
    env: commonEnv,
  });
  try {
    const page = await app.firstWindow();

    // Step 1 — source. Codex is seeded → detected + preselected.
    await page.waitForSelector('[data-testid="onboarding-wizard"]', { timeout: 10000 });
    await page.waitForSelector('[data-testid="source-codex"]', { timeout: 8000 });
    await page.click('[data-testid="source-codex"]');
    await page.click('[data-testid="onboarding-next"]');

    // Step 2 — import checklist. Turn on sessions (expands the picker + selects
    // all) + skills; mcp defaults on.
    await page.waitForSelector('[data-testid="import-checklist"]', { timeout: 8000 });
    await page.click('[data-testid="import-sessions"]');
    await page.waitForSelector('text=Seeded Codex thread', { timeout: 8000 });
    await page.click('[data-testid="import-skills"]');
    await page.click('[data-testid="onboarding-next"]');

    // Step 3 — theme.
    await page.waitForSelector('[data-testid="theme-preview"]', { timeout: 8000 });
    await page.click('[data-testid="onboarding-next"]');

    // Step 4 — experience (gates Continue until chosen).
    await page.waitForSelector('[data-testid="experience-new"]', { timeout: 8000 });
    await page.click('[data-testid="experience-new"]');
    await page.click('[data-testid="onboarding-next"]');

    // Step 5 — capabilities, then finish.
    await page.waitForSelector('[data-testid="capability-image"]', { timeout: 8000 });
    await page.click('[data-testid="capability-image"]');
    await page.click('[data-testid="onboarding-finish"]');

    // Landed in chat: the composer is the tell.
    await page.waitForSelector('[data-testid="composer-input"]', { timeout: 12000 });
    const wizardGone = await page.evaluate(
      () => document.querySelector('[data-testid="onboarding-wizard"]') === null,
    );
    assert(wizardGone, 'wizard still mounted after finishing');

    // Chose Codex → codex flavor persisted live.
    const flavor = await page.getAttribute('html', 'data-flavor');
    assert(flavor === 'codex', `expected codex flavor, got ${flavor}`);
  } finally {
    await app.close();
  }

  // Imports actually landed on disk.
  assert(
    existsSync(path.join(home, '.pi', 'desktop', 'onboarding.json')),
    'onboarding flag not persisted',
  );
  assert(
    existsSync(path.join(home, '.pi', 'desktop', 'mcp-connectors.json')),
    'mcp registry not written',
  );
  assert(
    existsSync(path.join(home, '.pi', 'agent', 'skills', 'demo-skill', 'SKILL.md')),
    'skill not copied',
  );
  // The Codex session converted into a pi session under the encoded cwd folder.
  const sessionFolder = path.join(home, '.pi', 'agent', 'sessions', '--tmp-demo--');
  assert(existsSync(sessionFolder), 'converted pi session folder missing');
  const converted = readdirSync(sessionFolder).filter((f) => f.endsWith('.jsonl'));
  assert(converted.length === 1, `expected 1 converted session, got ${converted.length}`);

  console.log('onboarding-probe OK (pass 1) — walked wizard; imports + flag landed on disk');
}

// ── Pass 2: returning profile (same HOME) skips straight to chat ──────────────
{
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'));
  const app = await electron.launch({
    executablePath: electronBinary,
    args: [appRoot, `--user-data-dir=${userDataDir}`],
    env: commonEnv,
  });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('[data-testid="composer-input"]', { timeout: 12000 });
    const wizardMounted = await page.evaluate(
      () => document.querySelector('[data-testid="onboarding-wizard"]') !== null,
    );
    assert(!wizardMounted, 'returning profile re-ran the wizard');
    console.log('onboarding-probe OK (pass 2) — returning profile skipped straight to chat');
  } finally {
    await app.close();
  }
}
