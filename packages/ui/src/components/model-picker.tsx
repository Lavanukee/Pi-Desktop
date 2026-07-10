import { clsx } from 'clsx';
import { forwardRef } from 'react';
import { Button } from './button.tsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from './dropdown-menu.tsx';
import { IconChevronDown } from './icons.tsx';

export interface ModelOption {
  id: string;
  label: string;
  /** Local-model metadata (size, quant) renders on the descriptive row. */
  description?: string;
}

export interface EffortOption {
  id: string;
  label: string;
}

export interface ModelPickerProps {
  models: ModelOption[];
  model: string;
  onModelChange?: (id: string) => void;
  efforts?: EffortOption[];
  effort?: string;
  onEffortChange?: (id: string) => void;
  /** Section label above the effort radio rows (codex uses "Reasoning"). */
  effortLabel?: string;
  disabled?: boolean;
  className?: string;
  /** Force-open for galleries/screenshots. */
  open?: boolean;
  defaultOpen?: boolean;
}

/**
 * Model picker — spec-model-picker.md. Trigger is the shared ghost text button
 * ([model w500] [effort muted] [chevron], right-edge fade at 12rem) — identical
 * in both apps. Dropdown is the codex-evidenced structure (effort radio section
 * + model submenu with descriptive rows) re-skinned per flavor by the .pd-menu
 * family; the claude dropdown composition itself was NOT captured (●○○).
 */
export const ModelPicker = forwardRef<HTMLButtonElement, ModelPickerProps>(function ModelPicker(
  {
    models,
    model,
    onModelChange,
    efforts,
    effort,
    onEffortChange,
    effortLabel = 'Reasoning',
    disabled,
    className,
    open,
    defaultOpen,
  },
  ref,
) {
  const active = models.find((m) => m.id === model);
  const activeEffort = efforts?.find((e) => e.id === effort);
  return (
    <DropdownMenu open={open} defaultOpen={defaultOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          ref={ref}
          variant="ghost"
          disabled={disabled}
          className={clsx('pd-model-trigger', className)}
        >
          <span className="pd-model-trigger-value">
            <span className="pd-model-trigger-model">{active?.label ?? model}</span>
            {activeEffort !== undefined ? (
              <span className="pd-model-trigger-effort">{activeEffort.label}</span>
            ) : null}
          </span>
          <span className="pd-model-trigger-chevron">
            <IconChevronDown size={12} />
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {efforts !== undefined && efforts.length > 0 ? (
          <>
            <DropdownMenuLabel>{effortLabel}</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={effort} onValueChange={(next) => onEffortChange?.(next)}>
              {efforts.map((option) => (
                <DropdownMenuRadioItem key={option.id} value={option.id}>
                  {option.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>{active?.label ?? model}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup value={model} onValueChange={(next) => onModelChange?.(next)}>
              {models.map((option) => (
                <DropdownMenuRadioItem
                  key={option.id}
                  value={option.id}
                  description={option.description}
                >
                  {option.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
