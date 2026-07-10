import { clsx } from 'clsx';
import { Toast as RadixToast } from 'radix-ui';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { forwardRef } from 'react';
import { IconClose } from './icons.tsx';

/**
 * Toast — spec-dialog.md toast section. Enter offset is tokenized (claude
 * slides in on x, codex drops in from -4px with a back-out curve); swipe to
 * dismiss supported via Radix.
 */
export const ToastProvider = RadixToast.Provider;

export const ToastViewport = forwardRef<
  HTMLOListElement,
  ComponentPropsWithoutRef<typeof RadixToast.Viewport>
>(function ToastViewport({ className, ...rest }, ref) {
  return (
    <RadixToast.Viewport ref={ref} className={clsx('pd-toast-viewport', className)} {...rest} />
  );
});

export type ToastTone = 'default' | 'info' | 'success' | 'warning' | 'danger';

export interface ToastProps
  extends Omit<ComponentPropsWithoutRef<typeof RadixToast.Root>, 'title'> {
  tone?: ToastTone;
  title?: ReactNode;
  description?: ReactNode;
  /** Trailing action slot (RadixToast.Action or a Button). */
  action?: ReactNode;
  showClose?: boolean;
}

export const Toast = forwardRef<HTMLLIElement, ToastProps>(function Toast(
  { tone = 'default', title, description, action, showClose = true, className, ...rest },
  ref,
) {
  return (
    <RadixToast.Root
      ref={ref}
      className={clsx('pd-toast', tone !== 'default' && `pd-toast--${tone}`, className)}
      {...rest}
    >
      {tone !== 'default' ? (
        <span className="pd-toast-icon" aria-hidden="true">
          ●
        </span>
      ) : null}
      <div className="pd-toast-body">
        {title !== undefined ? (
          <RadixToast.Title className="pd-toast-title">{title}</RadixToast.Title>
        ) : null}
        {description !== undefined ? (
          <RadixToast.Description className="pd-toast-description">
            {description}
          </RadixToast.Description>
        ) : null}
      </div>
      {action}
      {showClose ? (
        <RadixToast.Close asChild>
          <button
            type="button"
            className="pd-btn pd-btn--ghost-muted pd-icon-btn pd-btn--sm"
            aria-label="Dismiss notification"
          >
            <IconClose size={12} />
          </button>
        </RadixToast.Close>
      ) : null}
    </RadixToast.Root>
  );
});

export const ToastAction = RadixToast.Action;
