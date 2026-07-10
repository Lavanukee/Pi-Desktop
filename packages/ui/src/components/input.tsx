import { clsx } from 'clsx';
import type { ChangeEvent, InputHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { forwardRef, useState } from 'react';

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

/** Single-line field — spec-composer/spec-settings input recipes. */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, ...rest },
  ref,
) {
  return <input ref={ref} className={clsx('pd-input', className)} {...rest} />;
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
