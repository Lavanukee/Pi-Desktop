import { clsx } from 'clsx';
import type { HTMLAttributes, KeyboardEvent, ReactNode } from 'react';
import { forwardRef, useRef, useState } from 'react';
import { Button } from './button.tsx';
import { Kbd } from './chip.tsx';
import { IconCheck, IconInfo } from './icons.tsx';
import { TextArea } from './input.tsx';
import { Slider } from './slider.tsx';
import { Tooltip } from './tooltip.tsx';

/*
 * Question UI — agent asks the user (jedd round-1 feedback #8, Aside "Demo
 * question"). One QuestionCard with a `mode` API:
 *   - choice: numbered options, single or multi select, per-row info icon,
 *     up/down/enter + number-key keyboard affordances
 *   - free:   a textarea
 *   - slider: a range input with a live value readout
 * onSubmit receives a discriminated QuestionAnswer the host can switch on.
 */

export type QuestionMode = 'choice' | 'free' | 'slider';

export interface QuestionOption {
  value: string;
  label: ReactNode;
  /** Info-icon tooltip content for this option. */
  info?: ReactNode;
}

export type QuestionAnswer =
  | { mode: 'choice'; values: string[] }
  | { mode: 'free'; text: string }
  | { mode: 'slider'; value: number };

export interface QuestionCardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onSubmit'> {
  question: ReactNode;
  mode?: QuestionMode;
  /* choice */
  options?: QuestionOption[];
  multiple?: boolean;
  defaultValues?: string[];
  /* slider */
  min?: number;
  max?: number;
  step?: number;
  defaultValue?: number;
  /* free */
  placeholder?: string;
  defaultText?: string;
  /* shared */
  submitLabel?: string;
  cancelLabel?: string;
  onSubmit?: (answer: QuestionAnswer) => void;
  onCancel?: () => void;
}

export const QuestionCard = forwardRef<HTMLDivElement, QuestionCardProps>(function QuestionCard(
  {
    question,
    mode = 'choice',
    options = [],
    multiple = false,
    defaultValues,
    min = 0,
    max = 100,
    step = 1,
    defaultValue,
    placeholder = 'Type your answer…',
    defaultText = '',
    submitLabel,
    cancelLabel = 'Cancel',
    onSubmit,
    onCancel,
    className,
    ...rest
  },
  ref,
) {
  const [values, setValues] = useState<string[]>(defaultValues ?? []);
  const [text, setText] = useState(defaultText);
  const [sliderValue, setSliderValue] = useState(defaultValue ?? min);
  const [active, setActive] = useState(0);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const toggle = (value: string) => {
    setValues((prev) => {
      if (!multiple) return prev.includes(value) ? [] : [value];
      return prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value];
    });
  };

  const focusOption = (index: number) => {
    const next = (index + options.length) % options.length;
    setActive(next);
    optionRefs.current[next]?.focus();
  };

  const onOptionsKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (options.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusOption(active + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusOption(active - 1);
    } else if (/^[1-9]$/.test(event.key)) {
      const index = Number(event.key) - 1;
      const option = options[index];
      if (option !== undefined) {
        toggle(option.value);
        focusOption(index);
      }
    }
  };

  const canSubmit =
    mode === 'choice' ? values.length > 0 : mode === 'free' ? text.trim().length > 0 : true;

  const submit = () => {
    if (mode === 'choice') onSubmit?.({ mode: 'choice', values });
    else if (mode === 'free') onSubmit?.({ mode: 'free', text });
    else onSubmit?.({ mode: 'slider', value: sliderValue });
  };

  const resolvedSubmitLabel =
    submitLabel ?? (mode === 'choice' && multiple ? 'Submit answers' : 'Submit');

  return (
    <div ref={ref} className={clsx('pd-question', className)} {...rest}>
      <div className="pd-question-title">{question}</div>

      {mode === 'choice' ? (
        <>
          <div
            className="pd-question-options"
            role="listbox"
            aria-multiselectable={multiple || undefined}
            onKeyDown={onOptionsKeyDown}
          >
            {options.map((option, index) => {
              const selected = values.includes(option.value);
              return (
                <button
                  key={option.value}
                  type="button"
                  ref={(node) => {
                    optionRefs.current[index] = node;
                  }}
                  role="option"
                  aria-selected={selected}
                  tabIndex={index === active ? 0 : -1}
                  className={clsx('pd-question-option', selected && 'pd-question-option--selected')}
                  onClick={() => toggle(option.value)}
                  onFocus={() => setActive(index)}
                >
                  <span className="pd-question-number">{index + 1}</span>
                  <span className="pd-question-option-label">{option.label}</span>
                  {option.info !== undefined ? (
                    <Tooltip label={option.info} side="top">
                      <span className="pd-question-info" role="img" aria-label="More info">
                        <IconInfo size={14} />
                      </span>
                    </Tooltip>
                  ) : null}
                  <span className="pd-question-trailing">
                    {selected ? (
                      <IconCheck size={14} />
                    ) : (
                      <span className="pd-question-enter">
                        <Kbd keys="↵" appearance="bare" />
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="pd-question-nav-hint">
            <Kbd keys="↑↓" appearance="bare" /> move
            <Kbd keys="↵" appearance="bare" /> select
          </div>
        </>
      ) : null}

      {mode === 'free' ? (
        <TextArea
          rows={3}
          value={text}
          placeholder={placeholder}
          aria-label="Your answer"
          onChange={(event) => setText(event.target.value)}
        />
      ) : null}

      {mode === 'slider' ? (
        <div className="pd-question-slider-row">
          <Slider
            min={min}
            max={max}
            step={step}
            value={sliderValue}
            aria-label="Value"
            onValueChange={setSliderValue}
          />
          <span className="pd-question-value">{sliderValue}</span>
        </div>
      ) : null}

      <div className="pd-question-footer">
        <Button variant="ghost" onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button variant="accent" disabled={!canSubmit} onClick={submit}>
          {resolvedSubmitLabel}
        </Button>
      </div>
    </div>
  );
});
