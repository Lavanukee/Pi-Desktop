import { clsx } from 'clsx';
import { Tooltip as RadixTooltip } from 'radix-ui';
import type { ComponentPropsWithoutRef, ReactElement, ReactNode } from 'react';
import { Kbd } from './chip.tsx';

/** Mount once near the app root. */
export const TooltipProvider = RadixTooltip.Provider;

export interface TooltipProps {
  label: ReactNode;
  /** Optional trailing keybind glyphs (codex tooltip pattern). */
  kbd?: string;
  side?: ComponentPropsWithoutRef<typeof RadixTooltip.Content>['side'];
  align?: ComponentPropsWithoutRef<typeof RadixTooltip.Content>['align'];
  /** Claude behavior rules: 0 on icon buttons. */
  delayDuration?: number;
  disableHoverableContent?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  className?: string;
  children: ReactElement;
}

/**
 * Tooltip — spec-tooltip.md. The whole flavor difference is the surface token
 * pair (--pd-tooltip-bg/fg): claude black glass in both modes, codex theme
 * pill. Never shows on disabled triggers (disabled elements emit no hover).
 */
export function Tooltip({
  label,
  kbd,
  side = 'bottom',
  align,
  delayDuration,
  disableHoverableContent,
  open,
  defaultOpen,
  className,
  children,
}: TooltipProps) {
  return (
    <RadixTooltip.Root
      open={open}
      defaultOpen={defaultOpen}
      delayDuration={delayDuration}
      disableHoverableContent={disableHoverableContent}
    >
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          className={clsx('pd-tooltip', className)}
          side={side}
          align={align}
          sideOffset={4}
        >
          {label}
          {kbd !== undefined ? <Kbd keys={kbd} appearance="bare" /> : null}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
