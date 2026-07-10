import { clsx } from 'clsx';
import type { ButtonHTMLAttributes } from 'react';
import { forwardRef } from 'react';
import { defineVariants } from '../define-variants.ts';
import { Spinner } from './spinner.tsx';

/**
 * Button — spec-buttons.md. One anatomy for both flavors (claude fill-layer
 * trick; codex flattens purely via tokens). Both primaries are inverted
 * monochrome; clay/blue live on the `accent` variant only.
 */
export const buttonClass = defineVariants({
  base: 'pd-btn',
  variants: {
    variant: {
      primary: 'pd-btn--primary',
      accent: 'pd-btn--accent',
      secondary: 'pd-btn--secondary',
      outline: 'pd-btn--outline',
      ghost: 'pd-btn--ghost',
      ghostMuted: 'pd-btn--ghost-muted',
      danger: 'pd-btn--danger',
    },
    size: {
      sm: 'pd-btn--sm',
      md: 'pd-btn--md',
      lg: 'pd-btn--lg',
    },
  },
  defaultVariants: { variant: 'secondary', size: 'md' },
});

export type ButtonVariant =
  | 'primary'
  | 'accent'
  | 'secondary'
  | 'outline'
  | 'ghost'
  | 'ghostMuted'
  | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Full-circle/pill silhouette (composer send, scroll FAB). */
  circle?: boolean;
  /** Shows the desynced spinner and disables the button. */
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    circle = false,
    loading = false,
    className,
    children,
    disabled = false,
    type = 'button',
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={buttonClass({
        variant,
        size,
        className: clsx(circle && 'pd-btn--circle', className),
      })}
      {...rest}
    >
      {loading ? <Spinner size={12} /> : null}
      {children}
    </button>
  );
});

export interface IconButtonProps extends ButtonProps {
  /** Icon-only controls must name themselves (a11y convention). */
  'aria-label': string;
}

/** 28px square icon button (both apps' top bars — spec-top-bar). */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { className, variant = 'ghost', ...rest },
  ref,
) {
  return (
    <Button ref={ref} variant={variant} className={clsx('pd-icon-btn', className)} {...rest} />
  );
});
