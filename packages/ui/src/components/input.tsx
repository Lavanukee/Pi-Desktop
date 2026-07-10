import { clsx } from 'clsx';
import type { ChangeEvent, InputHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { forwardRef, useState } from 'react';
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
