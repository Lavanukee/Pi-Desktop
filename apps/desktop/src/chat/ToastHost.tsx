/**
 * Errors-only toast policy (ported from the event router's notify policy) plus
 * a restart affordance when the pi bridge exits or goes unhealthy. Radix Toast
 * is declarative, so the store's notifications drive `open` directly.
 */
import { Button, Toast, ToastViewport } from '@pi-desktop/ui';
import { restartPi } from '../state/pi-connect';
import { usePiStore } from '../state/pi-slice';

export function ToastHost() {
  const notifications = usePiStore((s) => s.notifications);
  const dismiss = usePiStore((s) => s.dismissNotification);
  const bridgeExited = usePiStore((s) => s.bridgeExited);

  const onRestart = async () => {
    await restartPi({});
    usePiStore.setState({ bridgeExited: null });
  };

  return (
    <>
      {notifications
        .filter((n) => n.level === 'error')
        .map((n) => (
          <Toast
            key={n.id}
            open
            tone="danger"
            title="Error"
            description={n.message}
            duration={6000}
            onOpenChange={(open) => {
              if (!open) dismiss(n.id);
            }}
          />
        ))}

      {bridgeExited !== null ? (
        <Toast
          open
          tone="danger"
          title="Pi stopped"
          description="The agent process exited. Restart to continue this session."
          duration={Number.POSITIVE_INFINITY}
          // The X (RadixToast.Close) fires onOpenChange(false). Without a handler
          // the `open` prop stays true and the toast never closes — clear the
          // bridge-exit status so it dismisses and stays gone until pi exits
          // again (agentStart/restart/bridgeExit are the only re-emitters).
          onOpenChange={(open) => {
            if (!open) usePiStore.setState({ bridgeExited: null });
          }}
          action={
            <Button size="sm" variant="outline" onClick={() => void onRestart()}>
              Restart
            </Button>
          }
        />
      ) : null}

      <ToastViewport />
    </>
  );
}
