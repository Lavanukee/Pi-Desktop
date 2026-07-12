/**
 * One connector card in the 2-column sectioned gallery (replaces the old
 * full-width ConnectorRow). The whole icon + name + description is an "open
 * details" button; the top-right corner carries the action affordance:
 *
 *   - builtin (preinstalled) → a static "Preinstalled" badge (never a "+")
 *   - installed              → an Installed / Disabled badge
 *   - otherwise              → a "+" IconButton (add), testid connector-add-<id>
 *   - busy                   → a Spinner
 *
 * plus the "…" overflow (View details / Remove). Layout rhythm is owner-
 * validated (FEEL); the states + testids are the fleet-tested contract.
 */
import type { KnownConnector } from '@pi-desktop/mcp-lite';
import {
  Badge,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  IconMore,
  IconPlus,
  Spinner,
} from '@pi-desktop/ui';
import { ConnectorIcon } from './ConnectorIcon';

export function ConnectorCard({
  connector,
  isInstalled,
  installedEnabled,
  busy,
  onOpen,
  onAdd,
  onRemove,
}: {
  connector: KnownConnector;
  isInstalled: boolean;
  installedEnabled: boolean;
  busy: boolean;
  onOpen: () => void;
  onAdd: () => void;
  onRemove: () => void;
}) {
  const isBuiltin = connector.kind === 'builtin';

  return (
    <div
      className="relative flex flex-col rounded-xl border border-border-default p-4 hover:bg-bg-hover"
      data-testid={`connector-card-${connector.id}`}
    >
      {/* Action corner. */}
      <div className="absolute top-3 right-3 flex items-center gap-1">
        {busy ? (
          <Spinner size={16} />
        ) : isBuiltin ? (
          <Badge tone="success" data-testid={`connector-preinstalled-${connector.id}`}>
            Preinstalled
          </Badge>
        ) : isInstalled ? (
          <Badge tone={installedEnabled ? 'success' : 'default'}>
            {installedEnabled ? 'Installed' : 'Disabled'}
          </Badge>
        ) : (
          <IconButton
            aria-label={`Add ${connector.name}`}
            data-testid={`connector-add-${connector.id}`}
            onClick={onAdd}
          >
            <IconPlus size={16} />
          </IconButton>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton aria-label="More" data-testid={`connector-overflow-${connector.id}`}>
              <IconMore size={16} />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onOpen}>View details</DropdownMenuItem>
            {isInstalled && !isBuiltin ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onRemove}>Remove</DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Icon + name + description — the open-details affordance. */}
      <button type="button" className="flex flex-col gap-2 pr-16 text-left" onClick={onOpen}>
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-bg-inset text-heading text-text-primary">
          <ConnectorIcon connector={connector} size={22} />
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-body text-text-primary">{connector.name}</span>
            {connector.official ? <Badge tone="info">Official</Badge> : null}
          </span>
          <span className="line-clamp-2 min-h-8 text-footnote text-text-muted">
            {connector.description}
          </span>
        </span>
      </button>
    </div>
  );
}
