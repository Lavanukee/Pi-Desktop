import { clsx } from 'clsx';
import type { HTMLAttributes, KeyboardEvent, ReactNode } from 'react';
import { forwardRef, useEffect, useRef, useState } from 'react';
import { Button } from './button.tsx';
import { Kbd } from './chip.tsx';
import { IconArrowUp, IconCheck, IconInfo, IconPencil } from './icons.tsx';
import { Input, TextArea } from './input.tsx';
import { Slider } from './slider.tsx';
import { Tooltip } from './tooltip.tsx';

/*
 * Question UI — the agent asks the user (jedd blind-test #26/#27). A COMPACT
 * INLINE card (host anchors it just above the composer — it is NOT a full-screen
 * modal), modelled on Claude's inline ask card:
 *   - choice: a title, numbered option rows (1/2/3…), a "Something else" free
 *     row (pencil) that expands inline, a Skip affordance, an "Or reply
 *     directly…" mini-composer, and a "↑↓ navigate · Enter select" footer hint.
 *     Arrow / Enter / number-key navigation drives the option list.
 *   - free:   a textarea.
 *   - slider: a range input with a live value readout.
 * onSubmit receives a discriminated QuestionAnswer the host can switch on; the
 * free rows (Something else / reply directly) emit a `free` answer so the host
 * never has to special-case them.
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
    cancelLabel = 'Skip',
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
  // "Something else" free row (choice mode) — expands inline on demand.
  const [elaborating, setElaborating] = useState(false);
  const [elaborateText, setElaborateText] = useState('');
  // "Or reply directly…" mini-composer (choice mode).
  const [replyText, setReplyText] = useState('');
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const elaborateRef = useRef<HTMLInputElement>(null);

  // Land keyboard focus on the first option so arrow / Enter / number keys work
  // without a click the moment the card appears. Reads the ref length (not the
  // `options` prop) so it stays a mount / mode-flip effect.
  useEffect(() => {
    if (mode === 'choice' && optionRefs.current.length > 0) optionRefs.current[0]?.focus();
  }, [mode]);

  useEffect(() => {
    if (elaborating) elaborateRef.current?.focus();
  }, [elaborating]);

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

  const submitFree = (raw: string) => {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return;
    onSubmit?.({ mode: 'free', text: trimmed });
  };

  const resolvedSubmitLabel =
    submitLabel ?? (mode === 'choice' && multiple ? 'Submit answers' : 'Submit');

  const footer = (showHint: boolean) => (
    <div className="pd-question-footer">
      {showHint ? (
        <div className="pd-question-nav-hint">
          <Kbd keys="↑↓" appearance="bare" /> navigate
          <span className="pd-question-hint-sep" aria-hidden="true">
            ·
          </span>
          <Kbd keys="Enter" appearance="bare" /> select
        </div>
      ) : (
        <span />
      )}
      <div className="pd-question-actions">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button variant="accent" size="sm" disabled={!canSubmit} onClick={submit}>
          {resolvedSubmitLabel}
        </Button>
      </div>
    </div>
  );

  return (
    <div ref={ref} className={clsx('pd-question', className)} {...rest}>
      <div className="pd-question-title">{question}</div>

      {mode === 'choice' ? (
        <>
          <div className="pd-question-choices">
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
                    className={clsx(
                      'pd-question-option',
                      selected && 'pd-question-option--selected',
                    )}
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

            {/* "Something else" — a free answer that isn't one of the options. */}
            {elaborating ? (
              <div className="pd-question-option pd-question-custom pd-question-custom--open">
                <span className="pd-question-number pd-question-number--icon">
                  <IconPencil size={13} />
                </span>
                <Input
                  ref={elaborateRef}
                  className="pd-question-custom-input"
                  value={elaborateText}
                  placeholder={placeholder}
                  aria-label="Something else"
                  onChange={(event) => setElaborateText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      submitFree(elaborateText);
                    } else if (event.key === 'Escape') {
                      event.stopPropagation();
                      setElaborating(false);
                      setElaborateText('');
                    }
                  }}
                />
                <button
                  type="button"
                  className="pd-question-send"
                  aria-label="Send"
                  disabled={elaborateText.trim().length === 0}
                  onClick={() => submitFree(elaborateText)}
                >
                  <IconArrowUp size={14} />
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="pd-question-option pd-question-custom"
                onClick={() => setElaborating(true)}
              >
                <span className="pd-question-number pd-question-number--icon">
                  <IconPencil size={13} />
                </span>
                <span className="pd-question-option-label pd-question-option-label--muted">
                  Something else…
                </span>
                <span className="pd-question-trailing">
                  <span className="pd-question-enter">
                    <Kbd keys="↵" appearance="bare" />
                  </span>
                </span>
              </button>
            )}
          </div>

          {/* "Or reply directly…" — a mini-composer answering in prose. */}
          <div className="pd-question-reply">
            <Input
              className="pd-question-reply-input"
              value={replyText}
              placeholder="Or reply directly…"
              aria-label="Reply directly"
              onChange={(event) => setReplyText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  submitFree(replyText);
                }
              }}
            />
            <button
              type="button"
              className="pd-question-send"
              aria-label="Send reply"
              disabled={replyText.trim().length === 0}
              onClick={() => submitFree(replyText)}
            >
              <IconArrowUp size={14} />
            </button>
          </div>

          {footer(true)}
        </>
      ) : null}

      {mode === 'free' ? (
        <>
          <TextArea
            rows={3}
            value={text}
            placeholder={placeholder}
            aria-label="Your answer"
            onChange={(event) => setText(event.target.value)}
          />
          {footer(false)}
        </>
      ) : null}

      {mode === 'slider' ? (
        <>
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
          {footer(false)}
        </>
      ) : null}
    </div>
  );
});
