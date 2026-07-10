/**
 * ConnectorHost — owns the live {@link McpStdioClient}s for the enabled
 * connectors and is the single routing point for tool calls, catalog building,
 * and teardown. Both MCP-lite (proxy) and native mode read from one host.
 *
 * Spawn injection flows through to every client so the whole host unit-tests
 * against a fake spawn or the mock MCP server without a real connector.
 */
import type { CatalogServerEntry, McpCatalog } from './catalog';
import { toCatalogToolEntry } from './catalog';
import type { McpPromptDef, McpResourceDef, McpToolCallResult, McpToolDef } from './mcp-types';
import type { McpServerConfig } from './registry';
import { type McpSpawnFn, McpStdioClient } from './stdio-client';

/** Live state for one configured server. */
export interface ConnectedServer {
  config: McpServerConfig;
  /** Native tool-name prefix: `<id>_`. */
  prefix: string;
  client: McpStdioClient;
  tools: McpToolDef[];
}

interface ServerState {
  config: McpServerConfig;
  prefix: string;
  client: McpStdioClient | null;
  tools: McpToolDef[];
  status: 'connected' | 'error' | 'disconnected';
  error?: string;
}

export interface ConnectorHostOptions {
  /** Structural spawn injection, forwarded to every client. */
  spawnFn?: McpSpawnFn;
  /** Per-server stderr sink. */
  onLog?: (serverId: string, line: string) => void;
  /** Handshake timeout for connects. Default 15000. */
  connectTimeoutMs?: number;
}

/** Outcome of connecting one server (never rejects — errors are captured). */
export interface ConnectResult {
  id: string;
  ok: boolean;
  toolCount: number;
  error?: string;
}

export class ConnectorHost {
  private readonly servers = new Map<string, ServerState>();
  private readonly spawnFn: McpSpawnFn | undefined;
  private readonly onLog: (serverId: string, line: string) => void;
  private readonly connectTimeoutMs: number;

  constructor(opts: ConnectorHostOptions = {}) {
    this.spawnFn = opts.spawnFn;
    this.onLog = opts.onLog ?? (() => {});
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 15_000;
  }

  /** Connect a single server. Captures failures instead of throwing. */
  async connect(config: McpServerConfig): Promise<ConnectResult> {
    const prefix = `${config.id}_`;
    const client = new McpStdioClient({
      command: config.command,
      args: config.args ?? [],
      env: config.env ?? {},
      cwd: config.cwd,
      spawnFn: this.spawnFn,
      onLog: (line) => this.onLog(config.id, line),
    });
    const state: ServerState = { config, prefix, client, tools: [], status: 'disconnected' };
    this.servers.set(config.id, state);
    try {
      const tools = await client.start({ timeoutMs: this.connectTimeoutMs });
      state.tools = tools;
      state.status = 'connected';
      return { id: config.id, ok: true, toolCount: tools.length };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      try {
        client.stop();
      } catch {
        // best-effort teardown
      }
      state.client = null;
      state.status = 'error';
      state.error = error;
      return { id: config.id, ok: false, toolCount: 0, error };
    }
  }

  /** Connect every provided server concurrently. */
  async connectAll(configs: McpServerConfig[]): Promise<ConnectResult[]> {
    return Promise.all(configs.map((c) => this.connect(c)));
  }

  /** Re-run the handshake for an already-registered server. */
  async reconnect(id: string): Promise<ConnectResult> {
    const state = this.servers.get(id);
    if (!state) return { id, ok: false, toolCount: 0, error: `no server "${id}"` };
    if (state.client) {
      try {
        state.client.stop();
      } catch {
        // best-effort
      }
    }
    return this.connect(state.config);
  }

  /** Servers that completed the handshake. */
  getConnected(): ConnectedServer[] {
    const out: ConnectedServer[] = [];
    for (const s of this.servers.values()) {
      if (s.status === 'connected' && s.client) {
        out.push({ config: s.config, prefix: s.prefix, client: s.client, tools: s.tools });
      }
    }
    return out;
  }

  /** Tool defs for one connected server (empty if unknown/not connected). */
  getServerTools(id: string): McpToolDef[] {
    const s = this.servers.get(id);
    return s?.status === 'connected' ? s.tools : [];
  }

  /** A single tool def by server + tool name, if connected. */
  getTool(serverId: string, toolName: string): McpToolDef | undefined {
    return this.getServerTools(serverId).find((t) => t.name === toolName);
  }

  /** The compact, schema-free catalog across all tracked servers. */
  getCatalog(): McpCatalog {
    const catalog: McpCatalog = [];
    for (const s of this.servers.values()) {
      const entry: CatalogServerEntry = {
        id: s.config.id,
        name: s.config.name,
        status: s.status,
        toolCount: s.tools.length,
        tools: s.tools.map((t) => toCatalogToolEntry(s.config.id, t)),
      };
      if (s.error) entry.error = s.error;
      catalog.push(entry);
    }
    return catalog;
  }

  /**
   * Route a tool call to the owning server. Throws a descriptive error for an
   * unknown/disconnected server so callers can surface it as a tool error.
   */
  async callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown> = {},
  ): Promise<McpToolCallResult> {
    const state = this.servers.get(serverId);
    if (!state) {
      throw new Error(
        `Unknown MCP server "${serverId}". Connected: ${this.connectedIds().join(', ') || '(none)'}`,
      );
    }
    if (state.status !== 'connected' || !state.client) {
      throw new Error(
        `MCP server "${serverId}" is not connected${state.error ? ` (${state.error})` : ''}.`,
      );
    }
    if (!state.tools.some((t) => t.name === toolName)) {
      const names = state.tools.map((t) => t.name).join(', ') || '(none)';
      throw new Error(`Unknown tool "${toolName}" on "${serverId}". Available: ${names}`);
    }
    return state.client.callTool(toolName, args);
  }

  /** Resources exposed by a connected server. */
  async listResources(serverId: string): Promise<McpResourceDef[]> {
    const state = this.servers.get(serverId);
    if (state?.status !== 'connected' || !state.client) return [];
    return state.client.listResources();
  }

  /** Prompts exposed by a connected server. */
  async listPrompts(serverId: string): Promise<McpPromptDef[]> {
    const state = this.servers.get(serverId);
    if (state?.status !== 'connected' || !state.client) return [];
    return state.client.listPrompts();
  }

  private connectedIds(): string[] {
    return this.getConnected().map((s) => s.config.id);
  }

  /** Stop and forget one server. */
  disconnect(id: string): void {
    const state = this.servers.get(id);
    if (state?.client) {
      try {
        state.client.stop();
      } catch {
        // best-effort
      }
    }
    if (state) {
      state.client = null;
      state.status = 'disconnected';
    }
  }

  /** Stop every client. Call from session_shutdown. */
  disposeAll(): void {
    for (const s of this.servers.values()) {
      if (s.client) {
        try {
          s.client.stop();
        } catch {
          // best-effort
        }
        s.client = null;
        s.status = 'disconnected';
      }
    }
  }
}
