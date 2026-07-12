/**
 * Renderer connectors state for the Codex-style connectors gallery. Mirrors the
 * main-process `~/.pi/desktop/mcp-connectors.json` registry (via the connectors:*
 * IPC), the full connector catalog, and the /Applications scan that powers
 * "Recommended for you". Mutations (install / enable / disable / remove) round-
 * trip through IPC and adopt the returned registry so the screen stays in sync.
 *
 * The MCP mode (lite / native / bash-cli) is NOT owned here — it lives in the
 * settings store (settings.json + the registry `mode`), so the screen's mode
 * control reuses that path and this store stays purely about servers.
 */
import type {
  ConnectorSuggestion,
  KnownConnector,
  McpRegistryConfig,
  McpServerConfig,
} from '@pi-desktop/mcp-lite';
import { create } from 'zustand';

interface ConnectorsStoreState {
  registry: McpRegistryConfig;
  catalog: KnownConnector[];
  recommended: ConnectorSuggestion[];
  detected: ConnectorSuggestion[];
  loaded: boolean;
  busyId: string | null;
  /** Load catalog + registry + run the /Applications scan. */
  load: () => Promise<void>;
  /** Re-run only the /Applications scan (recommended/detected). */
  rescan: () => Promise<void>;
  /** Add a catalog connector by id (disabled if it needs config). */
  install: (id: string) => Promise<void>;
  /** Remove a configured server by id. */
  remove: (id: string) => Promise<void>;
  /** Enable/disable a configured server by id. */
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  /** Insert or replace an arbitrary server config. */
  upsert: (server: McpServerConfig) => Promise<void>;
  /** Live tool discovery for the detail view (installed + enabled MCP only). */
  fetchTools: (id: string) => Promise<{ tools: ConnectorTool[]; error?: string }>;
}

/** A tool as shown in the detail view (name + one-line description, no schema). */
export interface ConnectorTool {
  name: string;
  description: string;
}

const EMPTY_REGISTRY: McpRegistryConfig = { version: 1, mode: 'lite', servers: [] };

export const useConnectorsStore = create<ConnectorsStoreState>((set) => ({
  registry: EMPTY_REGISTRY,
  catalog: [],
  recommended: [],
  detected: [],
  loaded: false,
  busyId: null,

  load: async () => {
    const [list, scan] = await Promise.all([
      window.piDesktop.invoke('connectors:list', undefined),
      window.piDesktop.invoke('connectors:scan', undefined),
    ]);
    set({
      registry: list.registry,
      catalog: list.catalog,
      recommended: scan.recommended,
      detected: scan.detected,
      loaded: true,
    });
  },

  rescan: async () => {
    const scan = await window.piDesktop.invoke('connectors:scan', undefined);
    set({ recommended: scan.recommended, detected: scan.detected });
  },

  install: async (id) => {
    set({ busyId: id });
    try {
      const { registry } = await window.piDesktop.invoke('connectors:install', { id });
      set({ registry });
    } finally {
      set({ busyId: null });
    }
  },

  remove: async (id) => {
    set({ busyId: id });
    try {
      const { registry } = await window.piDesktop.invoke('connectors:remove', { id });
      set({ registry });
    } finally {
      set({ busyId: null });
    }
  },

  setEnabled: async (id, enabled) => {
    set({ busyId: id });
    try {
      const { registry } = await window.piDesktop.invoke('connectors:set-enabled', { id, enabled });
      set({ registry });
    } finally {
      set({ busyId: null });
    }
  },

  upsert: async (server) => {
    set({ busyId: server.id });
    try {
      const { registry } = await window.piDesktop.invoke('connectors:upsert', { server });
      set({ registry });
    } finally {
      set({ busyId: null });
    }
  },

  fetchTools: async (id) => {
    // Read-only probe — no busy/registry mutation. The detail view owns the
    // loading spinner and falls back to the static config on `error`.
    return window.piDesktop.invoke('connectors:tools', { id });
  },
}));

/** The configured server for a catalog id, if it has been installed. */
export function installedServer(
  registry: McpRegistryConfig,
  id: string,
): McpServerConfig | undefined {
  return registry.servers.find((s) => s.id === id);
}

/** Whether a connector id is installed AND enabled (default true). */
export function isEnabled(registry: McpRegistryConfig, id: string): boolean {
  const server = installedServer(registry, id);
  return server !== undefined && server.enabled !== false;
}
