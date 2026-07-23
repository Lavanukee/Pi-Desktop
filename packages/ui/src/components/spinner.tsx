import { clsx } from 'clsx';
import type { HTMLAttributes } from 'react';
import { forwardRef } from 'react';

export interface SpinnerProps extends HTMLAttributes<HTMLSpanElement> {
  /** Diameter in px (defaults to --pd-icon-size). */
  size?: number;
}

/**
 * The Bobble loader — the app's standard spinner. A rounded arc orbits a faint
 * ring track while its sweep gently BREATHES between short and long (the
 * "bobble": alive, never mechanical). Calm and legible down to 13px.
 *
 * currentColor throughout, so it inherits the surrounding text color.
 * API-compatible with every prior spinner (same props / span ref / role), so
 * all call sites (App boot, ModelManager, ChatThread, connectors…) get it for
 * free. Multiple loaders desync via a per-instance negative delay.
 * Reduced-motion freezes to a static three-quarter arc (indicators.css).
 */
export const Spinner = forwardRef<HTMLSpanElement, SpinnerProps>(function Spinner(
  { size, className, style, ...rest },
  ref,
) {
  const sizeStyle = size === undefined ? {} : { width: size, height: size };
  const delay: Record<string, string> = { '--pd-loader-delay': `-${Date.now() % 1600}ms` };
  return (
    <span
      ref={ref}
      role="status"
      aria-label="Loading"
      className={clsx('pd-loader', className)}
      style={{ ...sizeStyle, ...delay, ...style }}
      {...rest}
    >
      <svg className="pd-loader-svg" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
        {/* faint full ring: the track the arc orbits */}
        <circle className="pd-loader-track" cx="16" cy="16" r="13" pathLength={100} />
        {/* the breathing arc (pathLength normalizes dasharray to 0-100) */}
        <circle className="pd-loader-arc" cx="16" cy="16" r="13" pathLength={100} />
      </svg>
    </span>
  );
});
