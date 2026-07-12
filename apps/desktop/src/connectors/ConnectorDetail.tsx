/**
 * A per-connector detail page that shows what the connector actually IS — not
 * the old dead description. It renders, by kind:
 *
 *   - Builtins (HyperFrames / Video editing): their static tool list directly
 *     (no spawn) — the "real content" for a bundled tool.
 *   - MCP connectors, Tier 1 (always ships): the real launch command + required
 *     secrets in a CodeBlock, plus any static tool list — so the user sees what
 *     it runs and what it needs even before adding it.
 *   - MCP connectors, Tier 2 (installed + enabled): a LIVE tool list fetched via
 *     connectors:tools (spawn once, list, tear down), with a Spinner while
 *     connecting and a graceful fall-back to Tier 1 on any error.
 *
 * Header + Connect/Remove + the MCP-server enable toggle stay; the back
 * affordance is a restyled pill (matches the screen's Back button). The old
 * hard-coded "Version: latest" / "Skills 0" rows are gone.
 */
import type { KnownConnector, McpServerConfig } from '@pi-desktop/mcp-lite';
import {
  Badge,
  Button,
  CodeBlock,
  IconChevronLeft,
  IconExternal,
  Spinner,
  Switch,
} from '@pi-desktop/ui';
import { useEffect, useState } from 'react';
import { type ConnectorTool, useConnectorsStore } from '../state/connectors-store';
import { ConnectorIcon } from './ConnectorIcon';

/** Best-effort developer label: the homepage host, else community. */
function developerOf(connector: KnownConnector): string {
  if (connector.homepage !== undefined) {
    try {
      return new URL(connector.homepage).host.replace(/^www\./, '');
    } catch {
      // fall through
    }
  }
  return connector.official ? 'Official' : 'Community';
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-border-subtle border-b py-2.5 last:border-b-0">
      <span className="text-body text-text-muted">{label}</span>
      <span className="truncate text-body text-text-primary">{value}</span>
    </div>
  );
}

function ToolList({ tools }: { tools: ReadonlyArray<ConnectorTool> }) {
  return (
    <ul className="flex flex-col gap-2" data-testid="connector-detail-tools">
      {tools.map((t) => (
        <li key={t.name} className="rounded-xl border border-border-default px-4 py-3">
          <code className="text-footnote text-text-primary">{t.name}</code>
          <p className="mt-0.5 text-footnote text-text-muted">{t.description}</p>
        </li>
      ))}
    </ul>
  );
}

export function ConnectorDetail({
  connector,
  installed,
  busy,
  onBack,
  onConnect,
  onSetEnabled,
  onRemove,
}: {
  connector: KnownConnector;
  installed: McpServerConfig | undefined;
  busy: boolean;
  onBack: () => void;
  onConnect: (connector: KnownConnector) => void;
  onSetEnabled: (id: string, enabled: boolean) => void;
  onRemove: (id: string) => void;
}) {
  const fetchTools = useConnectorsStore((s) => s.fetchTools);

  const isBuiltin = connector.kind === 'builtin';
  const isInstalled = installed !== undefined;
  const enabled = isInstalled && installed.enabled !== false;

  const staticTools: ReadonlyArray<ConnectorTool> = connector.tools ?? [];
  const launch = [connector.template.command, ...(connector.template.args ?? [])].join(' ').trim();
  const requiresEnv = connector.requiresEnv ?? [];

  // Tier 2: live tools for an installed + enabled MCP connector only.
  const canFetchLive = !isBuiltin && isInstalled && enabled;
  const [live, setLive] = useState<{ loading: boolean; tools: ConnectorTool[]; error?: string }>({
    loading: false,
    tools: [],
  });

  useEffect(() => {
    if (!canFetchLive) {
      setLive({ loading: false, tools: [] });
      return;
    }
    let cancelled = false;
    setLive({ loading: true, tools: [] });
    void fetchTools(connector.id).then((res) => {
      if (cancelled) return;
      setLive({ loading: false, tools: res.tools, error: res.error });
    });
    return () => {
      cancelled = true;
    };
  }, [canFetchLive, connector.id, fetchTools]);

  // Prefer the live list when we have one; otherwise the static list.
  const displayTools = live.tools.length > 0 ? live.tools : staticTools;

  return (
    <div className="mx-auto max-w-[720px] px-8 py-6" data-testid="connector-detail">
      {/* Back affordance (matches the screen's Back button). */}
      <button
        type="button"
        onClick={onBack}
        data-testid="connector-detail-breadcrumb"
        className="mb-5 inline-flex items-center gap-1 rounded-lg py-1 pr-2 pl-1 text-footnote text-text-secondary hover:bg-bg-hover"
      >
        <IconChevronLeft size={14} />
        Connectors
      </button>

      {/* Header */}
      <div className="mb-4 flex items-start gap-4">
        <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-bg-inset text-title text-text-primary">
          <ConnectorIcon connector={connector} size={30} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="text-heading text-text-primary">{connector.name}</h1>
            {connector.official ? <Badge tone="info">Official</Badge> : null}
          </div>
          <p className="mt-1 text-body text-text-muted">{connector.description}</p>
        </div>
        <div className="shrink-0">
          {isBuiltin ? (
            <Badge tone="success" data-testid="connector-detail-preinstalled">
              Preinstalled
            </Badge>
          ) : busy ? (
            <Spinner size={16} />
          ) : isInstalled ? (
            <Button
              variant="outline"
              data-testid="connector-detail-remove"
              onClick={() => onRemove(connector.id)}
            >
              Remove
            </Button>
          ) : (
            <Button
              variant="primary"
              data-testid="connector-detail-connect"
              onClick={() => onConnect(connector)}
            >
              Connect
            </Button>
          )}
        </div>
      </div>

      {/* MCP-server enable toggle (not for builtins — always on). */}
      {!isBuiltin ? (
        <div className="mb-6 flex items-center justify-between rounded-xl border border-border-default px-4 py-3">
          <span className="text-body text-text-primary">MCP server</span>
          <Switch
            aria-label="MCP server"
            data-testid="connector-detail-mcp-toggle"
            checked={enabled}
            disabled={!isInstalled}
            onCheckedChange={(v) => onSetEnabled(connector.id, v)}
          />
        </div>
      ) : null}

      {/* Tools — the real content. */}
      <section className="mb-6">
        <h2 className="mb-2 flex items-center gap-2 font-medium text-body text-text-primary">
          Tools
          {displayTools.length > 0 ? (
            <span className="text-text-muted">{displayTools.length}</span>
          ) : null}
        </h2>
        {live.loading ? (
          <div className="flex items-center gap-2 text-footnote text-text-muted">
            <Spinner size={16} /> Connecting to list tools…
          </div>
        ) : displayTools.length > 0 ? (
          <ToolList tools={displayTools} />
        ) : (
          <p className="text-footnote text-text-muted">
            {isBuiltin || isInstalled
              ? 'This connector exposes no tools.'
              : 'Add this connector to discover its tools.'}
          </p>
        )}
      </section>

      {/* How it runs — MCP config (Tier 1). Never for builtins. */}
      {!isBuiltin && launch.length > 0 ? (
        <section className="mb-6">
          <h2 className="mb-2 font-medium text-body text-text-primary">How it runs</h2>
          <CodeBlock code={launch} language="shell" data-testid="connector-detail-command" />
          {requiresEnv.length > 0 ? (
            <p
              className="mt-2 text-footnote text-text-muted"
              data-testid="connector-detail-requires"
            >
              Requires <code className="text-text-secondary">{requiresEnv.join(', ')}</code>
            </p>
          ) : null}
        </section>
      ) : null}

      {/* Information */}
      <section>
        <h2 className="mb-2 font-medium text-body text-text-primary">Information</h2>
        <div className="rounded-xl border border-border-default px-4">
          <InfoRow label="Developer" value={developerOf(connector)} />
          <InfoRow label="Category" value={connector.category} />
          {isBuiltin ? (
            <InfoRow label="Type" value="Built-in (preinstalled)" />
          ) : (
            <InfoRow label="Transport" value={`stdio · ${connector.template.command}`} />
          )}
        </div>
        {connector.homepage !== undefined ? (
          <a
            href={connector.homepage}
            target="_blank"
            rel="noreferrer"
            className="mt-3 inline-flex items-center gap-1.5 text-footnote text-text-link hover:underline"
          >
            <IconExternal size={13} /> {developerOf(connector)}
          </a>
        ) : null}
      </section>
    </div>
  );
}
