import { clsx } from 'clsx';
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
import { forwardRef } from 'react';
import { IconClose } from './icons.tsx';

export interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: ReactNode;
  /** Play the codex chip-enter overshoot on mount (adopted for both flavors). */
  enter?: boolean;
}

/** Suggestion chip — outline pill (claude Home row; codex outline variant). */
export const Chip = forwardRef<HTMLButtonElement, ChipProps>(function Chip(
  { icon, enter = false, className, children, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={clsx('pd-chip pd-focusable', enter && 'pd-chip--enter', className)}
      {...rest}
    >
      {icon ? <span className="pd-chip-icon">{icon}</span> : null}
      {children}
    </button>
  );
});

export type BadgeTone = 'default' | 'info' | 'success' | 'warning' | 'danger' | 'accent';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  size?: 'sm' | 'md';
}

/** Badge — claude sizes (base 16px / small 12px, spec-chips-kbd). */
export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { tone = 'default', size = 'md', className, ...rest },
  ref,
) {
  return (
    <span
      ref={ref}
      className={clsx(
        'pd-badge',
        size === 'sm' && 'pd-badge--sm',
        tone !== 'default' && `pd-badge--${tone}`,
        className,
      )}
      {...rest}
    />
  );
});

export interface KbdProps extends HTMLAttributes<HTMLElement> {
  /** Rendered glyphs, e.g. "⌘K". */
  keys: string;
  /**
   * `auto` follows the flavor default (codex chip chrome / claude bare muted
   * glyphs — spec-chips-kbd ADAPTATION); `chip`/`bare` force a mode.
   */
  appearance?: 'auto' | 'chip' | 'bare';
}

export const Kbd = forwardRef<HTMLElement, KbdProps>(function Kbd(
  { keys, appearance = 'auto', className, ...rest },
  ref,
) {
  return (
    <kbd
      ref={ref}
      className={clsx(
        'pd-kbd',
        appearance === 'auto' && 'pd-kbd--auto',
        appearance === 'chip' && 'pd-kbd--chip',
        appearance === 'bare' && 'pd-kbd--bare',
        className,
      )}
      {...rest}
    >
      {keys}
    </kbd>
  );
});

export interface AttachmentPillProps extends HTMLAttributes<HTMLSpanElement> {
  name: string;
  meta?: ReactNode;
  onRemove?: () => void;
}

/**
 * Composer attachment pill; radius is the flavor-neutral concentric formula
 * max(0, surface-radius - inset) ported exactly (spec-chips-kbd).
 */
export const AttachmentPill = forwardRef<HTMLSpanElement, AttachmentPillProps>(
  function AttachmentPill({ name, meta, onRemove, className, ...rest }, ref) {
    return (
      <span ref={ref} className={clsx('pd-attachment-pill pd-chip--enter', className)} {...rest}>
        <span className="pd-attachment-pill-name">{name}</span>
        {meta !== undefined ? <span className="pd-attachment-pill-meta">{meta}</span> : null}
        {onRemove ? (
          <button
            type="button"
            className="pd-btn pd-btn--ghost-muted pd-icon-btn pd-btn--sm"
            aria-label={`Remove ${name}`}
            onClick={onRemove}
          >
            <IconClose size={12} />
          </button>
        ) : null}
      </span>
    );
  },
);

export interface FloatingPillProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title: ReactNode;
  description?: ReactNode;
  onDismiss?: () => void;
}

/** Above-composer dismissable suggestion pill (codex-evidenced; claude LOW). */
export const FloatingPill = forwardRef<HTMLDivElement, FloatingPillProps>(function FloatingPill(
  { title, description, onDismiss, className, ...rest },
  ref,
) {
  return (
    <div ref={ref} className={clsx('pd-float-pill pd-chip--enter', className)} {...rest}>
      <span>
        <span className="pd-float-pill-title">{title}</span>
        {description !== undefined ? (
          <span className="pd-float-pill-description"> {description}</span>
        ) : null}
      </span>
      {onDismiss ? (
        <button
          type="button"
          className="pd-btn pd-btn--ghost-muted pd-icon-btn pd-btn--sm pd-btn--circle"
          aria-label="Dismiss"
          onClick={onDismiss}
        >
          <IconClose size={12} />
        </button>
      ) : null}
    </div>
  );
});
