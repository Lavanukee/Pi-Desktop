/**
 * Connector registry — the typed, on-disk config the connectors gallery reads
 * and writes. Pure functions (parse/serialize/mutate) plus a small injectable
 * file IO so it is electron-free and unit-testable without touching a disk.
 *
 * On-disk shape (JSON) lives at ~/.pi/desktop/mcp-connectors.json by default.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * How a server's tools are surfaced to the model.
 * - `lite`: one generic proxy tool set (`mcp_list`/`mcp_schema`/`mcp_call`),
 *   schemas fetched on demand.
 * - `native`: every MCP tool registered directly (`<id>_<tool>`), full schema in
 *   context.
 * - `bash-cli`: connectors reached through the real `bash` tool via a generated
 *   `pi-tool` dispatcher on an injected PATH (a token-gated Unix-socket bridge),
 *   so a small model uses familiar shell commands instead of structured calls.
 */
export type McpMode = 'lite' | 'native' | 'bash-cli';

/** Every valid connector mode, in UI order. */
export const MCP_MODES: readonly McpMode[] = ['lite', 'native', 'bash-cli'];

/** A single configured MCP server (one gallery card). */
export interface McpServerConfig {
  /** Stable id, also used as the native tool-name prefix (`<id>_<tool>`). */
  id: string;
  /** Human-readable name for the gallery. */
  name: string;
  /** Emoji or asset key the gallery renders as the card icon. */
  icon?: string;
  /** One-line description for the gallery card. */
  description?: string;
  /** Executable that launches the server. */
  command: string;
  /** Arguments passed to the server. */
  args?: string[];
  /** Extra env vars (e.g. API tokens) merged over process.env. */
  env?: Record<string, string>;
  /** Working directory for the server. */
  cwd?: string;
  /** Whether this connector is active. Default true. */
  enabled?: boolean;
  /** Per-server mode override; falls back to the registry default when unset. */
  mode?: McpMode;
}

/** The whole connectors config. */
export interface McpRegistryConfig {
  version: 1;
  /** Default mode applied to servers without their own `mode`. */
  mode: McpMode;
  servers: McpServerConfig[];
}

/** Injectable file IO so the registry never hard-depends on node:fs. */
export interface RegistryFileIO {
  /** Return file contents, or undefined if the file does not exist. */
  read(filePath: string): string | undefined;
  /** Write file contents, creating parent directories as needed. */
  write(filePath: string, data: string): void;
}

/** Default node:fs-backed IO for production use. */
export const nodeRegistryIO: RegistryFileIO = {
  read(filePath) {
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch {
      return undefined;
    }
  },
  write(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, data, 'utf8');
  },
};

/** Canonical config path under a given home directory. */
export function defaultRegistryPath(homedir: string): string {
  return path.join(homedir, '.pi', 'desktop', 'mcp-connectors.json');
}

/** A fresh, empty registry (lite mode by default — the MCP-lite philosophy). */
export function defaultRegistry(): McpRegistryConfig {
  return { version: 1, mode: 'lite', servers: [] };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function normalizeMode(v: unknown): McpMode | undefined {
  return v === 'lite' || v === 'native' || v === 'bash-cli' ? v : undefined;
}

function normalizeStringMap(v: unknown): Record<string, string> | undefined {
  if (!isRecord(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === 'string') out[k] = val;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeServer(v: unknown): McpServerConfig | undefined {
  if (!isRecord(v)) return undefined;
  const id = typeof v.id === 'string' ? v.id : undefined;
  const command = typeof v.command === 'string' ? v.command : undefined;
  if (!id || !command) return undefined;
  const args = Array.isArray(v.args)
    ? v.args.filter((a): a is string => typeof a === 'string')
    : undefined;
  const server: McpServerConfig = {
    id,
    name: typeof v.name === 'string' ? v.name : id,
    command,
  };
  if (typeof v.icon === 'string') server.icon = v.icon;
  if (typeof v.description === 'string') server.description = v.description;
  if (args && args.length > 0) server.args = args;
  const env = normalizeStringMap(v.env);
  if (env) server.env = env;
  if (typeof v.cwd === 'string') server.cwd = v.cwd;
  if (typeof v.enabled === 'boolean') server.enabled = v.enabled;
  const mode = normalizeMode(v.mode);
  if (mode) server.mode = mode;
  return server;
}

/**
 * Coerce arbitrary parsed JSON into a valid {@link McpRegistryConfig}. Never
 * throws: unknown/broken fields fall back to defaults so a hand-edited file
 * can't brick the connectors page.
 */
export function parseRegistry(data: unknown): McpRegistryConfig {
  if (!isRecord(data)) return defaultRegistry();
  const mode = normalizeMode(data.mode) ?? 'lite';
  const rawServers = Array.isArray(data.servers) ? data.servers : [];
  const servers: McpServerConfig[] = [];
  const seen = new Set<string>();
  for (const raw of rawServers) {
    const server = normalizeServer(raw);
    if (server && !seen.has(server.id)) {
      seen.add(server.id);
      servers.push(server);
    }
  }
  return { version: 1, mode, servers };
}

/** Serialize a registry to pretty JSON (trailing newline for clean diffs). */
export function serializeRegistry(config: McpRegistryConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** Read + parse the registry, returning a default when the file is absent. */
export function loadRegistry(
  filePath: string,
  io: RegistryFileIO = nodeRegistryIO,
): McpRegistryConfig {
  const raw = io.read(filePath);
  if (raw === undefined) return defaultRegistry();
  try {
    return parseRegistry(JSON.parse(raw));
  } catch {
    return defaultRegistry();
  }
}

/** Serialize + write the registry. */
export function saveRegistry(
  filePath: string,
  config: McpRegistryConfig,
  io: RegistryFileIO = nodeRegistryIO,
): void {
  io.write(filePath, serializeRegistry(config));
}

// ── pure mutations the gallery uses (return new configs) ─────────────────────

/** Insert or replace a server by id. */
export function upsertServer(
  config: McpRegistryConfig,
  server: McpServerConfig,
): McpRegistryConfig {
  const servers = config.servers.filter((s) => s.id !== server.id);
  servers.push(server);
  return { ...config, servers };
}

/** Remove a server by id. */
export function removeServer(config: McpRegistryConfig, id: string): McpRegistryConfig {
  return { ...config, servers: config.servers.filter((s) => s.id !== id) };
}

/** Toggle a server's enabled flag. */
export function setServerEnabled(
  config: McpRegistryConfig,
  id: string,
  enabled: boolean,
): McpRegistryConfig {
  return {
    ...config,
    servers: config.servers.map((s) => (s.id === id ? { ...s, enabled } : s)),
  };
}
