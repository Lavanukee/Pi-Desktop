/**
 * A large selectable card (radio-like) used by the source + experience steps.
 * Token-styled so it renders faithfully in all four flavor/mode themes.
 */
import { Badge, IconCheck } from '@pi-desktop/ui';
import type { ReactNode } from 'react';
import { cx } from './cx';

export interface SelectCardProps {
  selected: boolean;
  onSelect: () => void;
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  badge?: string;
  disabled?: boolean;
  'data-testid'?: string;
}

export function SelectCard({
  selected,
  onSelect,
  title,
  description,
  icon,
  badge,
  disabled,
  'data-testid': testId,
}: SelectCardProps) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a selectable card is not a native radio input
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      data-testid={testId}
      onClick={onSelect}
      className={cx(
        'group flex w-full items-start gap-3 rounded-lg border p-4 text-left transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus',
        disabled && 'cursor-not-allowed opacity-50',
        selected
          ? 'border-border-focus bg-accent-subtle'
          : 'border-border-default bg-bg-raised hover:border-border-strong hover:bg-bg-hover',
      )}
    >
      {icon != null ? (
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-bg-inset text-text-secondary">
          {icon}
        </span>
      ) : null}
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="text-body font-medium text-text-primary">{title}</span>
          {badge != null ? (
            <Badge tone="success" size="sm">
              {badge}
            </Badge>
          ) : null}
        </span>
        {description != null ? (
          <span className="mt-1 block text-footnote text-text-muted">{description}</span>
        ) : null}
      </span>
      <span
        className={cx(
          'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors',
          selected
            ? 'border-accent-primary bg-accent-primary text-text-on-accent'
            : 'border-border-strong text-transparent',
        )}
        aria-hidden
      >
        <IconCheck size={12} />
      </span>
    </button>
  );
}
