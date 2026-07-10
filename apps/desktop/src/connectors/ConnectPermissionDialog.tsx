/**
 * The "Connect app" permission popup (visual ref img74). Shown before connecting
 * a connector that shares data / needs auth: an app-icon pair, the "You're in
 * control" reassurances + the elevated-risk warning, and a primary
 * "Continue to <App>" that confirms the connect.
 */
import type { KnownConnector } from '@pi-desktop/mcp-lite';
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  IconCheck,
  IconInfo,
} from '@pi-desktop/ui';

function Reassurance({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="mt-0.5 shrink-0 text-text-muted">
        <IconCheck size={16} />
      </span>
      <div className="min-w-0">
        <div className="text-body text-text-primary">{title}</div>
        <div className="text-footnote text-text-muted">{body}</div>
      </div>
    </div>
  );
}

export function ConnectPermissionDialog({
  connector,
  onConfirm,
  onOpenChange,
}: {
  /** The connector being connected, or null when the dialog is closed. */
  connector: KnownConnector | null;
  onConfirm: (connector: KnownConnector) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const open = connector !== null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {connector !== null ? (
        <DialogContent data-testid="connect-permission-dialog" className="max-w-[440px]">
          <DialogHeader>
            <div className="flex flex-col items-center gap-3 pt-1 text-center">
              {/* App icon pair: Pi ⇄ the connector. */}
              <div className="flex items-center gap-3">
                <span
                  className="flex h-12 w-12 items-center justify-center rounded-2xl bg-bg-inset text-heading text-text-primary"
                  aria-hidden
                >
                  P
                </span>
                <span className="text-text-muted" aria-hidden>
                  ⇄
                </span>
                <span
                  className="flex h-12 w-12 items-center justify-center rounded-2xl bg-bg-inset text-heading"
                  aria-hidden
                >
                  {connector.icon}
                </span>
              </div>
              <DialogTitle>Connect {connector.name}</DialogTitle>
            </div>
          </DialogHeader>

          <DialogBody>
            <div className="flex flex-col gap-3">
              <Reassurance
                title="You're in control"
                body={`Pi only shares what you ask it to with ${connector.name}.`}
              />
              <Reassurance
                title="Data is shared with this app"
                body={`Messages and files you use with ${connector.name} are sent to it.`}
              />
              <div className="flex items-start gap-2.5">
                <span className="mt-0.5 shrink-0 text-text-warning">
                  <IconInfo size={16} />
                </span>
                <div className="min-w-0">
                  <div className="text-body text-text-primary">
                    Apps may introduce elevated risk
                  </div>
                  <div className="text-footnote text-text-muted">
                    Only connect apps you trust. Review the permissions it requests.
                  </div>
                </div>
              </div>
            </div>
          </DialogBody>

          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              data-testid="connect-continue"
              onClick={() => onConfirm(connector)}
            >
              Continue to {connector.name}
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
