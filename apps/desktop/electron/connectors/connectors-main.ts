/**
 * Main-process connectors handlers. Owns `~/.pi/desktop/mcp-connectors.json`
 * through the @pi-desktop/mcp-lite registry helpers (the SAME file the mcp-lite
 * pi extension reads at activation), so an install/enable/disable persists and
 * the next pi session (or a session reload) picks up the change — the
 * ConnectorHost lives inside the pi child and re-reads the registry on spawn.
 *
 * The registry `mode` field is preserved on every mutation; mode changes flow
 * through the settings surface (settings:set → applyMcpMode), keeping the two
 * files coherent. Trusted-sender gated like the other app channels.
 */
import * as os from 'node:os';
import {
  connectorNeedsConfig,
  type DetectAppsEnv,
  defaultRegistryPath,
  detectedSuggestions,
  KNOWN_CONNECTORS,
  KNOWN_CONNECTORS_BY_ID,
  loadRegistry,
  type McpRegistryConfig,
  type McpServerConfig,
  nodeDetectAppsEnv,
  nodeRegistryIO,
  recommendedConnectors,
  removeServer,
  saveRegistry,
  setServerEnabled,
  upsertServer,
} from '@pi-desktop/mcp-lite';
import { createLogger, type IpcHandlers, registerIpcHandlers } from '@pi-desktop/shared';
import type { IpcMain } from 'electron';
import type { ConnectorsInvokeMap } from './connectors-contract';

const log = createLogger('desktop:connectors');
const REGISTRY_PATH = defaultRegistryPath(os.homedir());

function read(): McpRegistryConfig {
  return loadRegistry(REGISTRY_PATH, nodeRegistryIO);
}

function write(config: McpRegistryConfig): McpRegistryConfig {
  saveRegistry(REGISTRY_PATH, config, nodeRegistryIO);
  return config;
}

/**
 * The scan surface. Production scans /Applications; under E2E/tests a fixture
 * dir (`PI_CONNECTORS_APPS_DIR`) makes "Recommended for you" deterministic — its
 * process list is emptied so only the fixture's `.app` names drive suggestions.
 */
function scanEnv(): DetectAppsEnv {
  const fixtureDir = process.env.PI_CONNECTORS_APPS_DIR;
  if (fixtureDir !== undefined && fixtureDir !== '') {
    return { ...nodeDetectAppsEnv(fixtureDir), listProcesses: () => [] };
  }
  return nodeDetectAppsEnv();
}

const handlers: IpcHandlers<ConnectorsInvokeMap> = {
  'connectors:list': () => ({ registry: read(), catalog: KNOWN_CONNECTORS }),

  'connectors:scan': () => {
    const env = scanEnv();
    return { recommended: recommendedConnectors(env), detected: detectedSuggestions(env) };
  },

  'connectors:install': (req) => {
    const connector = KNOWN_CONNECTORS_BY_ID[req.id];
    if (connector === undefined) {
      return { registry: read(), error: `Unknown connector "${req.id}"` };
    }
    // Never preload-enable anything needing secrets/auth or a <placeholder> arg;
    // it lands disabled until the user configures it.
    const enabled = !connectorNeedsConfig(connector);
    const server: McpServerConfig = { ...connector.template, enabled };
    const next = write(upsertServer(read(), server));
    log.info('connector installed', { id: req.id, enabled });
    return { registry: next };
  },

  'connectors:upsert': (req) => ({ registry: write(upsertServer(read(), req.server)) }),

  'connectors:remove': (req) => ({ registry: write(removeServer(read(), req.id)) }),

  'connectors:set-enabled': (req) => ({
    registry: write(setServerEnabled(read(), req.id, req.enabled)),
  }),
};

export function registerConnectorsIpc(
  ipcMain: IpcMain,
  allowSender: (event: unknown) => boolean,
): void {
  registerIpcHandlers<ConnectorsInvokeMap>(ipcMain, handlers, { allowSender });
}
