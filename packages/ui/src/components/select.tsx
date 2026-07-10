import { clsx } from 'clsx';
import { Select as RS } from 'radix-ui';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { forwardRef } from 'react';
import { IconCheck, IconChevronDown } from './icons.tsx';
import { MenuRowContent, menuItemClass } from './menu-parts.tsx';

/**
 * Select — spec-dropdown-menu.md rows on Radix Select. The trigger is an
 * outline button; the panel and rows reuse the shared .pd-menu* family.
 */
export const Select = RS.Root;
export const SelectValue = RS.Value;
export const SelectGroup = RS.Group;

export interface SelectTriggerProps extends ComponentPropsWithoutRef<typeof RS.Trigger> {
  placeholder?: string;
}

export const SelectTrigger = forwardRef<HTMLButtonElement, SelectTriggerProps>(
  function SelectTrigger({ className, children, placeholder, ...rest }, ref) {
    return (
      <RS.Trigger
        ref={ref}
        className={clsx('pd-btn pd-btn--outline pd-menu-trigger', className)}
        {...rest}
      >
        {children ?? <RS.Value placeholder={placeholder} />}
        <RS.Icon className="pd-select-chevron">
          <IconChevronDown size={14} />
        </RS.Icon>
      </RS.Trigger>
    );
  },
);

export const SelectContent = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof RS.Content>
>(function SelectContent(
  { className, position = 'popper', sideOffset = 4, children, ...rest },
  ref,
) {
  return (
    <RS.Portal>
      <RS.Content
        ref={ref}
        className={clsx('pd-menu', className)}
        position={position}
        sideOffset={sideOffset}
        {...rest}
      >
        <RS.Viewport>{children}</RS.Viewport>
      </RS.Content>
    </RS.Portal>
  );
});

export interface SelectItemProps extends ComponentPropsWithoutRef<typeof RS.Item> {
  description?: ReactNode;
}

export const SelectItem = forwardRef<HTMLDivElement, SelectItemProps>(function SelectItem(
  { description, className, children, ...rest },
  ref,
) {
  return (
    <RS.Item
      ref={ref}
      className={menuItemClass({ descriptive: description !== undefined, className })}
      {...rest}
    >
      <MenuRowContent description={description}>
        <RS.ItemText>{children}</RS.ItemText>
      </MenuRowContent>
      <span className="pd-menu-check">
        <RS.ItemIndicator>
          <IconCheck size={14} />
        </RS.ItemIndicator>
      </span>
    </RS.Item>
  );
});

export const SelectLabel = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof RS.Label>>(
  function SelectLabel({ className, ...rest }, ref) {
    return <RS.Label ref={ref} className={clsx('pd-menu-label', className)} {...rest} />;
  },
);

export const SelectSeparator = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof RS.Separator>
>(function SelectSeparator({ className, ...rest }, ref) {
  return <RS.Separator ref={ref} className={clsx('pd-menu-separator', className)} {...rest} />;
});
