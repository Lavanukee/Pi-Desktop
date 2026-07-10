/**
 * Claude Desktop importer — pure functions over injected file contents.
 *
 * NO-TOKEN GUARANTEE: config.json also holds `oauth:tokenCache*` /
 * `dxt:allowlistCache:*` secret blobs. {@link parseClaudeTheme} reads ONLY the
 * `userThemeMode` field by name, so those blobs are structurally unreachable —
 * never enumerate config.json's keys. (claude_desktop_config.json's per-server
 * `env` is the user's own MCP server config and is migrated intentionally.)
 */
import type {
  ClaudeImport,
  ClaudeThemeImport,
  ClaudeThemeMode,
  ClaudeWindowStateImport,
  ImportedMcpServer,
} from './types';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function stringMap(v: unknown): Record<string, string> | undefined {
  if (!isRecord(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === 'string') out[k] = val;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Parse the `mcpServers` map from claude_desktop_config.json. Only
 * command/args/env are read per server; a server without a string `command` is
 * skipped. Absent/invalid input yields an empty list.
 */
export function parseClaudeMcpServers(text: string): ImportedMcpServer[] {
  const root = safeJson(text);
  if (!isRecord(root) || !isRecord(root.mcpServers)) return [];
  const out: ImportedMcpServer[] = [];
  for (const [name, def] of Object.entries(root.mcpServers)) {
    if (!isRecord(def) || typeof def.command !== 'string') continue;
    const server: ImportedMcpServer = {
      name,
      command: def.command,
      args: stringArray(def.args),
    };
    const env = stringMap(def.env);
    if (env) server.env = env;
    out.push(server);
  }
  return out;
}

function normalizeThemeMode(v: unknown): ClaudeThemeMode | null {
  return v === 'light' || v === 'dark' || v === 'system' ? v : null;
}

/**
 * Extract ONLY `userThemeMode` from config.json. By reading the single field by
 * name we never touch the oauth/token blobs in the same file (no-token guarantee).
 */
export function parseClaudeTheme(text: string): ClaudeThemeImport {
  const root = safeJson(text);
  if (!isRecord(root)) return { themeMode: null };
  return { themeMode: normalizeThemeMode(root.userThemeMode) };
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Parse window-state.json into portable bounds (missing fields tolerated). */
export function parseClaudeWindowState(text: string): ClaudeWindowStateImport {
  const root = safeJson(text);
  if (!isRecord(root)) return { bounds: null };
  const width = num(root.width);
  const height = num(root.height);
  if (width === undefined || height === undefined) return { bounds: null };
  return {
    bounds: {
      width,
      height,
      ...(num(root.x) !== undefined && { x: num(root.x) }),
      ...(num(root.y) !== undefined && { y: num(root.y) }),
      isMaximized: root.isMaximized === true,
      isFullScreen: root.isFullScreen === true,
    },
  };
}

/** Assemble the full Claude import bundle from the three source files' contents.
 * Any file may be null/empty; each parser degrades to its empty shape. */
export function buildClaudeImport(files: {
  mcpConfig: string | null;
  themeConfig: string | null;
  windowState: string | null;
}): ClaudeImport {
  return {
    mcpServers: files.mcpConfig ? parseClaudeMcpServers(files.mcpConfig) : [],
    theme: files.themeConfig ? parseClaudeTheme(files.themeConfig) : { themeMode: null },
    window: files.windowState ? parseClaudeWindowState(files.windowState) : { bounds: null },
  };
}
