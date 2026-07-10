import { clsx } from 'clsx';
import { DropdownMenu as RD } from 'radix-ui';
import type { ComponentPropsWithoutRef, CSSProperties, ReactNode } from 'react';
import { forwardRef } from 'react';
import { IconCheck, IconChevronRight } from './icons.tsx';
import { MenuRowContent, menuItemClass } from './menu-parts.tsx';

/**
 * DropdownMenu — spec-dropdown-menu.md, on Radix. Surface + rows are the
 * shared .pd-menu* family; motion is the tokenized flavor preset (claude
 * panel-in w/ 30ms stagger vs codex dropdown-enter).
 */
export const DropdownMenu = RD.Root;
export const DropdownMenuGroup = RD.Group;
export const DropdownMenuSub = RD.Sub;
export const DropdownMenuRadioGroup = RD.RadioGroup;

export const DropdownMenuTrigger = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<typeof RD.Trigger>
>(function DropdownMenuTrigger({ className, ...rest }, ref) {
  return <RD.Trigger ref={ref} className={clsx('pd-menu-trigger', className)} {...rest} />;
});

const availableHeight = {
  '--pd-menu-max-height': 'var(--radix-dropdown-menu-content-available-height)',
} as CSSProperties;

export const DropdownMenuContent = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof RD.Content>
>(function DropdownMenuContent(
  { className, sideOffset = 4, collisionPadding = 8, style, ...rest },
  ref,
) {
  return (
    <RD.Portal>
      <RD.Content
        ref={ref}
        className={clsx('pd-menu', className)}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        style={{ ...availableHeight, ...style }}
        {...rest}
      />
    </RD.Portal>
  );
});

export interface DropdownMenuItemProps extends ComponentPropsWithoutRef<typeof RD.Item> {
  icon?: ReactNode;
  description?: ReactNode;
  hint?: ReactNode;
  danger?: boolean;
}

export const DropdownMenuItem = forwardRef<HTMLDivElement, DropdownMenuItemProps>(
  function DropdownMenuItem(
    { icon, description, hint, danger, className, children, ...rest },
    ref,
  ) {
    return (
      <RD.Item
        ref={ref}
        className={menuItemClass({ danger, descriptive: description !== undefined, className })}
        {...rest}
      >
        <MenuRowContent icon={icon} description={description} hint={hint}>
          {children}
        </MenuRowContent>
      </RD.Item>
    );
  },
);

export interface DropdownMenuCheckboxItemProps
  extends ComponentPropsWithoutRef<typeof RD.CheckboxItem> {
  hint?: ReactNode;
}

export const DropdownMenuCheckboxItem = forwardRef<HTMLDivElement, DropdownMenuCheckboxItemProps>(
  function DropdownMenuCheckboxItem({ hint, className, children, ...rest }, ref) {
    return (
      <RD.CheckboxItem ref={ref} className={menuItemClass({ className })} {...rest}>
        {children}
        <span className="pd-menu-check">
          <RD.ItemIndicator>
            <IconCheck size={14} />
          </RD.ItemIndicator>
        </span>
        {hint !== undefined ? <span className="pd-menu-hint">{hint}</span> : null}
      </RD.CheckboxItem>
    );
  },
);

export interface DropdownMenuRadioItemProps extends ComponentPropsWithoutRef<typeof RD.RadioItem> {
  description?: ReactNode;
}

export const DropdownMenuRadioItem = forwardRef<HTMLDivElement, DropdownMenuRadioItemProps>(
  function DropdownMenuRadioItem({ description, className, children, ...rest }, ref) {
    return (
      <RD.RadioItem
        ref={ref}
        className={menuItemClass({ descriptive: description !== undefined, className })}
        {...rest}
      >
        <MenuRowContent description={description}>{children}</MenuRowContent>
        <span className="pd-menu-check">
          <RD.ItemIndicator>
            <IconCheck size={14} />
          </RD.ItemIndicator>
        </span>
      </RD.RadioItem>
    );
  },
);

export const DropdownMenuLabel = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof RD.Label>
>(function DropdownMenuLabel({ className, ...rest }, ref) {
  return <RD.Label ref={ref} className={clsx('pd-menu-label', className)} {...rest} />;
});

export const DropdownMenuSeparator = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof RD.Separator>
>(function DropdownMenuSeparator({ className, ...rest }, ref) {
  return <RD.Separator ref={ref} className={clsx('pd-menu-separator', className)} {...rest} />;
});

export interface DropdownMenuSubTriggerProps
  extends ComponentPropsWithoutRef<typeof RD.SubTrigger> {
  icon?: ReactNode;
}

export const DropdownMenuSubTrigger = forwardRef<HTMLDivElement, DropdownMenuSubTriggerProps>(
  function DropdownMenuSubTrigger({ icon, className, children, ...rest }, ref) {
    return (
      <RD.SubTrigger ref={ref} className={menuItemClass({ className })} {...rest}>
        <MenuRowContent icon={icon}>{children}</MenuRowContent>
        <span className="pd-menu-check">
          <IconChevronRight size={14} />
        </span>
      </RD.SubTrigger>
    );
  },
);

export const DropdownMenuSubContent = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof RD.SubContent>
>(function DropdownMenuSubContent({ className, sideOffset = 6, ...rest }, ref) {
  return (
    <RD.Portal>
      <RD.SubContent
        ref={ref}
        className={clsx('pd-menu', className)}
        sideOffset={sideOffset}
        {...rest}
      />
    </RD.Portal>
  );
});
