import { clsx } from 'clsx';
import { Checkbox as RadixCheckbox, Switch as RadixSwitch, Tabs as RadixTabs } from 'radix-ui';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { forwardRef } from 'react';
import { IconCheck } from './icons.tsx';

export interface SwitchProps extends ComponentPropsWithoutRef<typeof RadixSwitch.Root> {
  size?: 'sm' | 'md';
}

/**
 * Switch — claude geometry (36x20 track / 16px thumb / travel = width-height),
 * documented to the pixel in spec-settings and used for both flavors per its
 * ADAPTATION notes. Checked fill = each flavor's accent blue (--pd-text-link
 * family), not the inverted mono.
 */
export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  { size = 'md', className, ...rest },
  ref,
) {
  return (
    <RadixSwitch.Root
      ref={ref}
      className={clsx('pd-switch pd-focusable', size === 'sm' && 'pd-switch--sm', className)}
      {...rest}
    >
      <RadixSwitch.Thumb className="pd-switch-thumb" />
    </RadixSwitch.Root>
  );
});

export type CheckboxProps = ComponentPropsWithoutRef<typeof RadixCheckbox.Root>;

/** Checkbox — 16px, radius 4 (claude spec-settings), link-blue when checked. */
export const Checkbox = forwardRef<HTMLButtonElement, CheckboxProps>(function Checkbox(
  { className, ...rest },
  ref,
) {
  return (
    <RadixCheckbox.Root ref={ref} className={clsx('pd-checkbox pd-focusable', className)} {...rest}>
      <RadixCheckbox.Indicator>
        <IconCheck size={12} />
      </RadixCheckbox.Indicator>
    </RadixCheckbox.Root>
  );
});

/**
 * Tabs — the segmented-control recipe from spec-model-picker (recessed
 * --pd-bg-track well; active segment = raised pill + hairline + soft shadow;
 * codex goes full-pill via --pd-radius-button).
 */
export const Tabs = RadixTabs.Root;

export const TabsList = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof RadixTabs.List>>(
  function TabsList({ className, ...rest }, ref) {
    return <RadixTabs.List ref={ref} className={clsx('pd-segmented', className)} {...rest} />;
  },
);

export const TabsTrigger = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<typeof RadixTabs.Trigger>
>(function TabsTrigger({ className, ...rest }, ref) {
  return (
    <RadixTabs.Trigger ref={ref} className={clsx('pd-segment pd-focusable', className)} {...rest} />
  );
});

export const TabsContent = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof RadixTabs.Content>
>(function TabsContent({ className, ...rest }, ref) {
  return <RadixTabs.Content ref={ref} className={clsx('pd-tab-panel', className)} {...rest} />;
});

export interface SegmentedControlOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}

export interface SegmentedControlProps {
  options: SegmentedControlOption[];
  value: string;
  onValueChange?: (value: string) => void;
  'aria-label': string;
  className?: string;
}

/** Standalone segmented control (claude Chat|Cowork, Home|Code tabs). */
export const SegmentedControl = forwardRef<HTMLFieldSetElement, SegmentedControlProps>(
  function SegmentedControl({ options, value, onValueChange, className, ...rest }, ref) {
    return (
      <fieldset ref={ref} className={clsx('pd-segmented', className)} {...rest}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className="pd-segment pd-focusable"
            aria-pressed={option.value === value}
            disabled={option.disabled}
            onClick={() => onValueChange?.(option.value)}
          >
            {option.label}
          </button>
        ))}
      </fieldset>
    );
  },
);
