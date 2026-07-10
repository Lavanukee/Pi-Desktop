/**
 * Settings E2E: lands in chat (mock pi) under an isolated HOME, opens Settings
 * from the top-bar gear, changes theme (flavor + mode), permission mode, and
 * effort, and asserts each is BOTH applied live (theme → data-flavor/data-mode)
 * AND persisted to ~/.pi/desktop/settings.json. Also flips MCP mode and checks
 * the mcp-connectors.json registry `mode` is rewritten. Run `pnpm build` first.
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
  if (!condition) throw new Error(`settings-probe failed: ${message}`);
}

assert(existsSync(path.join(appRoot, 'dist/index.html')), 'app is not built — run `pnpm build`');

const home = mkdtempSync(path.join(tmpdir(), 'pi-e2e-home-'));
const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'));
const settingsPath = path.join(home, '.pi', 'desktop', 'settings.json');
const mcpPath = path.join(home, '.pi', 'desktop', 'mcp-connectors.json');

const readSettings = () => JSON.parse(readFileSync(settingsPath, 'utf8'));
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
  throw new Error(`settings-probe failed: timed out waiting for ${label}`);
}

const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${userDataDir}`],
  env: { ...process.env, HOME: home, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});

try {
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 12000 });

  // Round-12 #4: the settings entry point is the "Settings" row (keeps the
  // `open-settings` testid) inside the bottom-left profile DROPUP — open it via
  // `profile-button` first. It opens the settings menu at Custom instructions,
  // so navigate to Appearance before exercising the theme controls.
  await page.click('[data-testid="profile-button"]');
  await page.waitForSelector('[data-testid="profile-menu"]', { timeout: 8000 });
  await page.click('[data-testid="open-settings"]');
  await page.waitForSelector('[data-testid="settings-view"]', { timeout: 8000 });

  // ── Appearance: mode applies live and persists (light/dark/system only) ──────
  await page.click('[data-testid="settings-nav-appearance"]');
  await page.waitForSelector('[data-testid="settings-mode"]', { timeout: 8000 });
  await page.click('[data-testid="settings-mode"] >> text=Light');
  await page.waitForFunction(() => document.documentElement.getAttribute('data-mode') === 'light', {
    timeout: 5000,
  });
  await waitFor(() => readSettings().theme.mode === 'light', 'mode persisted');

  // ── Interface → Advanced: the flavor toggle (relocated round-5 #23) ──────────
  await page.click('[data-testid="settings-nav-interface"]');
  await page.waitForSelector('[data-testid="settings-flavor"]', { timeout: 8000 });
  await page.click('[data-testid="settings-flavor"] >> text=Codex');
  await page.waitForFunction(
    () => document.documentElement.getAttribute('data-flavor') === 'codex',
    {
      timeout: 5000,
    },
  );
  await waitFor(() => readSettings().theme.flavor === 'codex', 'flavor persisted');

  // ── Agent: permission mode + effort persist ─────────────────────────────────
  await page.click('[data-testid="settings-nav-agent"]');
  await page.waitForSelector('[data-testid="settings-permission"]', { timeout: 8000 });
  await page.click('[data-testid="settings-permission"] >> text=Bypass');
  await waitFor(() => readSettings().permissionMode === 'bypass', 'permission persisted');

  await page.click('[data-testid="settings-effort"] >> text=High');
  await waitFor(() => readSettings().effort === 'high', 'effort persisted');

  // Applied live: the bypass segment is pressed.
  const pressed = await page.getAttribute(
    '[data-testid="settings-permission"] button:has-text("Bypass")',
    'aria-pressed',
  );
  assert(pressed === 'true', `expected Bypass pressed, got aria-pressed=${pressed}`);

  // ── Connectors: MCP mode flips the registry file ────────────────────────────
  await page.click('[data-testid="settings-nav-connectors"]');
  await page.waitForSelector('[data-testid="settings-mcp-mode"]', { timeout: 8000 });
  await page.click('[data-testid="settings-mcp-mode"] >> text=Native');
  await waitFor(() => readSettings().mcpMode === 'native', 'mcp mode persisted in settings');
  await waitFor(
    () => JSON.parse(readFileSync(mcpPath, 'utf8')).mode === 'native',
    'mcp registry mode rewritten',
  );

  console.log(
    'settings-probe OK — theme applied live + persisted; permission/effort/mcp-mode persisted; registry rewritten',
  );
} finally {
  await app.close();
}
