import { clsx } from 'clsx';
import type { HTMLAttributes, ReactNode } from 'react';
import { forwardRef } from 'react';
import { Kbd } from './chip.tsx';

/*
 * Composer suggestions (THEME 4 — presentational only; the app wires it to the
 * editor). Renders as an OVERLAY above the input: absolutely positioned off the
 * composer's top edge so it never reserves layout or snaps the input bar
 * downward. The ACTIVE row (the one Tab accepts) gets a clear highlight plus a
 * "tab" Kbd hint, so it is always obvious what Tab will do.
 */

export interface SuggestionItem {
  /** Stable key; falls back to the index. */
  id?: string;
  label: ReactNode;
  /** Optional trailing description shown muted before the tab hint. */
  hint?: ReactNode;
}

export interface SuggestionListProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onSelect'> {
  suggestions: SuggestionItem[];
  /** Index Tab will accept; highlighted + tab-hinted. */
  activeIndex: number;
  onAccept: (index: number) => void;
  /** Pointer hover moves the active index (app keeps keyboard + pointer in sync). */
  onHoverIndex?: (index: number) => void;
}

/** Floating suggestion overlay; mount it inside a positioned composer wrapper. */
export const SuggestionList = forwardRef<HTMLDivElement, SuggestionListProps>(
  function SuggestionList(
    { suggestions, activeIndex, onAccept, onHoverIndex, className, ...rest },
    ref,
  ) {
    if (suggestions.length === 0) return null;
    const seen = new Map<string, number>();
    const items = suggestions.map((item, index) => {
      const base = item.id ?? (typeof item.label === 'string' ? item.label : `item-${index}`);
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      return { item, index, key: n === 0 ? base : `${base}#${n}` };
    });
    return (
      <div
        ref={ref}
        className={clsx('pd-suggestions', className)}
        role="listbox"
        aria-label="Suggestions"
        {...rest}
      >
        {items.map(({ item, index, key }) => {
          const active = index === activeIndex;
          return (
            <button
              key={key}
              type="button"
              role="option"
              aria-selected={active}
              className={clsx('pd-suggestion', active && 'pd-suggestion--active')}
              onMouseEnter={() => onHoverIndex?.(index)}
              onFocus={() => onHoverIndex?.(index)}
              onClick={() => onAccept(index)}
            >
              <span className="pd-suggestion-label">{item.label}</span>
              {item.hint !== undefined ? (
                <span className="pd-suggestion-hint">{item.hint}</span>
              ) : null}
              {active ? (
                <span className="pd-suggestion-tab">
                  <Kbd keys="tab" appearance="chip" />
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    );
  },
);
