/**
 * Main-process settings handlers. Owns `~/.pi/desktop/settings.json` (mode 0600
 * — it holds API keys) and the side effects that make the frozen extensions
 * observe a change:
 *   - web search keys → the main process env (`PI_BRAVE_API_KEY` /
 *     `PI_TAVILY_API_KEY`), which a (re)spawned pi child inherits so its
 *     web-tools extension reads them (web-tools reads keys from env only).
 *   - MCP mode → the `mode` field of `~/.pi/desktop/mcp-connectors.json`, the
 *     registry mcp-lite loads (servers preserved).
 *
 * Seeding is pure/read-only: an absent settings.json yields an in-memory
 * document derived from onboarding.json + the mcp registry, and is only written
 * once the user actually changes something (settings:set) — so read-only E2E
 * probes never mutate the profile. Trusted-sender gated with the shared
 * allowSender, exactly like the import channels.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createLogger, type IpcHandlers, registerIpcHandlers } from '@pi-desktop/shared';
import type { IpcMain } from 'electron';
import type { OnboardingChoices } from '../import/import-contract';
import type { DesktopSettings, McpMode, SettingsInvokeMap } from './settings-contract';
import { clampSettings, mergeSettingsPatch, seedFromOnboarding } from './settings-logic';

const log = createLogger('desktop:settings');

const HOME = os.homedir();
const SETTINGS_PATH = path.join(HOME, '.pi', 'desktop', 'settings.json');
const ONBOARDING_PATH = path.join(HOME, '.pi', 'desktop', 'onboarding.json');
const MCP_REGISTRY_PATH = path.join(HOME, '.pi', 'desktop', 'mcp-connectors.json');

function safeRead(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function readOnboardingChoices(): OnboardingChoices | null {
  // Mirror import-main's E2E gate: with PI_E2E set (and not the onboarding
  // probe), treat the profile as fresh so seeding never pulls the real user's
  // onboarding.json into a probe run (which would skew the base theme probe).
  if (process.env.PI_E2E === '1' && process.env.PI_ONBOARDING !== '1') return null;
  const raw = safeRead(ONBOARDING_PATH);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as { choices?: OnboardingChoices };
    return parsed.choices ?? null;
  } catch {
    return null;
  }
}

function readMcpMode(): McpMode | null {
  const raw = safeRead(MCP_REGISTRY_PATH);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as { mode?: unknown };
    return parsed.mode === 'native' ? 'native' : parsed.mode === 'lite' ? 'lite' : null;
  } catch {
    return null;
  }
}

/** Current document: the persisted file when present, else a pure seed (no
 * write) from onboarding + the mcp registry. */
export function readSettings(): DesktopSettings {
  const raw = safeRead(SETTINGS_PATH);
  if (raw === null) return seedFromOnboarding(readOnboardingChoices(), readMcpMode());
  try {
    return clampSettings(JSON.parse(raw));
  } catch {
    // Corrupt file → re-seed rather than brick the settings surface.
    return seedFromOnboarding(readOnboardingChoices(), readMcpMode());
  }
}

/** Mirror the search keys into the main process env so the NEXT pi child (a
 * fresh window or a `pi:restart`) hands them to web-tools. Empty = unset. */
function applySearchEnv(settings: DesktopSettings): void {
  if (settings.search.brave) process.env.PI_BRAVE_API_KEY = settings.search.brave;
  else delete process.env.PI_BRAVE_API_KEY;
  if (settings.search.tavily) process.env.PI_TAVILY_API_KEY = settings.search.tavily;
  else delete process.env.PI_TAVILY_API_KEY;
}

/** Flip the `mode` field of the mcp-lite registry, preserving `servers`. */
function applyMcpMode(mode: McpMode): void {
  let doc: Record<string, unknown> = { version: 1, mode, servers: [] };
  const raw = safeRead(MCP_REGISTRY_PATH);
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (Array.isArray(parsed.servers)) doc = { ...parsed, version: 1, mode };
    } catch {
      // fall through to a fresh registry with just the mode set.
    }
  }
  try {
    fs.mkdirSync(path.dirname(MCP_REGISTRY_PATH), { recursive: true });
    fs.writeFileSync(MCP_REGISTRY_PATH, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  } catch (error) {
    log.warn('mcp mode write failed', { error: String(error) });
  }
}

function writeSettings(settings: DesktopSettings): void {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  // 0600: the document carries web-search API keys.
  fs.writeFileSync(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  applySearchEnv(settings);
  applyMcpMode(settings.mcpMode);
}

/**
 * Called once at main startup (before the first pi spawn) so a persisted set of
 * search keys is already on the env for the initial session. Read-only unless a
 * settings.json exists; never seeds/writes.
 */
export function applySettingsEnvFromDisk(): void {
  if (safeRead(SETTINGS_PATH) === null) return;
  applySearchEnv(readSettings());
}

const handlers: IpcHandlers<SettingsInvokeMap> = {
  'settings:get': () => readSettings(),
  'settings:set': (req) => {
    const next = mergeSettingsPatch(readSettings(), req.patch);
    writeSettings(next);
    log.info('settings updated', {
      keys: Object.keys(req.patch),
      mcpMode: next.mcpMode,
      permissionMode: next.permissionMode,
      effort: next.effort,
    });
    return next;
  },
};

export function registerSettingsIpc(
  ipcMain: IpcMain,
  allowSender: (event: unknown) => boolean,
): void {
  registerIpcHandlers<SettingsInvokeMap>(ipcMain, handlers, { allowSender });
}
