/**
 * MCP wire protocol types — the newline-delimited JSON-RPC 2.0 stdio transport.
 *
 * These describe only what an MCP *client* sends and receives. They are kept
 * deliberately loose (optional fields, opaque JSON schemas) because MCP servers
 * evolve independently and we forward their tool schemas to the model unchanged.
 */

/** Protocol revision we advertise in `initialize`. */
export const MCP_PROTOCOL_VERSION = '2024-11-05';

/** JSON-RPC 2.0 request/response id. */
export type JsonRpcId = number | string;

/** A JSON-RPC 2.0 error object as returned by a server. */
export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** A parsed inbound JSON-RPC message (response or server-initiated). */
export interface JsonRpcMessage {
  jsonrpc?: '2.0';
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcError;
}

/**
 * A JSON Schema object as carried by MCP tool definitions. Opaque to us: we
 * forward it to the model verbatim rather than remodelling it in TypeBox.
 */
export interface JsonSchema {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

/** Server identity returned by the `initialize` handshake. */
export interface McpServerInfo {
  name?: string;
  version?: string;
}

/** Result of the `initialize` request. */
export interface McpInitializeResult {
  protocolVersion?: string;
  capabilities?: Record<string, unknown>;
  serverInfo?: McpServerInfo;
}

/** A tool advertised by `tools/list`. */
export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
}

/** A resource advertised by `resources/list`. */
export interface McpResourceDef {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

/** A prompt advertised by `prompts/list`. */
export interface McpPromptDef {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

/**
 * A content block in a tool/resource result. Kept as one loose interface (not a
 * discriminated union) so an unknown/future `type` doesn't defeat narrowing on
 * the `text`/`data` fields. `type: "text"` uses `text`; `type: "image"` uses
 * `data` + `mimeType`; anything else is carried through as JSON.
 */
export interface McpContentItem {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  [key: string]: unknown;
}

/** Result of a `tools/call` request. */
export interface McpToolCallResult {
  content?: McpContentItem[];
  isError?: boolean;
}

/** Client identity sent in the `initialize` handshake. */
export interface McpClientInfo {
  name: string;
  version: string;
}
