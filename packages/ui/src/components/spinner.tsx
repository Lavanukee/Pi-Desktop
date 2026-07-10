import { clsx } from 'clsx';
import type { HTMLAttributes } from 'react';
import { forwardRef } from 'react';

export interface SpinnerProps extends HTMLAttributes<HTMLSpanElement> {
  /** Diameter in px (defaults to --pd-icon-size). */
  size?: number;
}

/**
 * Border spinner (spec-artifact-panel: 24px / 2px / .8s linear). Multiple
 * spinners on screen desync via a negative animation-delay of -(now % 1000)ms
 * — the codex trick, adopted for both flavors (spec-buttons ADAPTATION).
 * Keeps spinning under prefers-reduced-motion (essential loading feedback).
 */
export const Spinner = forwardRef<HTMLSpanElement, SpinnerProps>(function Spinner(
  { size, className, style, ...rest },
  ref,
) {
  const sizeStyle =
    size === undefined ? {} : { width: size, height: size, borderWidth: Math.max(1.5, size / 9) };
  return (
    <span
      ref={ref}
      role="status"
      aria-label="Loading"
      className={clsx('pd-spinner', className)}
      style={{ ...sizeStyle, animationDelay: `-${Date.now() % 1000}ms`, ...style }}
      {...rest}
    />
  );
});
