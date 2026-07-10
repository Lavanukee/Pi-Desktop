/**
 * pi tool registrars for the two connector modes.
 *
 * - Native mode ({@link registerNativeTools}): every MCP tool becomes a
 *   first-class pi tool with its full JSON schema, prefixed per server. Highest
 *   fidelity, but every schema is loaded into the model context.
 * - MCP-lite / proxy mode ({@link registerProxyTools}): three generic tools
 *   (`mcp_list`, `mcp_schema`, `mcp_call`) let the model discover then call MCP
 *   tools while their schemas stay out of context until fetched on demand.
 *
 * Both route through a single {@link ConnectorHost}.
 */
import type { AgentToolResult, ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { type Static, Type } from '@sinclair/typebox';
import { renderCatalogText } from './catalog';
import type { ConnectedServer, ConnectorHost } from './connector-host';
import { mcpInputSchemaToTypeBox, mcpResultToPiContent } from './schema';

/** Structured details attached to MCP tool results (for logs/UI). */
export interface McpToolResultDetails {
  server?: string;
  tool?: string;
  isError: boolean;
}

/** Run a routed MCP call and shape it as a pi tool result. */
async function runMcpCall(
  host: ConnectorHost,
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<AgentToolResult<McpToolResultDetails>> {
  try {
    const res = await host.callTool(serverId, toolName, args);
    return {
      content: mcpResultToPiContent(res),
      details: { server: serverId, tool: toolName, isError: res.isError === true },
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      content: [{ type: 'text', text: `MCP error (${serverId}/${toolName}): ${message}` }],
      details: { server: serverId, tool: toolName, isError: true },
    };
  }
}

function asArgs(params: unknown): Record<string, unknown> {
  return params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
}

/**
 * Register every tool of one connected server as a native pi tool. Returns the
 * registered (prefixed) tool names.
 */
export function registerNativeTools(
  pi: ExtensionAPI,
  host: ConnectorHost,
  server: ConnectedServer,
): string[] {
  const registered: string[] = [];
  for (const tool of server.tools) {
    const name = server.prefix + tool.name;
    registered.push(name);
    pi.registerTool({
      name,
      label: `${server.config.name}: ${tool.name}`,
      description: tool.description ?? `MCP tool "${tool.name}" from ${server.config.name}.`,
      parameters: mcpInputSchemaToTypeBox(tool.inputSchema),
      execute: (_toolCallId, params) =>
        runMcpCall(host, server.config.id, tool.name, asArgs(params)),
    });
  }
  return registered;
}

const mcpListSchema = Type.Object({
  server: Type.Optional(
    Type.String({ description: 'Optional server id to filter the listing to one connector.' }),
  ),
});

const mcpSchemaSchema = Type.Object({
  server: Type.String({ description: 'Server id (from mcp_list).' }),
  tool: Type.String({ description: 'Tool name (from mcp_list).' }),
});

const mcpCallSchema = Type.Object({
  server: Type.String({ description: 'Server id (from mcp_list).' }),
  tool: Type.String({ description: 'Tool name (from mcp_list).' }),
  arguments: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: 'Arguments object matching the tool schema (see mcp_schema).',
    }),
  ),
});

/** Names of the three generic MCP-lite proxy tools. */
export const PROXY_TOOL_NAMES = ['mcp_list', 'mcp_schema', 'mcp_call'] as const;

/**
 * Register the three generic MCP-lite proxy tools. Idempotent per pi instance:
 * call once regardless of how many lite-mode servers are connected.
 */
export function registerProxyTools(pi: ExtensionAPI, host: ConnectorHost): string[] {
  pi.registerTool({
    name: 'mcp_list',
    label: 'MCP: list tools',
    description:
      'List connected MCP servers and their tools (names + one-line descriptions only). ' +
      'Use this to discover MCP tools before calling them. Schemas are fetched separately with mcp_schema.',
    parameters: mcpListSchema,
    execute: (_toolCallId, params: Static<typeof mcpListSchema>) => {
      const text = renderCatalogText(host.getCatalog(), params.server);
      return Promise.resolve({
        content: [{ type: 'text', text }],
        details: { isError: false } as McpToolResultDetails,
      });
    },
  });

  pi.registerTool({
    name: 'mcp_schema',
    label: 'MCP: tool schema',
    description:
      'Return the full JSON input schema for a single MCP tool, on demand. ' +
      'Call this right before mcp_call so a tool schema only enters context when you actually need it.',
    parameters: mcpSchemaSchema,
    execute: (_toolCallId, params: Static<typeof mcpSchemaSchema>) => {
      const tool = host.getTool(params.server, params.tool);
      if (!tool) {
        const available = host
          .getServerTools(params.server)
          .map((t) => t.name)
          .join(', ');
        const text = available
          ? `Unknown tool "${params.tool}" on "${params.server}". Available: ${available}`
          : `No connected server "${params.server}". Use mcp_list.`;
        return Promise.resolve({
          content: [{ type: 'text', text }],
          details: {
            server: params.server,
            tool: params.tool,
            isError: true,
          } as McpToolResultDetails,
        });
      }
      const schema = tool.inputSchema ?? { type: 'object', properties: {} };
      return Promise.resolve({
        content: [{ type: 'text', text: JSON.stringify(schema, null, 2) }],
        details: {
          server: params.server,
          tool: params.tool,
          isError: false,
        } as McpToolResultDetails,
      });
    },
  });

  pi.registerTool({
    name: 'mcp_call',
    label: 'MCP: call tool',
    description:
      'Invoke an MCP tool on a connected server. Discover tools with mcp_list and their arguments with mcp_schema first.',
    parameters: mcpCallSchema,
    execute: (_toolCallId, params: Static<typeof mcpCallSchema>) =>
      runMcpCall(host, params.server, params.tool, asArgs(params.arguments)),
  });

  return [...PROXY_TOOL_NAMES];
}
