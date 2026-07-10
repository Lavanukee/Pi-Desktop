/**
 * A per-connector detail page (visual ref img75): breadcrumb, header with the
 * connect/remove action, description, an "MCP servers N" enable toggle, a
 * "Skills N" toggle (seam for the W6 skills work — 0 for now), and an
 * "Information" block (Developer / Category / Version).
 */
import type { KnownConnector, McpServerConfig } from '@pi-desktop/mcp-lite';
import { Badge, Button, IconChevronRight, Spinner, Switch } from '@pi-desktop/ui';
import { ConnectorIcon } from './ConnectorIcon';

/** Best-effort developer label: the homepage host, else first-party/community. */
function developerOf(connector: KnownConnector): string {
  if (connector.homepage !== undefined) {
    try {
      return new URL(connector.homepage).host.replace(/^www\./, '');
    } catch {
      // fall through
    }
  }
  return connector.official ? 'First-party' : 'Community';
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-border-subtle border-b py-2.5 last:border-b-0">
      <span className="text-body text-text-muted">{label}</span>
      <span className="text-body text-text-primary">{value}</span>
    </div>
  );
}

function ToggleRow({
  label,
  count,
  checked,
  disabled,
  onCheckedChange,
  testid,
}: {
  label: string;
  count: number;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  testid?: string;
}) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-border-default px-4 py-3">
      <span className="text-body text-text-primary">
        {label} <span className="text-text-muted">{count}</span>
      </span>
      <Switch
        aria-label={label}
        data-testid={testid}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
    </div>
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
  const isInstalled = installed !== undefined;
  const enabled = isInstalled && installed.enabled !== false;

  return (
    <div className="mx-auto max-w-[720px] px-8 py-6" data-testid="connector-detail">
      {/* Breadcrumb */}
      <nav
        className="mb-5 flex items-center gap-1 text-footnote text-text-muted"
        data-testid="connector-detail-breadcrumb"
      >
        <button type="button" className="hover:text-text-primary" onClick={onBack}>
          Connectors
        </button>
        <IconChevronRight size={12} />
        <span className="text-text-secondary">{connector.name}</span>
      </nav>

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
          {busy ? (
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

      {/* Server / skills toggles */}
      <div className="mb-6 flex flex-col gap-2">
        <ToggleRow
          label="MCP servers"
          count={1}
          checked={enabled}
          disabled={!isInstalled}
          testid="connector-detail-mcp-toggle"
          onCheckedChange={(v) => onSetEnabled(connector.id, v)}
        />
        {/* Skills seam (W6): no skills bundled with connectors yet. */}
        <ToggleRow label="Skills" count={0} checked={false} disabled />
      </div>

      {/* Information */}
      <section>
        <h2 className="mb-2 font-medium text-body text-text-primary">Information</h2>
        <div className="rounded-xl border border-border-default px-4">
          <InfoRow label="Developer" value={developerOf(connector)} />
          <InfoRow label="Category" value={connector.category} />
          <InfoRow label="Version" value="latest" />
        </div>
      </section>
    </div>
  );
}
