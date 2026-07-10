/**
 * Codex importer — config.toml + session_index.jsonl parsing (pure).
 *
 * NO-TOKEN GUARANTEE: this module never reads `~/.codex/auth.json`. config.toml
 * `[mcp_servers.*].env` is the user's own server config (migrated intentionally),
 * not a Codex auth secret.
 */
import { parse as parseToml } from 'smol-toml';
import type {
  CodexConfigImport,
  CodexPlugin,
  CodexSessionIndexEntry,
  ImportedMcpServer,
} from './types';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
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

const EMPTY_CONFIG: CodexConfigImport = {
  model: null,
  reasoningEffort: null,
  plugins: [],
  trustedProjects: [],
  mcpServers: [],
};

/** Parse config.toml → {model, reasoningEffort, plugins, trustedProjects, mcpServers}. */
export function parseCodexConfig(text: string): CodexConfigImport {
  let data: unknown;
  try {
    data = parseToml(text);
  } catch {
    return { ...EMPTY_CONFIG };
  }
  if (!isRecord(data)) return { ...EMPTY_CONFIG };

  const model = typeof data.model === 'string' ? data.model : null;
  const reasoningEffort =
    typeof data.model_reasoning_effort === 'string' ? data.model_reasoning_effort : null;

  const plugins: CodexPlugin[] = [];
  if (isRecord(data.plugins)) {
    for (const [id, def] of Object.entries(data.plugins)) {
      plugins.push({ id, enabled: isRecord(def) ? def.enabled !== false : true });
    }
  }

  const trustedProjects: string[] = [];
  if (isRecord(data.projects)) {
    for (const [projectPath, def] of Object.entries(data.projects)) {
      if (isRecord(def) && def.trust_level === 'trusted') trustedProjects.push(projectPath);
    }
  }

  const mcpServers: ImportedMcpServer[] = [];
  if (isRecord(data.mcp_servers)) {
    for (const [name, def] of Object.entries(data.mcp_servers)) {
      if (!isRecord(def) || typeof def.command !== 'string') continue;
      if (def.enabled === false) continue;
      const server: ImportedMcpServer = { name, command: def.command, args: stringArray(def.args) };
      const env = stringMap(def.env);
      if (env) server.env = env;
      mcpServers.push(server);
    }
  }

  return { model, reasoningEffort, plugins, trustedProjects, mcpServers };
}

/**
 * Parse session_index.jsonl → the cheap import-picker list. One JSON object per
 * line: {id, thread_name, updated_at}. Unparseable/incomplete lines are skipped.
 */
export function parseCodexSessionIndex(text: string): CodexSessionIndexEntry[] {
  const out: CodexSessionIndexEntry[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(obj) || typeof obj.id !== 'string') continue;
    out.push({
      id: obj.id,
      threadName: typeof obj.thread_name === 'string' ? obj.thread_name : '',
      updatedAt: typeof obj.updated_at === 'string' ? obj.updated_at : '',
    });
  }
  // Most-recent first (matches the sidebar/picker ordering elsewhere).
  out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return out;
}
