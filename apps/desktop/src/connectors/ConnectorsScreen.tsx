/**
 * The Codex-style connectors gallery — a full-window surface (like Settings)
 * with a Back-to-chat affordance, Plugins / Skills tabs, a "Create ▾" menu, and
 * a search field.
 *
 * The Plugins tab is a 2-column SECTIONED grid — By us / Recommended for you /
 * Official / Popular (see connector-sections.ts) — where each card carries a
 * "+" add button (or a Preinstalled / Installed state). Selecting a card opens a
 * real detail view (its tools + config), not a dead description. "Recommended
 * for you" is driven by the /Applications scan (Blender-installed ⇒ Blender
 * pinned). Search filters within every section.
 *
 * Install / enable / disable / remove round-trip through the connectors:* IPC
 * (which persists ~/.pi/desktop/mcp-connectors.json — the mcp-lite extension
 * re-reads it on the next pi session). The MCP mode control reuses the settings
 * store so lite / native / bash-cli stays single-sourced.
 */
import type { KnownConnector, McpMode } from '@pi-desktop/mcp-lite';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconChevronDown,
  IconChevronLeft,
  IconPlus,
  ScrollArea,
  SearchInput,
  SegmentedControl,
  Tabs,
  TabsList,
  TabsTrigger,
} from '@pi-desktop/ui';
import { useEffect, useMemo, useState } from 'react';
import { installedServer, isEnabled, useConnectorsStore } from '../state/connectors-store';
import { useSettingsStore } from '../state/settings-store';
import { ConnectorCard } from './ConnectorCard';
import { ConnectorDetail } from './ConnectorDetail';
import { ConnectorSection } from './ConnectorSection';
import { ConnectPermissionDialog } from './ConnectPermissionDialog';
import { buildConnectorSections } from './connector-sections';
import { SkillsTab } from './SkillsTab';

/** Renderer-safe mirror of mcp-lite's connectorNeedsConfig (kept local so the
 * renderer never imports the node-touching detect-apps module). */
function needsConfig(connector: KnownConnector): boolean {
  if (connector.requiresEnv !== undefined && connector.requiresEnv.length > 0) return true;
  return (connector.template.args ?? []).some((a) => /<[^>]+>/.test(a));
}

const MODE_OPTIONS: Array<{ value: McpMode; label: string }> = [
  { value: 'lite', label: 'Lite' },
  { value: 'native', label: 'Native' },
  { value: 'bash-cli', label: 'Bash CLI' },
];

/** One-line explanation of each connector run mode, shown under the toggle. */
const MODE_HINTS: Record<McpMode, string> = {
  lite: 'Lite — a compact proxy: tools are summarized and fetched on demand, so many connectors fit in a small context.',
  native:
    'Native — every connector tool is exposed directly to the model. Most capable, but uses more context.',
  'bash-cli':
    'Bash CLI — connectors are driven from the terminal via a discoverable `--help` command surface.',
};

const CREATE_ITEMS = ['Create plugin', 'Add marketplace', 'Record a skill', 'Request a plugin'];

export function ConnectorsScreen({ onClose }: { onClose: () => void }) {
  const registry = useConnectorsStore((s) => s.registry);
  const catalog = useConnectorsStore((s) => s.catalog);
  const recommended = useConnectorsStore((s) => s.recommended);
  const busyId = useConnectorsStore((s) => s.busyId);
  const load = useConnectorsStore((s) => s.load);
  const install = useConnectorsStore((s) => s.install);
  const setEnabled = useConnectorsStore((s) => s.setEnabled);
  const remove = useConnectorsStore((s) => s.remove);

  const mode = useSettingsStore((s) => s.settings.mcpMode);
  const updateSettings = useSettingsStore((s) => s.update);

  const [tab, setTab] = useState<'plugins' | 'skills'>('plugins');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingConnect, setPendingConnect] = useState<KnownConnector | null>(null);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = useMemo(
    () => catalog.find((c) => c.id === selectedId) ?? null,
    [catalog, selectedId],
  );

  // Connect: connectors that need secrets/auth go through the permission popup;
  // plain local ones install straight away.
  const connect = (connector: KnownConnector) => {
    if (needsConfig(connector)) setPendingConnect(connector);
    else void install(connector.id);
  };
  const confirmConnect = (connector: KnownConnector) => {
    setPendingConnect(null);
    void install(connector.id);
  };

  const installedIds = new Set(registry.servers.map((s) => s.id));
  const sections = useMemo(
    () =>
      buildConnectorSections(
        catalog,
        recommended.map((r) => r.id),
        query,
      ),
    [catalog, recommended, query],
  );

  return (
    <div
      className="pd-settings-enter flex h-full flex-col bg-bg-base"
      data-testid="connectors-screen"
    >
      {/* Draggable strip clearing the macOS traffic lights + Back to chat. */}
      <div className="flex h-10 shrink-0 items-center py-0 pr-3 pl-[80px] [-webkit-app-region:drag]">
        <button
          type="button"
          data-testid="connectors-back"
          className="inline-flex items-center gap-1 rounded-lg py-1 pr-2 pl-1 text-footnote text-text-secondary [-webkit-app-region:no-drag] hover:bg-bg-hover"
          onClick={onClose}
        >
          <IconChevronLeft size={14} />
          Back to chat
        </button>
      </div>

      {selected !== null ? (
        <ScrollArea className="min-h-0 flex-1">
          <ConnectorDetail
            connector={selected}
            installed={installedServer(registry, selected.id)}
            busy={busyId === selected.id}
            onBack={() => setSelectedId(null)}
            onConnect={connect}
            onSetEnabled={(id, enabled) => void setEnabled(id, enabled)}
            onRemove={(id) => {
              void remove(id);
              setSelectedId(null);
            }}
          />
        </ScrollArea>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Header: title + Create menu, tabs, then search. */}
          <div className="mx-auto w-full max-w-[880px] px-8 pt-1">
            <div className="mb-1 flex items-center justify-between gap-3">
              <h1 className="text-title text-text-primary">Connectors</h1>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="primary" size="sm" data-testid="connectors-create-menu">
                    <IconPlus size={14} /> Create <IconChevronDown size={14} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {CREATE_ITEMS.map((label) => (
                    <DropdownMenuItem key={label} onSelect={() => undefined}>
                      {label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            <Tabs value={tab} onValueChange={(v) => setTab(v as 'plugins' | 'skills')}>
              <TabsList className="w-fit">
                <TabsTrigger value="plugins" data-testid="connectors-tab-plugins">
                  Plugins
                </TabsTrigger>
                <TabsTrigger value="skills" data-testid="connectors-tab-skills">
                  Skills
                </TabsTrigger>
              </TabsList>
            </Tabs>

            {tab === 'plugins' ? (
              <div className="mt-3">
                <SearchInput
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search connectors"
                  data-testid="connectors-search"
                />
              </div>
            ) : null}
          </div>

          <ScrollArea className="min-h-0 flex-1">
            <div className="mx-auto w-full max-w-[880px] px-8 py-5">
              {tab === 'skills' ? (
                <SkillsTab />
              ) : (
                <div className="flex flex-col gap-6">
                  {/* MCP mode control + a one-line explanation of the active mode. */}
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center gap-2">
                      <span className="text-footnote text-text-muted">How connectors run</span>
                      <SegmentedControl
                        aria-label="MCP mode"
                        data-testid="connectors-mcp-mode"
                        value={mode}
                        onValueChange={(v) => void updateSettings({ mcpMode: v as McpMode })}
                        options={MODE_OPTIONS}
                      />
                    </div>
                    <p
                      className="text-caption text-text-muted leading-relaxed"
                      data-testid="connectors-mode-hint"
                    >
                      {MODE_HINTS[mode]}
                    </p>
                  </div>

                  {/* Sectioned 2-column grid. */}
                  {sections.length === 0 ? (
                    <p className="text-footnote text-text-muted" data-testid="connectors-empty">
                      No connectors match your search.
                    </p>
                  ) : (
                    sections.map((section) => (
                      <ConnectorSection
                        key={section.id}
                        id={section.id}
                        title={section.title}
                        count={section.items.length}
                      >
                        {section.items.map((c) => (
                          <ConnectorCard
                            key={c.id}
                            connector={c}
                            isInstalled={installedIds.has(c.id)}
                            installedEnabled={isEnabled(registry, c.id)}
                            busy={busyId === c.id}
                            onOpen={() => setSelectedId(c.id)}
                            onAdd={() => connect(c)}
                            onRemove={() => void remove(c.id)}
                          />
                        ))}
                      </ConnectorSection>
                    ))
                  )}

                  {/* Trademark disclaimer: the gallery renders third-party brand
                      marks for identification only. */}
                  <footer
                    className="border-border-subtle border-t pt-4 text-caption text-text-muted leading-relaxed"
                    data-testid="connectors-disclaimer"
                  >
                    All third-party product names, logos, and brands are property of their
                    respective owners. All company, product, and service names used in this
                    interface are for identification purposes only. Use of these names, logos, and
                    brands does not imply endorsement.
                  </footer>
                </div>
              )}
            </div>
          </ScrollArea>
        </div>
      )}

      <ConnectPermissionDialog
        connector={pendingConnect}
        onConfirm={confirmConnect}
        onOpenChange={(open) => {
          if (!open) setPendingConnect(null);
        }}
      />
    </div>
  );
}
