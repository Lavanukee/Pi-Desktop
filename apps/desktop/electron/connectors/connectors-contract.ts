/**
 * Connectors IPC contract — the Codex-style connectors gallery reads the catalog
 * + configured registry, runs the /Applications scan for "Recommended for you",
 * and mutates the registry (install / upsert / remove / enable). The main-process
 * handler (./connectors-main.ts) owns `~/.pi/desktop/mcp-connectors.json` via the
 * @pi-desktop/mcp-lite registry helpers.
 *
 * All payload types come from @pi-desktop/mcp-lite as TYPE-ONLY imports, so the
 * renderer/preload never bundle that package's node-touching modules — only the
 * erased shapes cross the boundary. Composed into ../ipc-contract.ts.
 */
import type {
  ConnectorSuggestion,
  KnownConnector,
  McpRegistryConfig,
  McpServerConfig,
} from '@pi-desktop/mcp-lite';

export type ConnectorsInvokeMap = {
  /** The configured registry (mode + servers) plus the full catalog of cards. */
  'connectors:list': {
    request: undefined;
    response: { registry: McpRegistryConfig; catalog: KnownConnector[] };
  };
  /** Run the /Applications scan → recommended (app-mapped, pinned) + detected. */
  'connectors:scan': {
    request: undefined;
    response: { recommended: ConnectorSuggestion[]; detected: ConnectorSuggestion[] };
  };
  /** Add a catalog connector to the registry by id (disabled if it needs config).
   * `error` is set (registry unchanged) when the id is unknown. */
  'connectors:install': {
    request: { id: string };
    response: { registry: McpRegistryConfig; error?: string };
  };
  /** Insert or replace an arbitrary server config (edited card / manual add). */
  'connectors:upsert': {
    request: { server: McpServerConfig };
    response: { registry: McpRegistryConfig };
  };
  /** Remove a configured server by id. */
  'connectors:remove': {
    request: { id: string };
    response: { registry: McpRegistryConfig };
  };
  /** Toggle a configured server's enabled flag. */
  'connectors:set-enabled': {
    request: { id: string; enabled: boolean };
    response: { registry: McpRegistryConfig };
  };
};

export const CONNECTORS_INVOKE_CHANNELS = [
  'connectors:list',
  'connectors:scan',
  'connectors:install',
  'connectors:upsert',
  'connectors:remove',
  'connectors:set-enabled',
] as const satisfies readonly (keyof ConnectorsInvokeMap)[];
