import { clsx } from 'clsx';
import type { ReactNode } from 'react';
import { forwardRef, useCallback, useEffect, useRef, useState } from 'react';
import { IconButton, type IconButtonProps } from './button.tsx';
import { IconCheck, IconCopy } from './icons.tsx';

/*
 * Shared copy-feedback (jedd round-5 #21). ONE mechanism behind every copy
 * affordance: clicking copies, the glyph flips to a check for ~2s, then reverts.
 * `useCopyFeedback` is the primitive (CodeBlock's rail + message-actions build on
 * it directly); `CopyButton` is the batteries-included icon button for the app +
 * canvas to standardise on.
 */

/** Default dwell (ms) the copied/check state is shown before reverting. */
export const COPY_FEEDBACK_MS = 2000;

/**
 * Schedule the revert-to-idle callback `timeout` ms out; returns a canceller.
 * Framework-agnostic (the hook's only timing primitive) so the "shows a check
 * for ~2s then reverts" behaviour is unit-testable with fake timers.
 */
export function scheduleCopyReset(onExpire: () => void, timeout = COPY_FEEDBACK_MS): () => void {
  const id = setTimeout(onExpire, timeout);
  return () => clearTimeout(id);
}

export interface UseCopyFeedbackOptions {
  /** ms to hold the copied state before reverting (default {@link COPY_FEEDBACK_MS}). */
  timeout?: number;
  /** Fired with the copied text (only when {@link CopyFeedback.copy} writes it). */
  onCopy?: (text: string) => void;
}

export interface CopyFeedback {
  /** True for `timeout` ms after the last copy — drive the check glyph off this. */
  copied: boolean;
  /**
   * Flip to the copied state. Pass text to also write it to the clipboard;
   * omit it when a caller already performed the copy and only wants the check.
   */
  copy: (text?: string) => void;
  /** Force back to the idle state immediately. */
  reset: () => void;
}

/**
 * Copy-then-check feedback timer. The clipboard write is optional so a host that
 * already copies (the message action bar delegates to its own handler) can still
 * borrow the exact same 2s check animation.
 */
export function useCopyFeedback(options: UseCopyFeedbackOptions = {}): CopyFeedback {
  const { timeout = COPY_FEEDBACK_MS, onCopy } = options;
  const [copied, setCopied] = useState(false);
  const cancel = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => cancel.current?.(), []);

  const copy = useCallback(
    (text?: string) => {
      if (typeof text === 'string') {
        void navigator.clipboard?.writeText(text);
        onCopy?.(text);
      }
      setCopied(true);
      cancel.current?.();
      cancel.current = scheduleCopyReset(() => setCopied(false), timeout);
    },
    [timeout, onCopy],
  );

  const reset = useCallback(() => {
    cancel.current?.();
    setCopied(false);
  }, []);

  return { copied, copy, reset };
}

export interface CopyButtonProps
  extends Omit<IconButtonProps, 'aria-label' | 'children' | 'onCopy' | 'value'> {
  /** Text to copy, or a getter resolved at click time (lazy artifacts). */
  value: string | (() => string);
  /** Hold time (ms) for the check state. */
  timeout?: number;
  onCopy?: (text: string) => void;
  /** Accessible label in the idle / copied states. */
  copyLabel?: string;
  copiedLabel?: string;
  /** Glyph size in px (default 14). */
  iconSize?: number;
  /** Optional trailing text label (icon-only when omitted). */
  children?: ReactNode;
}

/**
 * Icon button that copies {@link CopyButtonProps.value} and shows a check for
 * ~2s. Built on {@link IconButton}, so it inherits the flavor button system.
 */
export const CopyButton = forwardRef<HTMLButtonElement, CopyButtonProps>(function CopyButton(
  {
    value,
    timeout,
    onCopy,
    copyLabel = 'Copy',
    copiedLabel = 'Copied',
    iconSize = 14,
    className,
    variant = 'ghost',
    size = 'sm',
    children,
    onClick,
    ...rest
  },
  ref,
) {
  const { copied, copy } = useCopyFeedback({ timeout, onCopy });
  return (
    <IconButton
      ref={ref}
      variant={variant}
      size={size}
      aria-label={copied ? copiedLabel : copyLabel}
      className={clsx('pd-copy-btn', className)}
      data-copied={copied}
      onClick={(event) => {
        copy(typeof value === 'function' ? value() : value);
        onClick?.(event);
      }}
      {...rest}
    >
      {copied ? <IconCheck size={iconSize} /> : <IconCopy size={iconSize} />}
      {children}
    </IconButton>
  );
});
