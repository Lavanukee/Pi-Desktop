/**
 * @pi-desktop/mcp-lite — MCP stdio client, lite proxy mode, and native-mode
 * registrar (workstream W8).
 *
 * The default export of {@link ./extension} is the pi extension factory loaded
 * via `-e`. This barrel re-exports the pieces the desktop app consumes directly
 * (connector registry + detectApps for the gallery, the host, the client).
 */
import mcpLiteDefault from './extension';

export const packageName = '@pi-desktop/mcp-lite';

export {
  type BashCliHandle,
  type BashCliOptions,
  buildDispatcherSource,
  buildPiToolWrapper,
  coerceArgs,
  type DispatcherCommand,
  PI_MCP_CLI_SOCK_ENV,
  PI_MCP_CLI_TOKEN_ENV,
  parseDispatcherArgs,
  registerBashCliTools,
  registerCliTool,
  renderHelp,
} from './bash-cli';
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
  APP_CONNECTOR_MAP,
  type AppConnectorMapping,
  type ConnectorCategory,
  type ConnectorSuggestion,
  connectorNeedsConfig,
  type DetectAppsEnv,
  detectApps,
  detectedSuggestions,
  KNOWN_CONNECTORS,
  KNOWN_CONNECTORS_BY_ID,
  type KnownConnector,
  nodeDetectAppsEnv,
  recommendedConnectors,
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
  asArgs,
  type McpToolResultDetails,
  PROXY_TOOL_NAMES,
  registerNativeTools,
  registerProxyTools,
  runMcpCall,
} from './pi-tools';
export {
  defaultRegistry,
  defaultRegistryPath,
  loadRegistry,
  MCP_MODES,
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

/**
 * The pi `-e` loader activates an extension via its module DEFAULT export, and
 * the desktop resolver (apps/desktop/electron/pi/pi-main.ts) only passes a path
 * whose source matches `/export\s+default/`. A re-export like
 * `export { default } from './extension'` provides the runtime default but does
 * NOT match that probe — so this MUST be a literal `export default` statement.
 */
export default mcpLiteDefault;
