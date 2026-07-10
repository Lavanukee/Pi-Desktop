/**
 * Compact connector catalog — the cheap, schema-free view of connected servers.
 *
 * This is the crux of MCP-lite: instead of loading every MCP tool's full JSON
 * schema into the model context, we keep only tool names + one-line
 * descriptions. The model reads this catalog (via the `mcp_list` tool), then
 * fetches a single schema on demand (`mcp_schema`) and calls through the proxy
 * (`mcp_call`) — so N servers × M tools cost a few tokens, not M schemas.
 */
import { oneLineDescription } from './schema';

/** One tool in the catalog (no schema). */
export interface CatalogToolEntry {
  /** Raw MCP tool name (as addressed via the proxy). */
  name: string;
  /** Fully-qualified name a native-mode registration would use (`<id>_<tool>`). */
  qualifiedName: string;
  /** One-line description. */
  description: string;
}

/** One server in the catalog. */
export interface CatalogServerEntry {
  id: string;
  name: string;
  status: 'connected' | 'error' | 'disconnected';
  toolCount: number;
  tools: CatalogToolEntry[];
  error?: string;
}

export type McpCatalog = CatalogServerEntry[];

/**
 * Render the catalog as compact text for the `mcp_list` tool result.
 * @param filterServerId when set, only that server's section is rendered.
 */
export function renderCatalogText(catalog: McpCatalog, filterServerId?: string): string {
  const servers = filterServerId ? catalog.filter((s) => s.id === filterServerId) : catalog;
  if (servers.length === 0) {
    return filterServerId
      ? `No MCP server with id "${filterServerId}".`
      : 'No MCP servers are connected.';
  }
  const lines: string[] = [];
  for (const s of servers) {
    if (s.status !== 'connected') {
      lines.push(`${s.name} (${s.id}) — ${s.status}${s.error ? `: ${s.error}` : ''}`);
      continue;
    }
    lines.push(`${s.name} (${s.id}) — ${s.toolCount} tool(s)`);
    for (const t of s.tools) {
      lines.push(`  ${t.name}: ${t.description || '(no description)'}`);
    }
  }
  lines.push('');
  lines.push('Call a tool with mcp_call {server, tool, arguments}.');
  lines.push('Fetch one tool’s full input schema with mcp_schema {server, tool}.');
  return lines.join('\n');
}

/** Build a catalog tool entry from a raw MCP tool def. */
export function toCatalogToolEntry(
  serverId: string,
  tool: { name: string; description?: string },
): CatalogToolEntry {
  return {
    name: tool.name,
    qualifiedName: `${serverId}_${tool.name}`,
    description: oneLineDescription(tool.description),
  };
}
