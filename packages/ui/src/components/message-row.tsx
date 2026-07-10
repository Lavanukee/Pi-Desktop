import { clsx } from 'clsx';
import type { HTMLAttributes, ReactNode } from 'react';
import { forwardRef } from 'react';

export type ThreadProps = HTMLAttributes<HTMLDivElement>;

/** Thread column — max-width --pd-thread-width (claude 840 / codex 736). */
export const Thread = forwardRef<HTMLDivElement, ThreadProps>(function Thread(
  { className, ...rest },
  ref,
) {
  return <div ref={ref} className={clsx('pd-thread', className)} {...rest} />;
});

export interface MessageRowProps extends HTMLAttributes<HTMLDivElement> {
  kind: 'user' | 'assistant';
  /** Hover-revealed action cluster (copy/edit/retry — codex extras, adopted
   * unconditionally per spec-message-row ADAPTATION). */
  actions?: ReactNode;
}

/**
 * Message row — spec-message-row.md. User bubble is a pure token swap
 * (--pd-user-bubble-*, --pd-radius-bubble); codex right-alignment is the
 * bubbleAlign flavor flag in CSS. Assistant voice rides the response tokens
 * (claude serif 16/1.5 with dark wght-360 drop; codex sans 14/22).
 */
export const MessageRow = forwardRef<HTMLDivElement, MessageRowProps>(function MessageRow(
  { kind, actions, className, children, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      className={clsx('pd-msg', kind === 'user' ? 'pd-msg--user' : 'pd-msg--assistant', className)}
      {...rest}
    >
      {kind === 'user' ? <div className="pd-msg-bubble">{children}</div> : children}
      {actions !== undefined ? <div className="pd-msg-actions">{actions}</div> : null}
    </div>
  );
});
