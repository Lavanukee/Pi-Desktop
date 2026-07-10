import { clsx } from 'clsx';
import type { HTMLAttributes } from 'react';
import { forwardRef } from 'react';

export interface SpinnerProps extends HTMLAttributes<HTMLSpanElement> {
  /** Diameter in px (defaults to --pd-icon-size). */
  size?: number;
}

/**
 * The branded "Pi caret" loader (build/loader.svg, in-app). The pi mark DRAWS
 * ITSELF — a currentColor stroke wipes along the pi's path — while its right leg
 * blinks like a text-insertion caret ("cursor" reading of the mark, in motion).
 * A faint full mark is hinted underneath so it reads even mid-draw.
 *
 * API-compatible with the old border spinner (same props / span ref / role), so
 * every call site (App boot, ModelManager, ChatThread, connectors…) gets it for
 * free. Uses currentColor, so it inherits the surrounding text color; keep a
 * `size` prop. Multiple loaders desync via a per-instance negative delay.
 * Reduced-motion freezes to the fully-drawn static mark (indicators.css).
 */
export const Spinner = forwardRef<HTMLSpanElement, SpinnerProps>(function Spinner(
  { size, className, style, ...rest },
  ref,
) {
  const sizeStyle = size === undefined ? {} : { width: size, height: size };
  const delay: Record<string, string> = { '--pd-loader-delay': `-${Date.now() % 2600}ms` };
  return (
    <span
      ref={ref}
      role="status"
      aria-label="Loading"
      className={clsx('pd-loader', className)}
      style={{ ...sizeStyle, ...delay, ...style }}
      {...rest}
    >
      <svg className="pd-loader-svg" viewBox="0 0 1024 1024" aria-hidden="true" focusable="false">
        {/* faint full mark: the "un-drawn" pi hinted underneath */}
        <g className="pd-loader-ghost">
          <rect x="300" y="328" width="424" height="86" rx="43" />
          <rect x="329" y="328" width="86" height="372" rx="43" />
          <rect x="609" y="328" width="86" height="372" rx="43" />
        </g>
        {/* the pi drawing itself: roof, then left leg, then right leg */}
        <path
          className="pd-loader-draw"
          pathLength={1000}
          d="M300 371 L724 371 M372 371 L372 700 M652 371 L652 700"
        />
        {/* right leg = blinking text caret (the "cursor" tell) */}
        <rect className="pd-loader-caret" x="609" y="328" width="86" height="372" rx="43" />
      </svg>
    </span>
  );
});
