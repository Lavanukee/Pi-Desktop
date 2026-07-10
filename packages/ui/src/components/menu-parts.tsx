/**
 * Shared row internals for the .pd-menu* family (spec-dropdown-menu: one row
 * recipe powers dropdown, context menu, select, model picker and cmdk — a
 * single fix here propagates app-wide).
 */

import { clsx } from 'clsx';
import type { ReactNode } from 'react';

export interface MenuRowContentProps {
  icon?: ReactNode;
  /** Second muted line; switches the row to the descriptive layout. */
  description?: ReactNode;
  /** Trailing shortcut hint (bare muted glyphs in menu rows, both flavors). */
  hint?: ReactNode;
  children?: ReactNode;
}

export function menuItemClass(options: {
  danger?: boolean | undefined;
  descriptive?: boolean | undefined;
  className?: string | undefined;
}): string {
  return clsx(
    'pd-menu-item',
    options.danger && 'pd-menu-item--danger',
    options.descriptive && 'pd-menu-item--descriptive',
    options.className,
  );
}

export function MenuRowContent({ icon, description, hint, children }: MenuRowContentProps) {
  return (
    <>
      {icon !== undefined ? <span className="pd-menu-icon">{icon}</span> : null}
      {description !== undefined ? (
        <span className="pd-menu-item-body">
          <span className="pd-menu-item-title">{children}</span>
          <span className="pd-menu-item-description">{description}</span>
        </span>
      ) : (
        children
      )}
      {hint !== undefined ? <span className="pd-menu-hint">{hint}</span> : null}
    </>
  );
}
