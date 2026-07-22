/**
 * The rectangular "response finished" / "user input needed" popout that floats
 * just to the RIGHT of a chat's sidebar row (jedd's redesign — replaces the old
 * fake "<title> finished" pseudo-row, which read as a phantom chat).
 *
 * It is portalled to <body> and fixed-positioned at the anchor row's rect so it
 * escapes the sidebar's scroll clip and sits over the main content. A countdown
 * fill bar at the bottom shows the auto-dismiss window "filling out"; Dismiss
 * hides it now, View switches to that chat. The colored dot matches the collapsed
 * status dot on the row (green = finished, amber = needs input).
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

export type ChatNoticeKind = 'finished' | 'needs-input';

export interface ChatNotice {
  /** The session this notice is about (its row is the anchor + View target). */
  readonly sessionFile: string;
  readonly title: string;
  readonly kind: ChatNoticeKind;
  /** Timestamp key — a fresh finish restarts the animation. */
  readonly at: number;
}

const LABEL: Record<ChatNoticeKind, string> = {
  finished: 'Response finished',
  'needs-input': 'Needs your input',
};

export function SidebarChatNotice({
  notice,
  anchorEl,
  durationMs,
  onDismiss,
  onView,
}: {
  notice: ChatNotice;
  /** The chat's sidebar row element — the popout pins to its right edge. */
  anchorEl: HTMLElement | null;
  durationMs: number;
  onDismiss: () => void;
  onView: () => void;
}) {
  const [rect, setRect] = useState<DOMRect | null>(() => anchorEl?.getBoundingClientRect() ?? null);

  // Track the row's position (sidebar scroll / window resize can move it during
  // the notice's short life).
  useEffect(() => {
    if (anchorEl === null) return;
    const measure = () => setRect(anchorEl.getBoundingClientRect());
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [anchorEl]);

  // Auto-dismiss when the fill bar completes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-arm on a fresh notice (at)
  useEffect(() => {
    const t = setTimeout(onDismiss, durationMs);
    return () => clearTimeout(t);
  }, [durationMs, onDismiss, notice.at]);

  // Anchor to the row's right edge; fall back to a sensible spot near the top of
  // the content area if the row hasn't mounted (e.g. filtered out of view).
  const top = rect !== null ? rect.top : 96;
  const left = rect !== null ? rect.right + 8 : 300;

  return createPortal(
    <div
      className="pd-chat-notice fixed z-[70]"
      style={{ top, left }}
      data-testid="chat-notice"
      data-kind={notice.kind}
    >
      <div className="flex items-start gap-2 px-3 pt-2.5 pb-2">
        <span className={`pd-chat-dot pd-chat-dot--${notice.kind} mt-1 shrink-0`} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-body text-text-primary">{notice.title}</div>
          <div className="text-footnote text-text-muted">{LABEL[notice.kind]}</div>
        </div>
      </div>
      <div className="flex items-center justify-end gap-1 px-2 pb-2">
        <button
          type="button"
          className="rounded-md px-2 py-1 text-footnote text-text-muted hover:bg-bg-hover"
          onClick={onDismiss}
          data-testid="chat-notice-dismiss"
        >
          Dismiss
        </button>
        <button
          type="button"
          className="rounded-md px-2 py-1 text-footnote text-text-link hover:bg-bg-hover"
          onClick={onView}
          data-testid="chat-notice-view"
        >
          View
        </button>
      </div>
      <div className="pd-chat-notice-track">
        <div
          className={`pd-chat-notice-fill pd-chat-notice-fill--${notice.kind}`}
          style={{ animationDuration: `${durationMs}ms` }}
        />
      </div>
    </div>,
    document.body,
  );
}
