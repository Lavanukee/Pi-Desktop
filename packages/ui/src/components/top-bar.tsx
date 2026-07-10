import { clsx } from 'clsx';
import type { HTMLAttributes, ReactNode } from 'react';
import { forwardRef } from 'react';

export interface TopBarProps extends HTMLAttributes<HTMLElement> {
  /** Left padding clearing macOS traffic lights (hiddenInset). */
  trafficLightInset?: boolean;
  left?: ReactNode;
  center?: ReactNode;
  right?: ReactNode;
}

/**
 * Top bar — spec-top-bar.md: 46px (--pd-height-topbar) in both flavors, whole
 * bar draggable; interactive children opt out via .nc-no-drag (buttons already
 * do). Slots are app config, not flavor CSS.
 */
export const TopBar = forwardRef<HTMLElement, TopBarProps>(function TopBar(
  { trafficLightInset = false, left, center, right, className, children, ...rest },
  ref,
) {
  return (
    <header
      ref={ref}
      className={clsx('pd-topbar', trafficLightInset && 'pd-topbar--traffic-lights', className)}
      {...rest}
    >
      <div className="pd-topbar-section">{left}</div>
      <div className="pd-topbar-section pd-topbar-section--center">{center}</div>
      <div className="pd-topbar-section">{right}</div>
      {children}
    </header>
  );
});

export const TopBarTitle = forwardRef<HTMLSpanElement, HTMLAttributes<HTMLSpanElement>>(
  function TopBarTitle({ className, ...rest }, ref) {
    return <span ref={ref} className={clsx('pd-topbar-title', className)} {...rest} />;
  },
);

export type MainSurfaceProps = HTMLAttributes<HTMLDivElement>;

/**
 * Content surface next to the sidebar. Codex flavor renders it as the
 * "floating card" (rounded + hairline + soft glow — its structural shell
 * signature, spec-top-bar ADAPTATION); claude stays a flat two-pane split.
 * Both purely via CSS on data-flavor.
 */
export const MainSurface = forwardRef<HTMLDivElement, MainSurfaceProps>(function MainSurface(
  { className, ...rest },
  ref,
) {
  return <div ref={ref} className={clsx('pd-main-surface', className)} {...rest} />;
});
