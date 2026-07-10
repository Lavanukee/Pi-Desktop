import { clsx } from 'clsx';
import { ContextMenu as RC } from 'radix-ui';
import type { ComponentPropsWithoutRef, CSSProperties, ReactNode } from 'react';
import { forwardRef } from 'react';
import { IconCheck } from './icons.tsx';
import { MenuRowContent, menuItemClass } from './menu-parts.tsx';

/** ContextMenu — same .pd-menu* family as DropdownMenu (one fix propagates). */
export const ContextMenu = RC.Root;
export const ContextMenuTrigger = RC.Trigger;

const availableHeight = {
  '--pd-menu-max-height': 'var(--radix-context-menu-content-available-height)',
} as CSSProperties;

export const ContextMenuContent = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof RC.Content>
>(function ContextMenuContent({ className, collisionPadding = 8, style, ...rest }, ref) {
  return (
    <RC.Portal>
      <RC.Content
        ref={ref}
        className={clsx('pd-menu', className)}
        collisionPadding={collisionPadding}
        style={{ ...availableHeight, ...style }}
        {...rest}
      />
    </RC.Portal>
  );
});

export interface ContextMenuItemProps extends ComponentPropsWithoutRef<typeof RC.Item> {
  icon?: ReactNode;
  hint?: ReactNode;
  danger?: boolean;
}

export const ContextMenuItem = forwardRef<HTMLDivElement, ContextMenuItemProps>(
  function ContextMenuItem({ icon, hint, danger, className, children, ...rest }, ref) {
    return (
      <RC.Item ref={ref} className={menuItemClass({ danger, className })} {...rest}>
        <MenuRowContent icon={icon} hint={hint}>
          {children}
        </MenuRowContent>
      </RC.Item>
    );
  },
);

export const ContextMenuCheckboxItem = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof RC.CheckboxItem>
>(function ContextMenuCheckboxItem({ className, children, ...rest }, ref) {
  return (
    <RC.CheckboxItem ref={ref} className={menuItemClass({ className })} {...rest}>
      {children}
      <span className="pd-menu-check">
        <RC.ItemIndicator>
          <IconCheck size={14} />
        </RC.ItemIndicator>
      </span>
    </RC.CheckboxItem>
  );
});

export const ContextMenuLabel = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof RC.Label>
>(function ContextMenuLabel({ className, ...rest }, ref) {
  return <RC.Label ref={ref} className={clsx('pd-menu-label', className)} {...rest} />;
});

export const ContextMenuSeparator = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof RC.Separator>
>(function ContextMenuSeparator({ className, ...rest }, ref) {
  return <RC.Separator ref={ref} className={clsx('pd-menu-separator', className)} {...rest} />;
});
