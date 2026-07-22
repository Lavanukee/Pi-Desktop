/**
 * "Why isn't my message sending?" — the high-quality explainer jedd asked for.
 * Opened by the blue link under a queued message (ChatThread). It explains the
 * concrete constraint (one reply at a time, one model at a time, or not enough
 * memory) using the queued send's reason snapshot, then lists the chats currently
 * occupying the local model — each with Pause and Stop so the user can free it and
 * let their message through right there, without hunting for the running chat.
 *
 * Rows are rendered custom (not the sidebar's `SidebarRow`, which is a <button>)
 * so the Pause/Stop controls nest cleanly AND stay visible rather than hover-only
 * — in a modal the whole point is that they're right there to click.
 */
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Spinner,
} from '@pi-desktop/ui';
import { IconPause, IconStop } from '../settings/icons';
import { pausePi, stopRunningForQueue } from '../state/pi-connect';
import { usePiStore } from '../state/pi-slice';
import { type RunningChat, useQueueExplainer, useRunningChats } from '../state/running-chats';
import { queueExplainer } from './queue-explainer';

/** Model + live-phase line under a running chat's title. */
function runningMetaText(chat: RunningChat): string {
  const parts: string[] = [];
  if (chat.modelName !== null && chat.modelName.length > 0) parts.push(chat.modelName);
  parts.push(
    chat.status === 'prefilling'
      ? chat.prefillPct !== null
        ? `${Math.round(chat.prefillPct)}% processing`
        : 'processing'
      : 'generating',
  );
  return parts.join(' · ');
}

function RunningChatRow({
  chat,
  onPause,
  onStop,
}: {
  chat: RunningChat;
  onPause: (chat: RunningChat) => void;
  onStop: (chat: RunningChat) => void;
}) {
  return (
    <div
      className="flex items-center gap-2.5 rounded-md border border-border-subtle bg-surface-raised px-2.5 py-2"
      data-testid="modal-running-chat"
    >
      <Spinner size={16} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-body">{chat.title}</span>
        <span className="truncate text-footnote text-text-muted">{runningMetaText(chat)}</span>
      </div>
      <Button size="sm" variant="ghost" onClick={() => onPause(chat)} data-testid="modal-pause">
        <IconPause size={13} /> Pause
      </Button>
      <Button size="sm" variant="danger" onClick={() => onStop(chat)} data-testid="modal-stop">
        <IconStop size={13} /> Stop
      </Button>
    </div>
  );
}

export function WhyQueuedModal() {
  const open = useQueueExplainer((s) => s.open);
  const setOpen = useQueueExplainer((s) => s.setOpen);
  const running = useRunningChats();
  // The blurb keys off WHY the head queued message is waiting (its captured reason).
  const firstReason = usePiStore((s) => s.queuedSends[0]?.reason);
  const explainer = queueExplainer(firstReason);

  // The listed chat IS pi's current turn (whether it's the viewed chat or one
  // running in the background), so Pause/Stop map straight to the single child's
  // controls. Stop KEEPS the queue so the user's waiting message goes through
  // (that's the whole point of stopping the running chat here); Pause keeps it too.
  const pause = (_chat: RunningChat): void => {
    void pausePi();
    setOpen(false);
  };
  const stop = (_chat: RunningChat): void => {
    void stopRunningForQueue();
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent data-testid="why-queued-modal" className="max-w-[460px]">
        <DialogHeader>
          <DialogTitle>Why isn't my message sending?</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <p className="text-body text-text-secondary">{explainer.blurb}</p>
              <p className="text-footnote text-text-muted">{explainer.hint}</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-footnote font-medium text-text-muted">Running now</span>
              {running.length === 0 ? (
                <p className="text-footnote text-text-muted">
                  Nothing is running right now — your message should send momentarily.
                </p>
              ) : (
                running.map((chat) => (
                  <RunningChatRow
                    key={chat.sessionFile ?? 'active'}
                    chat={chat}
                    onPause={pause}
                    onStop={stop}
                  />
                ))
              )}
            </div>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
