import { clsx } from 'clsx';
import type { HTMLAttributes } from 'react';
import { forwardRef } from 'react';

export interface ScrollAreaProps extends HTMLAttributes<HTMLDivElement> {
  axis?: 'x' | 'y';
  /** Scroll-edge fade masks (scroll-driven where supported — spec-scrollbars). */
  fade?: boolean;
  /** Hide the scrollbar entirely (menus/pill rows; the fade carries affordance). */
  hideScrollbar?: boolean;
}

/**
 * Scroll container wired to the flavor scrollbar recipes (claude thin floating
 * pill vs codex scrollbar-color) and the shared ScrollFade masks.
 */
export const ScrollArea = forwardRef<HTMLDivElement, ScrollAreaProps>(function ScrollArea(
  { axis = 'y', fade = true, hideScrollbar = false, className, style, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      className={clsx(
        'pd-scroll',
        fade && (axis === 'y' ? 'pd-scroll-fade-y' : 'pd-scroll-fade-x'),
        hideScrollbar && 'pd-scroll--hidden',
        className,
      )}
      style={{ [axis === 'y' ? 'overflowY' : 'overflowX']: 'auto', ...style }}
      {...rest}
    />
  );
});
