import { clsx } from 'clsx';
import { Dialog as RadixDialog } from 'radix-ui';
import type { ComponentPropsWithoutRef, HTMLAttributes } from 'react';
import { forwardRef } from 'react';
import { IconClose } from './icons.tsx';

/**
 * Dialog — spec-dialog.md. One structure for both flavors; the motion tokens
 * select claude `zoom` (.95->1, 250/125ms asymmetric close) or codex `rise`
 * (8px + .98 from top origin, 300/150ms).
 */
export const Dialog = RadixDialog.Root;
export const DialogTrigger = RadixDialog.Trigger;
export const DialogClose = RadixDialog.Close;

export interface DialogContentProps extends ComponentPropsWithoutRef<typeof RadixDialog.Content> {
  /** Ghost close button in the top-right (claude header idiom). */
  showClose?: boolean;
}

export const DialogContent = forwardRef<HTMLDivElement, DialogContentProps>(function DialogContent(
  { showClose = true, className, children, ...rest },
  ref,
) {
  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay className="pd-dialog-overlay" />
      <RadixDialog.Content ref={ref} className={clsx('pd-dialog', className)} {...rest}>
        {children}
        {showClose ? (
          <RadixDialog.Close asChild>
            <button
              type="button"
              className="pd-btn pd-btn--ghost-muted pd-icon-btn pd-btn--sm"
              aria-label="Close"
              style={{ position: 'absolute', top: 12, right: 12 }}
            >
              <IconClose />
            </button>
          </RadixDialog.Close>
        ) : null}
      </RadixDialog.Content>
    </RadixDialog.Portal>
  );
});

export const DialogHeader = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function DialogHeader({ className, ...rest }, ref) {
    return <div ref={ref} className={clsx('pd-dialog-header', className)} {...rest} />;
  },
);

export const DialogTitle = forwardRef<
  HTMLHeadingElement,
  ComponentPropsWithoutRef<typeof RadixDialog.Title>
>(function DialogTitle({ className, ...rest }, ref) {
  return <RadixDialog.Title ref={ref} className={clsx('pd-dialog-title', className)} {...rest} />;
});

export const DialogDescription = forwardRef<
  HTMLParagraphElement,
  ComponentPropsWithoutRef<typeof RadixDialog.Description>
>(function DialogDescription({ className, ...rest }, ref) {
  return (
    <RadixDialog.Description
      ref={ref}
      className={clsx('pd-dialog-description', className)}
      {...rest}
    />
  );
});

export const DialogBody = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function DialogBody({ className, ...rest }, ref) {
    return <div ref={ref} className={clsx('pd-dialog-body pd-scroll', className)} {...rest} />;
  },
);

export const DialogFooter = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function DialogFooter({ className, ...rest }, ref) {
    return <div ref={ref} className={clsx('pd-dialog-footer', className)} {...rest} />;
  },
);

export type CurtainProps = HTMLAttributes<HTMLDivElement>;

/**
 * Curtain — app-level blocking scrim (codex pattern, adopted for both flavors
 * per spec-dialog ADAPTATION; use for model downloads etc.).
 */
export const Curtain = forwardRef<HTMLDivElement, CurtainProps>(function Curtain(
  { className, ...rest },
  ref,
) {
  return <div ref={ref} className={clsx('pd-curtain', className)} {...rest} />;
});
