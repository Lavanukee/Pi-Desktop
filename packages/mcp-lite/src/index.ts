/**
 * @pi-desktop/mcp-lite — MCP stdio client, lite proxy mode, and native-mode
 * registrar (workstream W8).
 *
 * The default export of {@link ./extension} is the pi extension factory loaded
 * via `-e`. This barrel re-exports the pieces the desktop app consumes directly
 * (connector registry + detectApps for the gallery, the host, the client).
 */
export const packageName = '@pi-desktop/mcp-lite';

export {
  type CatalogServerEntry,
  type CatalogToolEntry,
  type McpCatalog,
  renderCatalogText,
  toCatalogToolEntry,
} from './catalog';
export {
  type ConnectedServer,
  ConnectorHost,
  type ConnectorHostOptions,
  type ConnectResult,
} from './connector-host';
export {
  type ConnectorSuggestion,
  type DetectAppsEnv,
  detectApps,
  detectedSuggestions,
  KNOWN_CONNECTORS,
  type KnownConnector,
  nodeDetectAppsEnv,
} from './detect-apps';
export {
  activateMcpLite,
  default as mcpLiteExtension,
  type McpLiteActivation,
  type McpLiteOptions,
} from './extension';
export type {
  JsonSchema,
  McpContentItem,
  McpInitializeResult,
  McpPromptDef,
  McpResourceDef,
  McpServerInfo,
  McpToolCallResult,
  McpToolDef,
} from './mcp-types';
export { MCP_PROTOCOL_VERSION } from './mcp-types';
export {
  type McpToolResultDetails,
  PROXY_TOOL_NAMES,
  registerNativeTools,
  registerProxyTools,
} from './pi-tools';
export {
  defaultRegistry,
  defaultRegistryPath,
  loadRegistry,
  type McpMode,
  type McpRegistryConfig,
  type McpServerConfig,
  nodeRegistryIO,
  parseRegistry,
  type RegistryFileIO,
  removeServer,
  saveRegistry,
  serializeRegistry,
  setServerEnabled,
  upsertServer,
} from './registry';
export {
  mcpInputSchemaToTypeBox,
  mcpResultToPiContent,
  oneLineDescription,
  type PiContentItem,
} from './schema';
export {
  type McpChildProcess,
  type McpSpawnFn,
  McpStdioClient,
  type McpStdioClientOptions,
} from './stdio-client';
