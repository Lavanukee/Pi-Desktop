/**
 * Round-9 adversarial E2E — CONNECTORS: SKILLS TAB + BASH-CLI MODE (failure
 * points #9, #10). Isolated HOME so all persistence is deterministic.
 *
 *  #10 BASH-CLI MODE: switching the MCP mode to "Bash CLI" persists to
 *      settings.json (mcpMode) AND rewrites the connector registry
 *      (mcp-connectors.json .mode) AND is reflected in the renderer settings
 *      store (window.__settings_store). [The tool-registry wiring itself — the
 *      generated pi-tool shim dir + socket + PATH injection — lives in the pi
 *      child via @pi-desktop/mcp-lite and is covered by that package's unit
 *      tests, out of reach of a mock-pi desktop probe.]
 *  #9  SKILLS TAB: the connectors Skills tab lists the bundled skill catalog;
 *      toggling a skill's Install switch COPIES it into the isolated skills dir
 *      (~/.pi/agent/skills/<id>/SKILL.md); toggling off removes it.
 *
 * Run `pnpm build` first.
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
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
  if (!condition) throw new Error(`round9-connectors-probe failed: ${message}`);
}

assert(existsSync(path.join(appRoot, 'dist/index.html')), 'app is not built — run `pnpm build`');

const home = mkdtempSync(path.join(tmpdir(), 'pi-e2e-home-'));
const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'));
const settingsPath = path.join(home, '.pi', 'desktop', 'settings.json');
const mcpPath = path.join(home, '.pi', 'desktop', 'mcp-connectors.json');
const skillFile = path.join(home, '.pi', 'agent', 'skills', 'code-review', 'SKILL.md');

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

async function waitFor(predicate, label, timeout = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (predicate()) return;
    } catch {
      // not written yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`round9-connectors-probe failed: timed out waiting for ${label}`);
}

const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${userDataDir}`],
  env: { ...process.env, HOME: home, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});

try {
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 12000 });
  await page.click('[data-testid="nav-connectors"]');
  await page.waitForSelector('[data-testid="connectors-screen"]', { timeout: 8000 });

  // ── SECTIONED GALLERY: By us / Official + preinstalled builtins ──────────────
  // Our own tool (Video editing) is "By us"; HeyGen's HyperFrames is a bundled
  // third-party tool → "Official / Verified", never "By us". Both are builtins
  // that render a static "Preinstalled" badge (no "+").
  await page.waitForSelector('[data-testid="connectors-section-by-us"]', { timeout: 8000 });
  await page.waitForSelector(
    '[data-testid="connectors-section-by-us"] [data-testid="connector-card-video-editing"]',
    { timeout: 8000 },
  );
  await page.waitForSelector(
    '[data-testid="connectors-section-official"] [data-testid="connector-card-hyperframes"]',
    { timeout: 8000 },
  );
  assert(
    (await page
      .locator(
        '[data-testid="connectors-section-by-us"] [data-testid="connector-card-hyperframes"]',
      )
      .count()) === 0,
    'HyperFrames (HeyGen\'s tool) must NOT appear under "By us"',
  );
  await page.waitForSelector('[data-testid="connector-preinstalled-video-editing"]', {
    timeout: 8000,
  });
  await page.waitForSelector('[data-testid="connector-preinstalled-hyperframes"]', {
    timeout: 8000,
  });

  // ── BUILTIN INSTALL IS A REJECTED NO-OP (never seeds a phantom server) ───────
  const builtinInstall = await page.evaluate(() =>
    window.piDesktop.invoke('connectors:install', { id: 'hyperframes' }),
  );
  assert(
    typeof builtinInstall.error === 'string',
    'installing a builtin should return an error (no-op)',
  );
  assert(
    !builtinInstall.registry.servers.some((s) => s.id === 'hyperframes'),
    'a builtin must never be seeded into the connector registry',
  );

  // ── #10 BASH-CLI MODE reaches settings + the connector registry + the store ──
  // Add a plain connector (the "+") so the registry file exists, then flip mode.
  await page.click('[data-testid="connector-add-memory"]');
  await waitFor(() => readJson(mcpPath).servers.some((s) => s.id === 'memory'), 'memory installed');
  await page.click('[data-testid="connectors-mcp-mode"] >> text=Bash CLI');
  await waitFor(
    () => readJson(settingsPath).mcpMode === 'bash-cli',
    'mcpMode persisted to settings.json',
  );
  await waitFor(
    () => readJson(mcpPath).mode === 'bash-cli',
    'mode rewritten in the connector registry (mcp-connectors.json)',
  );
  const storeMode = await page.evaluate(
    () => window.__settings_store?.().getState().settings.mcpMode,
  );
  assert(
    storeMode === 'bash-cli',
    `renderer settings store should reflect bash-cli, got ${JSON.stringify(storeMode)}`,
  );

  // ── #9 SKILLS TAB: install a bundled skill → copied into the skills dir ──────
  await page.click('[data-testid="connectors-tab-skills"]');
  await page.waitForSelector('[data-testid="connectors-skills"]', { timeout: 8000 });
  await page.waitForSelector('[data-testid="skill-card-code-review"]', { timeout: 8000 });
  assert(!existsSync(skillFile), 'the skill should not be installed before toggling');
  await page.click('[data-testid="skill-toggle-code-review"]');
  await waitFor(
    () => existsSync(skillFile),
    'skill copied into ~/.pi/agent/skills/code-review/SKILL.md',
  );
  // Toggling off removes it from the skills dir.
  await page.click('[data-testid="skill-toggle-code-review"]');
  await waitFor(() => !existsSync(skillFile), 'skill removed from the skills dir on toggle-off');

  console.log(
    'round9-connectors-probe OK — sectioned gallery (Video editing under By us, HyperFrames under Official, both Preinstalled); builtin install is a rejected no-op; the "+" added memory; Bash CLI mode persisted to settings.json + rewrote the connector registry (mcp-connectors.json) + reflected in the renderer settings store; the Skills tab installed a bundled skill (copied SKILL.md into the isolated skills dir) and removed it on toggle-off',
  );
} finally {
  await app.close();
}
