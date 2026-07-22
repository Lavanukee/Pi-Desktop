/**
 * Top-of-screen banner shown when a chat running in the BACKGROUND needs the user's
 * input (its ask_user is deferred rather than popped over the chat you're viewing —
 * see UiRequestDialogs + the sink's request tagging). Clicking it swaps to that chat,
 * where the dialog then shows. The chat's sidebar row also carries an orange dot.
 */
import { switchSession } from '../state/pi-connect';
import { usePiStore } from '../state/pi-slice';

export function InputNeededBanner() {
  const viewed = usePiStore((s) => s.session?.sessionFile ?? null);
  const bgTitle = usePiStore((s) => s.bgRun?.title ?? null);
  const bgFile = usePiStore((s) => s.bgRun?.sessionFile ?? null);
  // The first pending request tagged for a chat OTHER than the one being viewed.
  const pendingFile = usePiStore((s) => {
    const req = s.uiRequests.find(
      (r) => r.sessionFile !== undefined && r.sessionFile !== viewed,
    );
    return req?.sessionFile ?? null;
  });

  if (pendingFile === null) return null;
  const title = bgFile === pendingFile && bgTitle !== null && bgTitle.length > 0 ? bgTitle : 'A chat';

  return (
    <div className="pd-input-banner fixed top-3 left-1/2 z-[80] -translate-x-1/2">
      <button
        type="button"
        onClick={() => void switchSession(pendingFile)}
        className="flex items-center gap-2 rounded-full border border-border-subtle bg-surface-raised px-3.5 py-1.5 text-footnote shadow-[0_8px_24px_rgb(0_0_0/0.22)] hover:bg-bg-hover"
        data-testid="input-needed-banner"
      >
        <span className="pd-chat-dot pd-chat-dot--needs-input" />
        <span className="text-text-primary">{title} needs your input</span>
        <span className="text-text-link">Open</span>
      </button>
    </div>
  );
}
