import { clsx } from 'clsx';
import type { InputHTMLAttributes } from 'react';
import { forwardRef } from 'react';

export interface SliderProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> {
  /** Current value (controlled). */
  value: number;
  min?: number;
  max?: number;
  step?: number;
  /** Fired with the parsed numeric value as the slider moves. */
  onValueChange?: (value: number) => void;
}

/**
 * Range slider — the inverted-mono thumb on a tokenized track, extracted from
 * QuestionCard so any control can reuse it (see styles/slider.css). Controlled
 * and presentational: `value` in, `onValueChange(number)` out.
 */
export const Slider = forwardRef<HTMLInputElement, SliderProps>(function Slider(
  { value, min = 0, max = 100, step = 1, onValueChange, className, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      type="range"
      className={clsx('pd-slider', className)}
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(event) => onValueChange?.(Number(event.target.value))}
      {...rest}
    />
  );
});
