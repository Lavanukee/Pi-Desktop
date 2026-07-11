import { clsx } from 'clsx';
import { Popover as RP } from 'radix-ui';
import type { ComponentPropsWithoutRef, CSSProperties } from 'react';
import { forwardRef } from 'react';

/**
 * Popover — a non-menu floating surface on Radix, the sibling of
 * {@link DropdownMenu} for content that isn't a list of rows (round-14 #2 hosts
 * the effort slider in one). Surface is the shared `.pd-menu` family so it reads
 * identically in both flavors; open/close motion is the tokenized menu preset,
 * or add `pd-menu--instant` to appear/disappear with no animation.
 */
export const Popover = RP.Root;
export const PopoverAnchor = RP.Anchor;
export const PopoverClose = RP.Close;

export const PopoverTrigger = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<typeof RP.Trigger>
>(function PopoverTrigger({ className, ...rest }, ref) {
  return <RP.Trigger ref={ref} className={clsx('pd-menu-trigger', className)} {...rest} />;
});

const availableHeight = {
  '--pd-menu-max-height': 'var(--radix-popover-content-available-height)',
} as CSSProperties;

export interface PopoverContentProps extends ComponentPropsWithoutRef<typeof RP.Content> {
  /** Portal the surface to `<body>` (default true) so it escapes ancestor
   * clipping. Set false to render inline — used by the unit tests so the body is
   * assertable without a DOM portal, and available to callers that must anchor
   * inside a specific stacking/transform context. */
  portal?: boolean;
}

export const PopoverContent = forwardRef<HTMLDivElement, PopoverContentProps>(
  function PopoverContent(
    { className, sideOffset = 4, collisionPadding = 8, style, portal = true, ...rest },
    ref,
  ) {
    const content = (
      <RP.Content
        ref={ref}
        className={clsx('pd-menu', className)}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        style={{ ...availableHeight, ...style }}
        {...rest}
      />
    );
    return portal ? <RP.Portal>{content}</RP.Portal> : content;
  },
);
