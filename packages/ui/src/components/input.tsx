import { clsx } from 'clsx';
import type {
  ChangeEvent,
  InputHTMLAttributes,
  KeyboardEvent,
  TextareaHTMLAttributes,
} from 'react';
import { forwardRef, useEffect, useRef, useState } from 'react';
import { IconSearch } from './icons.tsx';

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

/** Single-line field — spec-composer/spec-settings input recipes. */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, ...rest },
  ref,
) {
  return <input ref={ref} className={clsx('pd-input', className)} {...rest} />;
});

export interface SearchInputProps extends InputProps {
  /** Leading magnifying-glass size in px. */
  iconSize?: number;
}

/**
 * Search field with a leading magnifying glass — the "Search chats" affordance.
 * A thin wrapper over {@link Input}: the muted {@link IconSearch} is overlaid
 * inside the field's left inset and honors `--pd-icon-stroke` like every glyph.
 * Defaults to `type="search"` and forwards the ref straight to the `<input>`.
 */
export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(function SearchInput(
  { className, iconSize = 16, ...rest },
  ref,
) {
  return (
    <div className="pd-search-field">
      <IconSearch className="pd-search-field-icon" size={iconSize} />
      <Input
        ref={ref}
        type="search"
        className={clsx('pd-search-field-input', className)}
        {...rest}
      />
    </div>
  );
});

export interface CollapsibleSearchProps {
  /** Placeholder text for the field AND the collapsed-trigger label. */
  placeholder?: string;
  /** Current query (controlled input value). */
  value: string;
  /** Fired with the new query string on each keystroke. */
  onChange: (value: string) => void;
  /** Fired with the current query when the user presses Enter. */
  onSubmit?: (value: string) => void;
  /** Controlled expansion; omit to let the component manage it internally. */
  expanded?: boolean;
  /** Initial expansion for the uncontrolled case. */
  defaultExpanded?: boolean;
  /** Notified whenever expansion changes (open on click; close on Escape / blur-when-empty). */
  onExpandedChange?: (expanded: boolean) => void;
  /** Leading magnifying-glass size in px. */
  iconSize?: number;
  className?: string;
}

/**
 * Compact, click-to-expand search (jedd round-8 #2, for the sidebar). Collapsed
 * it reads as a button — a magnifying glass + a muted "Search chats" label; on
 * click it expands into a live search `<input>` IN PLACE (and focuses it). It
 * collapses back to the compact form on Escape, or on blur when the query is
 * empty. The magnifying glass stays visible in both states. Expansion can be
 * controlled (`expanded`/`onExpandedChange`) or left uncontrolled. The forwarded
 * ref points at the underlying `<input>`. Reduced-motion safe (see input.css).
 */
export const CollapsibleSearch = forwardRef<HTMLInputElement, CollapsibleSearchProps>(
  function CollapsibleSearch(
    {
      placeholder = 'Search chats',
      value,
      onChange,
      onSubmit,
      expanded,
      defaultExpanded = false,
      onExpandedChange,
      iconSize = 16,
      className,
    },
    ref,
  ) {
    const [internalExpanded, setInternalExpanded] = useState(defaultExpanded);
    const isExpanded = expanded ?? internalExpanded;
    const inputRef = useRef<HTMLInputElement | null>(null);

    const setExpanded = (next: boolean) => {
      if (expanded === undefined) setInternalExpanded(next);
      onExpandedChange?.(next);
    };

    // Focus the field the moment it expands (via click or a controlled open).
    useEffect(() => {
      if (isExpanded) inputRef.current?.focus();
    }, [isExpanded]);

    if (!isExpanded) {
      return (
        <button
          type="button"
          className={clsx(
            'pd-collapsible-search',
            'pd-collapsible-search--collapsed',
            'pd-focusable',
            className,
          )}
          onClick={() => setExpanded(true)}
        >
          <IconSearch className="pd-collapsible-search-icon" size={iconSize} />
          <span className="pd-collapsible-search-label">{placeholder}</span>
        </button>
      );
    }

    const handleBlur = () => {
      // Collapse back to the compact glass+label only when the field is empty.
      if (value.trim() === '') setExpanded(false);
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setExpanded(false);
        inputRef.current?.blur();
      } else if (event.key === 'Enter') {
        onSubmit?.(value);
      }
    };

    return (
      <div className={clsx('pd-collapsible-search', 'pd-collapsible-search--expanded', className)}>
        <div className="pd-search-field">
          <IconSearch className="pd-search-field-icon" size={iconSize} />
          <input
            ref={(node) => {
              inputRef.current = node;
              if (typeof ref === 'function') ref(node);
              else if (ref) ref.current = node;
            }}
            type="search"
            className="pd-input pd-search-field-input"
            placeholder={placeholder}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
          />
        </div>
      </div>
    );
  },
);

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Grow with content via the invisible grid-mirror (claude composer trick). */
  autoGrow?: boolean;
  /** Chrome-free editor look for hosts that draw their own card (composer). */
  bare?: boolean;
}

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { autoGrow = false, bare = false, className, value, defaultValue, onChange, ...rest },
  ref,
) {
  const [uncontrolled, setUncontrolled] = useState(() =>
    defaultValue === undefined ? '' : String(defaultValue),
  );
  const mirrored = value === undefined ? uncontrolled : String(value);

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    if (value === undefined) setUncontrolled(event.target.value);
    onChange?.(event);
  };

  const textarea = (
    <textarea
      ref={ref}
      className={clsx('pd-textarea', className)}
      value={value}
      defaultValue={defaultValue}
      onChange={handleChange}
      {...rest}
    />
  );

  if (!autoGrow) return textarea;
  return (
    <div className={clsx('pd-autogrow', bare && 'pd-autogrow--bare')} data-value={mirrored}>
      {textarea}
    </div>
  );
});
