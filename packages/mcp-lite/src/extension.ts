/**
 * MCP-lite pi extension entry.
 *
 * Default export is the pi extension factory: it reads the connector registry,
 * connects the enabled servers, and registers their tools in the configured
 * mode (lite proxy by default, native as a per-server / global override).
 *
 * Load path (temp-install for one run, no ~/.pi pollution):
 *   pi -e /abs/path/packages/mcp-lite/src/extension.ts
 * The desktop app spawns pi with this file passed as a repeated `-e` flag.
 *
 * Config path resolution: options.configPath → $PI_DESKTOP_MCP_CONFIG →
 * ~/.pi/desktop/mcp-connectors.json.
 */
import * as os from 'node:os';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { type BashCliHandle, type BashCliOptions, registerBashCliTools } from './bash-cli';
import { ConnectorHost } from './connector-host';
import { registerNativeTools, registerProxyTools } from './pi-tools';
import {
  defaultRegistryPath,
  loadRegistry,
  type McpRegistryConfig,
  nodeRegistryIO,
  type RegistryFileIO,
} from './registry';

export interface McpLiteOptions {
  /** Explicit config path (overrides env + default). */
  configPath?: string;
  /** Injected registry IO (tests). */
  io?: RegistryFileIO;
  /** Injected host (tests). */
  host?: ConnectorHost;
  /** Home dir for the default config path. Defaults to os.homedir(). */
  homedir?: string;
  /** Injected bash-cli bridge options (tests: explicit shimDir/env/socket). */
  bashCli?: BashCliOptions;
}

export interface McpLiteActivation {
  host: ConnectorHost;
  registry: McpRegistryConfig;
  configPath: string;
  /** Per-server one-line status, for the `/mcp` command + logs. */
  summary: string[];
  /** Whether the lite proxy tools were registered. */
  proxyRegistered: boolean;
  /** The live bash-cli bridge (shim dir + socket), or null when not in that mode. */
  bashCli: BashCliHandle | null;
}

/**
 * Wire the extension. Exposed separately from the default export so it can be
 * driven with injected IO/host in unit tests without a real pi runtime.
 */
export async function activateMcpLite(
  pi: ExtensionAPI,
  options: McpLiteOptions = {},
): Promise<McpLiteActivation> {
  const home = options.homedir ?? os.homedir();
  const configPath =
    options.configPath ?? process.env.PI_DESKTOP_MCP_CONFIG ?? defaultRegistryPath(home);
  const io = options.io ?? nodeRegistryIO;
  const registry = loadRegistry(configPath, io);
  const host = options.host ?? new ConnectorHost();

  const enabled = registry.servers.filter((s) => s.enabled !== false);
  const summary: string[] = [];
  let proxyRegistered = false;
  let bashCli: BashCliHandle | null = null;

  if (enabled.length > 0) {
    await host.connectAll(enabled);

    // Register the shared lite proxy tools once if any enabled server uses lite
    // mode — even servers that failed to connect appear in mcp_list as errored.
    const anyLite = enabled.some((s) => (s.mode ?? registry.mode) === 'lite');
    if (anyLite) {
      registerProxyTools(pi, host);
      proxyRegistered = true;
    }

    // bash-cli mode: install the pi-tool shim + socket bridge once, exposing the
    // whole host through the real bash tool (plus the `cli` fallback). It routes
    // to every connected server, so a single bridge serves all bash-cli servers.
    const anyBashCli = enabled.some((s) => (s.mode ?? registry.mode) === 'bash-cli');
    if (anyBashCli) {
      bashCli = registerBashCliTools(pi, host, options.bashCli);
    }

    for (const server of host.getConnected()) {
      const mode = server.config.mode ?? registry.mode;
      if (mode === 'native') {
        const names = registerNativeTools(pi, host, server);
        summary.push(`${server.config.id}: native — ${names.length} tool(s)`);
      } else if (mode === 'bash-cli') {
        summary.push(`${server.config.id}: bash-cli — ${server.tools.length} tool(s) via pi-tool`);
      } else {
        summary.push(`${server.config.id}: lite — ${server.tools.length} tool(s) via mcp_call`);
      }
    }
    for (const server of host.getCatalog()) {
      if (server.status !== 'connected') {
        summary.push(`${server.id}: ${server.status}${server.error ? ` — ${server.error}` : ''}`);
      }
    }
  }

  pi.registerCommand('mcp', {
    description: 'Show MCP connector status and registered tools.',
    handler: async (_args, ctx) => {
      const header = `MCP connectors (config: ${configPath})`;
      if (summary.length === 0) {
        ctx.ui.notify(
          `${header}\n  No connectors configured or enabled.\n` +
            '  Add servers to the config file, then /reload.',
        );
        return;
      }
      const surfaces: string[] = [];
      if (proxyRegistered) surfaces.push('lite proxy tools: mcp_list, mcp_schema, mcp_call');
      if (bashCli !== null) surfaces.push('bash-cli: `pi-tool` on PATH (+ `cli` tool)');
      if (surfaces.length === 0) surfaces.push('native tools registered');
      ctx.ui.notify(
        `${header}\n  ${surfaces.join('\n  ')}\n${summary.map((l) => `  • ${l}`).join('\n')}`,
      );
    },
  });

  pi.on('session_shutdown', () => {
    host.disposeAll();
    bashCli?.dispose();
  });

  return { host, registry, configPath, summary, proxyRegistered, bashCli };
}

/** pi extension factory (default export loaded via `-e`). */
export default function mcpLiteExtension(pi: ExtensionAPI): Promise<void> {
  return activateMcpLite(pi).then(() => undefined);
}
