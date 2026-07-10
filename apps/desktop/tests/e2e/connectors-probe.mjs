/**
 * Connectors E2E: lands in chat (mock pi) under an isolated HOME, opens the
 * Codex-style connectors gallery from the sidebar, and asserts the whole flow:
 *   - "Recommended for you" renders from a MOCKED /Applications scan (a fixture
 *     dir with Blender.app → Blender pinned),
 *   - installing a plain connector (memory) persists to mcp-connectors.json,
 *   - the detail page renders and its MCP-servers toggle disables/persists,
 *   - a secret connector (slack) opens the Connect permission popup, and
 *     "Continue" installs it disabled,
 *   - switching the MCP mode to Bash CLI persists to settings.json + the registry.
 * Run `pnpm build` first.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
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
  if (!condition) throw new Error(`connectors-probe failed: ${message}`);
}

assert(existsSync(path.join(appRoot, 'dist/index.html')), 'app is not built — run `pnpm build`');

const home = mkdtempSync(path.join(tmpdir(), 'pi-e2e-home-'));
const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'));
const settingsPath = path.join(home, '.pi', 'desktop', 'settings.json');
const mcpPath = path.join(home, '.pi', 'desktop', 'mcp-connectors.json');

// Mock /Applications scan: a fixture dir with only Blender.app → recommended.
const appsDir = mkdtempSync(path.join(tmpdir(), 'pi-e2e-apps-'));
mkdirSync(path.join(appsDir, 'Blender.app'));

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const servers = () => (existsSync(mcpPath) ? readJson(mcpPath).servers : []);
const serverById = (id) => servers().find((s) => s.id === id);

async function waitFor(predicate, label, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (predicate()) return;
    } catch {
      // file not written yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`connectors-probe failed: timed out waiting for ${label}`);
}

const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${userDataDir}`],
  env: {
    ...process.env,
    HOME: home,
    PI_BIN: mockPi,
    MOCK_PI_FIXTURE: fixture,
    PI_E2E: '1',
    PI_CONNECTORS_APPS_DIR: appsDir,
  },
});

try {
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 12000 });

  // Open the connectors gallery from the sidebar nav.
  await page.click('[data-testid="nav-connectors"]');
  await page.waitForSelector('[data-testid="connectors-screen"]', { timeout: 8000 });

  // Recommended for you: Blender pinned from the mocked scan.
  await page.waitForSelector('[data-testid="connectors-recommended-item-blender"]', {
    timeout: 8000,
  });

  // Round-10 Wave D: real brand marks render as self-contained inline SVG for
  // well-known connectors — github/figma in the Featured list, blender in the
  // Recommended row — each an actual <svg><path> (not the emoji fallback).
  // Round-11 Wave A1: those marks now render in their BRAND COLOR — the svg's
  // fill is a brand hex (figma #F24E1E, blender #E87D0D directly; github #181717
  // via the --pd-connector-ink fallback), never the old monochrome currentColor.
  for (const scope of [
    '[data-testid="connector-card-github"]',
    '[data-testid="connector-card-figma"]',
    '[data-testid="connectors-recommended-item-blender"]',
  ]) {
    const svg = `${scope} [data-testid="connector-icon-svg"] svg`;
    await page.waitForSelector(svg, { timeout: 8000 });
    const paths = await page.locator(`${svg} path`).count();
    assert(paths > 0, `expected a brand SVG path inside ${scope}`);
    const fill = (await page.locator(svg).first().getAttribute('fill')) ?? '';
    assert(
      fill.includes('#') && fill !== 'currentColor',
      `expected a brand-color fill inside ${scope}, got "${fill}"`,
    );
  }

  // ...and the trademark disclaimer sits under the gallery.
  const disclaimer = (await page.textContent('[data-testid="connectors-disclaimer"]')) ?? '';
  assert(
    disclaimer.includes('property of their respective owners') &&
      disclaimer.includes('does not imply endorsement'),
    'trademark disclaimer present under the gallery',
  );

  // Install a plain (no-secret) connector → persists enabled to the registry.
  await page.click('[data-testid="connector-install-memory"]');
  await waitFor(() => serverById('memory')?.enabled === true, 'memory installed + enabled');

  // Open its detail page, toggle MCP servers OFF → persists disabled.
  await page.click('[data-testid="connectors-installed-memory"]');
  await page.waitForSelector('[data-testid="connector-detail"]', { timeout: 8000 });
  await page.click('[data-testid="connector-detail-mcp-toggle"]');
  await waitFor(() => serverById('memory')?.enabled === false, 'memory disabled persists');

  // Back to the gallery, install a secret connector → Connect permission popup.
  await page.click('[data-testid="connector-detail-breadcrumb"] >> text=Connectors');
  await page.waitForSelector('[data-testid="connectors-featured"]', { timeout: 8000 });
  await page.click('[data-testid="connector-install-slack"]');
  await page.waitForSelector('[data-testid="connect-permission-dialog"]', { timeout: 8000 });
  await page.click('[data-testid="connect-continue"]');
  await waitFor(
    () => serverById('slack') !== undefined && serverById('slack').enabled === false,
    'slack installed disabled (needs config)',
  );

  // Switch the MCP mode to Bash CLI → persists to settings.json + the registry.
  await page.click('[data-testid="connectors-mcp-mode"] >> text=Bash CLI');
  await waitFor(
    () => readJson(settingsPath).mcpMode === 'bash-cli',
    'mcp mode persisted in settings',
  );
  await waitFor(() => readJson(mcpPath).mode === 'bash-cli', 'mcp registry mode rewritten');

  console.log(
    'connectors-probe OK — recommended rendered from mocked scan; real brand SVGs render for ' +
      'github/figma/blender; trademark disclaimer present; install + enable/disable persisted; ' +
      'detail page + permission popup rendered; bash-cli mode persisted',
  );
} finally {
  await app.close();
}
