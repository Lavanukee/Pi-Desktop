import { clsx } from 'clsx';
import type { HTMLAttributes } from 'react';
import { forwardRef, useState } from 'react';

export interface SpinnerProps extends HTMLAttributes<HTMLSpanElement> {
  /** Diameter in px (defaults to --pd-icon-size). */
  size?: number;
}

/**
 * lcm(1100ms spin, 1600ms breathe) — the two loader periods in indicators.css.
 * A negative delay drawn from this window lands both animations on the same
 * phase they would have if they had been running since the page's time origin.
 * Keep in step with those two durations if either ever changes.
 */
const LOADER_PERIOD_MS = 17_600;

/**
 * The Bobble loader — the app's standard spinner. A rounded arc orbits a faint
 * ring track while its sweep gently BREATHES between short and long (the
 * "bobble": alive, never mechanical). Calm and legible down to 13px.
 *
 * currentColor throughout, so it inherits the surrounding text color.
 * API-compatible with every prior spinner (same props / span ref / role), so
 * all call sites (App boot, ModelManager, ChatThread, connectors…) get it for
 * free. Every loader runs on the same clock phase, so they turn together.
 * Reduced-motion freezes to a static three-quarter arc (indicators.css).
 */
export const Spinner = forwardRef<HTMLSpanElement, SpinnerProps>(function Spinner(
  { size, className, style, ...rest },
  ref,
) {
  // Phase-lock to the document clock, computed ONCE. A CSS animation's position
  // is (now − start) − delay, so re-deriving the delay on every render (this
  // read Date.now() inline) re-aimed the arc every time the status text, tool
  // name or token count beside it changed — the loader snapped to a random
  // angle many times a second instead of turning. Pinning it at mount to
  // −(now mod period) makes the phase a pure function of wall time, which also
  // makes a REMOUNT invisible: the replacement element picks up exactly where
  // its predecessor was, so a spinner that gets re-keyed by a changing status
  // row no longer jumps back to 0°. performance.now() is used because it shares
  // the time origin the browser's animation timeline counts from.
  const [delay] = useState<Record<string, string>>(() => ({
    '--pd-loader-delay': `-${Math.round(performance.now() % LOADER_PERIOD_MS)}ms`,
  }));
  const sizeStyle = size === undefined ? {} : { width: size, height: size };
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
