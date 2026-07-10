/**
 * Main-process importer + onboarding handlers. Reads Claude/Codex config off
 * disk (needs main-process fs; the renderer can't), converts Codex sessions into
 * pi session v3 files, merges MCP servers into the mcp-lite registry, and
 * persists the onboarding result. Registered behind the shared trusted-sender
 * gate (import channels read arbitrary config + write sessions/registry, so only
 * the main frame of an app-created window may reach them).
 *
 * NO-TOKEN GUARANTEE: the pure @pi-desktop/importers parsers never surface the
 * source apps' auth blobs (Claude config.json oauth cache, Codex auth.json,
 * reasoning encrypted_content); this layer only ever reads the files those pure
 * functions consume — it never opens auth.json or the oauth caches.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildClaudeImport,
  claudePaths,
  codexPaths,
  convertCodexSession,
  detectInstalledSources,
  encodePiSessionFolder,
  type ImportedMcpServer,
  parseCodexConfig,
  parseCodexSessionIndex,
} from '@pi-desktop/importers';
import { createLogger, type IpcHandlers, registerIpcHandlers } from '@pi-desktop/shared';
import type { IpcMain } from 'electron';
import type {
  CodexSessionListEntry,
  ImportInvokeMap,
  OnboardingChoices,
  OnboardingState,
} from './import-contract';

const log = createLogger('desktop:import');

const HOME = os.homedir();
const PI_SESSIONS_DIR = path.join(HOME, '.pi', 'agent', 'sessions');
const PI_SKILLS_DIR = path.join(HOME, '.pi', 'agent', 'skills');
const MCP_REGISTRY_PATH = path.join(HOME, '.pi', 'desktop', 'mcp-connectors.json');
const ONBOARDING_PATH = path.join(HOME, '.pi', 'desktop', 'onboarding.json');

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function safeRead(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

// ── Codex session discovery (cheap: readdir only, no file reads) ──────────────

/** Map codex session id → its rollout file, walking ~/.codex/sessions/YYYY/MM/DD. */
function indexRolloutFiles(
  dir: string,
  depth = 0,
  out = new Map<string, string>(),
): Map<string, string> {
  if (depth > 4) return out;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      indexRolloutFiles(full, depth + 1, out);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      const match = entry.name.match(UUID_RE);
      if (match) out.set(match[0], full);
    }
  }
  return out;
}

function listCodexSessions(): CodexSessionListEntry[] {
  const paths = codexPaths(HOME);
  const indexText = safeRead(paths.sessionIndex);
  const rows = indexText ? parseCodexSessionIndex(indexText) : [];
  const idToFile = indexRolloutFiles(paths.sessions);
  const out: CodexSessionListEntry[] = [];
  for (const row of rows) {
    const file = idToFile.get(row.id);
    if (file !== undefined) out.push({ ...row, file });
  }
  return out;
}

// ── Codex → pi session conversion + write ─────────────────────────────────────

function isInsideCodexSessions(file: string): boolean {
  const sessions = codexPaths(HOME).sessions;
  const resolved = path.resolve(file);
  return resolved === sessions || resolved.startsWith(sessions + path.sep);
}

function convertAndWrite(files: string[]): {
  written: number;
  targets: string[];
  errors: string[];
} {
  const targets: string[] = [];
  const errors: string[] = [];
  for (const file of files) {
    // Fence: only rollout files inside ~/.codex/sessions may be read here.
    if (!isInsideCodexSessions(file)) {
      errors.push(`refused (outside codex sessions): ${file}`);
      continue;
    }
    const text = safeRead(file);
    if (text === null) {
      errors.push(`unreadable: ${file}`);
      continue;
    }
    const converted = convertCodexSession(text);
    if (converted === null) {
      errors.push(`no session id/cwd: ${file}`);
      continue;
    }
    try {
      const folder = path.join(PI_SESSIONS_DIR, encodePiSessionFolder(converted.cwd));
      fs.mkdirSync(folder, { recursive: true });
      const stamp = converted.startedAt.replace(/[:.]/g, '-');
      const target = path.join(folder, `${stamp}_${converted.sessionId}.jsonl`);
      fs.writeFileSync(target, converted.jsonl, 'utf8');
      targets.push(target);
    } catch (error) {
      errors.push(`write failed (${file}): ${String(error)}`);
    }
  }
  log.info('codex sessions converted', { written: targets.length, errors: errors.length });
  return { written: targets.length, targets, errors };
}

// ── MCP registry merge (mcp-lite on-disk shape; kept decoupled from the pkg) ───

interface RegistryServer {
  id: string;
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
  description?: string;
}
interface Registry {
  version: 1;
  mode: 'lite' | 'native';
  servers: RegistryServer[];
}

function loadRegistry(): Registry {
  const raw = safeRead(MCP_REGISTRY_PATH);
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as Partial<Registry>;
      if (Array.isArray(parsed.servers)) {
        return {
          version: 1,
          mode: parsed.mode === 'native' ? 'native' : 'lite',
          servers: parsed.servers,
        };
      }
    } catch {
      // fall through to a fresh registry — a hand-broken file can't block import.
    }
  }
  return { version: 1, mode: 'lite', servers: [] };
}

/** Stable, tool-name-safe id from a server name (mcp-lite prefixes tools `<id>_`). */
function serverId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug || 'server';
}

function applyMcp(servers: ImportedMcpServer[]): { applied: number; registryPath: string } {
  const registry = loadRegistry();
  let applied = 0;
  const usedIds = new Set(registry.servers.map((s) => s.id));
  for (const server of servers) {
    let id = serverId(server.name);
    // De-dupe id collisions across different names.
    if (usedIds.has(id) && !registry.servers.some((s) => s.name === server.name)) {
      let n = 2;
      while (usedIds.has(`${id}_${n}`)) n++;
      id = `${id}_${n}`;
    }
    usedIds.add(id);
    const next: RegistryServer = {
      id,
      name: server.name,
      command: server.command,
      enabled: true,
      description: 'Imported from onboarding',
    };
    if (server.args.length > 0) next.args = server.args;
    if (server.env) next.env = server.env;
    registry.servers = [...registry.servers.filter((s) => s.id !== id), next];
    applied++;
  }
  fs.mkdirSync(path.dirname(MCP_REGISTRY_PATH), { recursive: true });
  fs.writeFileSync(MCP_REGISTRY_PATH, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  log.info('mcp servers applied', { applied, registryPath: MCP_REGISTRY_PATH });
  return { applied, registryPath: MCP_REGISTRY_PATH };
}

// ── Skills copy ───────────────────────────────────────────────────────────────

function listCodexSkills(): string[] {
  const dir = codexPaths(HOME).skills;
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function applySkills(names: string[]): { applied: number; errors: string[] } {
  const skillsDir = codexPaths(HOME).skills;
  const errors: string[] = [];
  let applied = 0;
  for (const name of names) {
    // Fence: single path segment only (no traversal), must exist as a dir.
    if (name.includes('/') || name.includes('..') || name.startsWith('.')) {
      errors.push(`refused skill name: ${name}`);
      continue;
    }
    const src = path.join(skillsDir, name);
    try {
      if (!fs.statSync(src).isDirectory()) throw new Error('not a directory');
      fs.cpSync(src, path.join(PI_SKILLS_DIR, name), { recursive: true });
      applied++;
    } catch (error) {
      errors.push(`skill "${name}": ${String(error)}`);
    }
  }
  return { applied, errors };
}

// ── Onboarding persistence (~/.pi/desktop/onboarding.json) ─────────────────────

function readOnboarding(): OnboardingState {
  // E2E: onboarding is opt-in. `PI_ONBOARDING=1` exercises the real on-disk gate
  // (the wizard probe points HOME at an isolated dir), so first launch shows the
  // wizard and a relaunch after completion skips it — a genuine persistence test.
  // Without that flag, every OTHER E2E probe must land straight in chat, so treat
  // onboarding as already complete. Production always uses the on-disk gate.
  if (process.env.PI_E2E === '1' && process.env.PI_ONBOARDING !== '1') {
    return { firstRunComplete: true, choices: null };
  }
  const raw = safeRead(ONBOARDING_PATH);
  if (raw === null) return { firstRunComplete: false, choices: null };
  try {
    const parsed = JSON.parse(raw) as { completedAt?: unknown; choices?: OnboardingChoices };
    if (typeof parsed.completedAt === 'string' && parsed.choices) {
      return { firstRunComplete: true, choices: parsed.choices };
    }
  } catch {
    // corrupt file → treat as first run (re-onboard rather than brick).
  }
  return { firstRunComplete: false, choices: null };
}

/** Delete onboarding.json so the first-run gate re-opens the wizard. Settings
 * (settings.json) are left intact; the wizard applies fresh choices live. */
function resetOnboarding(): { ok: boolean } {
  try {
    fs.rmSync(ONBOARDING_PATH, { force: true });
    log.info('onboarding reset');
    return { ok: true };
  } catch (error) {
    log.warn('onboarding reset failed', { error: String(error) });
    return { ok: false };
  }
}

function completeOnboarding(choices: OnboardingChoices): { ok: boolean } {
  try {
    fs.mkdirSync(path.dirname(ONBOARDING_PATH), { recursive: true });
    const record = { version: 1, completedAt: new Date().toISOString(), choices };
    fs.writeFileSync(ONBOARDING_PATH, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    log.info('onboarding completed', { source: choices.source });
    return { ok: true };
  } catch (error) {
    log.warn('onboarding persist failed', { error: String(error) });
    return { ok: false };
  }
}

// ── Registration ──────────────────────────────────────────────────────────────

const handlers: IpcHandlers<ImportInvokeMap> = {
  'import:detect': () =>
    detectInstalledSources({ home: HOME, fs: { fileExists: (p) => fs.existsSync(p) } }),
  'import:claude': () => {
    const paths = claudePaths(HOME);
    return buildClaudeImport({
      mcpConfig: safeRead(paths.mcpConfig),
      themeConfig: safeRead(paths.themeConfig),
      windowState: safeRead(paths.windowState),
    });
  },
  'import:codex-config': () => {
    const config = parseCodexConfig(safeRead(codexPaths(HOME).config) ?? '');
    return { ...config, skills: listCodexSkills() };
  },
  'import:codex-sessions-list': () => listCodexSessions(),
  'import:codex-session-convert': (req) => convertAndWrite(req.files),
  'import:apply-mcp': (req) => applyMcp(req.servers),
  'import:apply-skills': (req) => applySkills(req.names),
  'onboarding:get-state': () => readOnboarding(),
  'onboarding:complete': (req) => completeOnboarding(req.choices),
  'onboarding:reset': () => resetOnboarding(),
};

export function registerImportIpc(
  ipcMain: IpcMain,
  allowSender: (event: unknown) => boolean,
): void {
  registerIpcHandlers<ImportInvokeMap>(ipcMain, handlers, { allowSender });
}
