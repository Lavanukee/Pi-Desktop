/**
 * The Codex-style connectors gallery (visual refs img73–75). A full-window
 * surface (like Settings) with:
 *   - Plugins / Skills tabs (Plugins built fully; Skills left as a clean seam
 *     for the parallel W6 skills work — a minimal "no skills yet" placeholder),
 *   - a "Create ▾" menu (stubs), a search field,
 *   - an Installed icon row, a Public / Personal scope toggle,
 *   - "Recommended for you" (from the /Applications scan — Blender-installed ⇒
 *     Blender pinned top), and a "Featured" list with Install + "…" overflow,
 *   - a per-connector detail page and a Connect-app permission popup.
 *
 * Install / enable / disable / remove round-trip through the connectors:* IPC
 * (which persists ~/.pi/desktop/mcp-connectors.json — the mcp-lite extension
 * re-reads it on the next pi session). The MCP mode control reuses the settings
 * store so lite / native / bash-cli stays single-sourced.
 */
import type { ConnectorSuggestion, KnownConnector, McpMode } from '@pi-desktop/mcp-lite';
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  IconChevronDown,
  IconMore,
  IconPlus,
  ScrollArea,
  SearchInput,
  SegmentedControl,
  Spinner,
  Tabs,
  TabsList,
  TabsTrigger,
} from '@pi-desktop/ui';
import { useEffect, useMemo, useState } from 'react';
import { installedServer, isEnabled, useConnectorsStore } from '../state/connectors-store';
import { useSettingsStore } from '../state/settings-store';
import { ConnectorDetail } from './ConnectorDetail';
import { ConnectPermissionDialog } from './ConnectPermissionDialog';

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

const CREATE_ITEMS = ['Create plugin', 'Add marketplace', 'Record a skill', 'Request a plugin'];

/** One featured connector list row: icon, name/description, Install + overflow. */
function ConnectorRow({
  connector,
  installedEnabled,
  isInstalled,
  busy,
  onOpen,
  onConnect,
  onRemove,
}: {
  connector: KnownConnector;
  installedEnabled: boolean;
  isInstalled: boolean;
  busy: boolean;
  onOpen: () => void;
  onConnect: () => void;
  onRemove: () => void;
}) {
  return (
    <div
      className="flex items-center gap-3 rounded-xl border border-border-default px-4 py-3 hover:bg-bg-hover"
      data-testid={`connector-card-${connector.id}`}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
        onClick={onOpen}
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-bg-inset text-heading">
          {connector.icon}
        </span>
        <span className="min-w-0">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-body text-text-primary">{connector.name}</span>
            {connector.official ? <Badge tone="info">Official</Badge> : null}
          </span>
          <span className="block truncate text-footnote text-text-muted">
            {connector.description}
          </span>
        </span>
      </button>
      <div className="flex shrink-0 items-center gap-1">
        {busy ? (
          <Spinner size={16} />
        ) : isInstalled ? (
          <Badge tone={installedEnabled ? 'success' : 'default'}>
            {installedEnabled ? 'Installed' : 'Disabled'}
          </Badge>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            data-testid={`connector-install-${connector.id}`}
            onClick={onConnect}
          >
            Install
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton aria-label="More" data-testid={`connector-overflow-${connector.id}`}>
              <IconMore size={16} />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onOpen}>View details</DropdownMenuItem>
            {isInstalled ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onRemove}>Remove</DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

/** A compact "Recommended for you" card. */
function RecommendedCard({
  suggestion,
  busy,
  isInstalled,
  onOpen,
  onConnect,
}: {
  suggestion: ConnectorSuggestion;
  busy: boolean;
  isInstalled: boolean;
  onOpen: () => void;
  onConnect: () => void;
}) {
  return (
    <div
      className="flex w-[220px] shrink-0 flex-col gap-2 rounded-xl border border-border-default p-4"
      data-testid={`connectors-recommended-item-${suggestion.id}`}
    >
      <button type="button" className="flex items-center gap-2 text-left" onClick={onOpen}>
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-bg-inset text-body">
          {suggestion.icon}
        </span>
        <span className="min-w-0 truncate text-body text-text-primary">{suggestion.name}</span>
      </button>
      <p className="line-clamp-2 min-h-8 text-footnote text-text-muted">{suggestion.reason}</p>
      {busy ? (
        <Spinner size={16} />
      ) : isInstalled ? (
        <Badge tone="success">Installed</Badge>
      ) : (
        <Button variant="secondary" size="sm" onClick={onConnect}>
          Install
        </Button>
      )}
    </div>
  );
}

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
  const [scope, setScope] = useState<'public' | 'personal'>('public');
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

  const q = query.trim().toLowerCase();
  const matches = (c: KnownConnector) =>
    q.length === 0 ||
    c.name.toLowerCase().includes(q) ||
    c.description.toLowerCase().includes(q) ||
    c.category.includes(q);

  const installedIds = new Set(registry.servers.map((s) => s.id));
  const recommendedIds = new Set(recommended.map((r) => r.id));

  // Featured: the catalog (public) minus what's already pinned in Recommended,
  // or just the installed connectors (personal). Both honor the search query.
  const featuredBase =
    scope === 'personal'
      ? catalog.filter((c) => installedIds.has(c.id))
      : catalog.filter((c) => !recommendedIds.has(c.id));
  const featured = featuredBase.filter(matches);

  const installedConnectors = catalog.filter((c) => installedIds.has(c.id));

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
          className="[-webkit-app-region:no-drag] text-footnote text-text-link"
          onClick={onClose}
        >
          ← Back to chat
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
          {/* Header: tabs + Create menu, then search. */}
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
                <div
                  className="flex flex-col items-center justify-center gap-2 rounded-xl border border-border-default border-dashed py-16 text-center"
                  data-testid="connectors-skills-empty"
                >
                  <p className="text-body text-text-primary">No skills yet</p>
                  <p className="max-w-[320px] text-footnote text-text-muted">
                    Skills let Pi follow a saved playbook. This is coming soon.
                  </p>
                </div>
              ) : (
                <div className="flex flex-col gap-6">
                  {/* MCP mode + scope controls. */}
                  <div className="flex flex-wrap items-center justify-between gap-3">
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
                    <SegmentedControl
                      aria-label="Connector scope"
                      data-testid="connectors-scope-toggle"
                      value={scope}
                      onValueChange={(v) => setScope(v as 'public' | 'personal')}
                      options={[
                        { value: 'public', label: 'Public' },
                        { value: 'personal', label: 'Personal' },
                      ]}
                    />
                  </div>

                  {/* Installed icon row. */}
                  <section>
                    <h2 className="mb-2 text-footnote text-text-muted">Installed</h2>
                    <div className="flex flex-wrap gap-2" data-testid="connectors-installed-row">
                      {installedConnectors.length === 0 ? (
                        <p className="text-footnote text-text-muted">
                          No connectors installed yet.
                        </p>
                      ) : (
                        installedConnectors.map((c) => (
                          <button
                            key={c.id}
                            type="button"
                            title={c.name}
                            data-testid={`connectors-installed-${c.id}`}
                            aria-label={c.name}
                            onClick={() => setSelectedId(c.id)}
                            className="relative flex h-10 w-10 items-center justify-center rounded-xl bg-bg-inset text-heading hover:bg-bg-hover"
                          >
                            {c.icon}
                            {!isEnabled(registry, c.id) ? (
                              <span className="absolute right-0.5 bottom-0.5 h-2 w-2 rounded-full bg-text-muted" />
                            ) : null}
                          </button>
                        ))
                      )}
                    </div>
                  </section>

                  {/* Recommended for you (public scope only). */}
                  {scope === 'public' && recommended.length > 0 ? (
                    <section data-testid="connectors-recommended">
                      <h2 className="mb-2 text-body text-text-primary">Recommended for you</h2>
                      <div className="flex gap-3 overflow-x-auto pb-1">
                        {recommended.map((s) => (
                          <RecommendedCard
                            key={s.id}
                            suggestion={s}
                            busy={busyId === s.id}
                            isInstalled={installedIds.has(s.id)}
                            onOpen={() => setSelectedId(s.id)}
                            onConnect={() => {
                              const c = catalog.find((x) => x.id === s.id);
                              if (c !== undefined) connect(c);
                            }}
                          />
                        ))}
                      </div>
                    </section>
                  ) : null}

                  {/* Featured list. */}
                  <section data-testid="connectors-featured">
                    <h2 className="mb-2 text-body text-text-primary">
                      {scope === 'personal' ? 'Your connectors' : 'Featured'}
                    </h2>
                    <div className="flex flex-col gap-2">
                      {featured.length === 0 ? (
                        <p className="text-footnote text-text-muted">
                          {scope === 'personal'
                            ? 'Install a connector to see it here.'
                            : 'No connectors match your search.'}
                        </p>
                      ) : (
                        featured.map((c) => (
                          <ConnectorRow
                            key={c.id}
                            connector={c}
                            isInstalled={installedIds.has(c.id)}
                            installedEnabled={isEnabled(registry, c.id)}
                            busy={busyId === c.id}
                            onOpen={() => setSelectedId(c.id)}
                            onConnect={() => connect(c)}
                            onRemove={() => void remove(c.id)}
                          />
                        ))
                      )}
                    </div>
                  </section>
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
