import { clsx } from 'clsx';
import type { HTMLAttributes, KeyboardEvent, ReactNode } from 'react';
import { forwardRef, useEffect, useRef, useState } from 'react';
import { Button } from './button.tsx';
import { IconChevronLeft, IconChevronRight } from './icons.tsx';
import { TextArea } from './input.tsx';

/*
 * Inline message editing + branch switching (round-3 #P3). Clicking Edit on a
 * user message flips THAT bubble into an editable textarea (Save/Cancel) rather
 * than reopening the composer; saving forks a new branch. A message with
 * alternates shows a `‹ n / m ›` switcher alongside copy/edit.
 */

export interface EditableMessageProps
  extends Omit<HTMLAttributes<HTMLDivElement>, 'onSubmit' | 'children'> {
  /** The message text (shown in the bubble, and prefilled into the editor). */
  value: string;
  /** When true the bubble is replaced by the textarea editor. */
  editing?: boolean;
  /** Fired with the edited text when Save is pressed (⌘/Ctrl+Enter also saves). */
  onSave?: (text: string) => void;
  /** Fired when Cancel is pressed (Esc also cancels). */
  onCancel?: () => void;
  saveLabel?: ReactNode;
  cancelLabel?: ReactNode;
}

/**
 * A user message bubble that flips to an in-place editor. Renders the same
 * right-aligned, user-bubble look; in edit mode the bubble becomes a textarea
 * (prefilled) with Save + Cancel.
 */
export const EditableMessage = forwardRef<HTMLDivElement, EditableMessageProps>(
  function EditableMessage(
    {
      value,
      editing = false,
      onSave,
      onCancel,
      saveLabel = 'Save',
      cancelLabel = 'Cancel',
      className,
      ...rest
    },
    ref,
  ) {
    const [draft, setDraft] = useState(value);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    // Re-seed the draft from the source text, and focus the field, each time we
    // (re-)enter edit mode.
    useEffect(() => {
      if (editing) {
        setDraft(value);
        textareaRef.current?.focus();
      }
    }, [editing, value]);

    const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        onSave?.(draft);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        onCancel?.();
      }
    };

    return (
      <div
        ref={ref}
        className={clsx('pd-msg pd-msg--user pd-editable', className)}
        data-editing={editing || undefined}
        {...rest}
      >
        {editing ? (
          <div className="pd-editable-box">
            <TextArea
              ref={textareaRef}
              autoGrow
              bare
              className="pd-editable-input"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleKeyDown}
              aria-label="Edit message"
            />
            <div className="pd-editable-actions">
              <Button size="sm" variant="ghost" onClick={() => onCancel?.()}>
                {cancelLabel}
              </Button>
              <Button size="sm" variant="primary" onClick={() => onSave?.(draft)}>
                {saveLabel}
              </Button>
            </div>
          </div>
        ) : (
          <div className="pd-msg-bubble">{value}</div>
        )}
      </div>
    );
  },
);

export interface BranchSwitcherProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onSelect'> {
  /** Zero-based index of the active branch. */
  index: number;
  /** Total number of branches. */
  total: number;
  onPrev?: () => void;
  onNext?: () => void;
}

/** `‹ n / m ›` branch switcher — sits with copy/edit under a message. */
export const BranchSwitcher = forwardRef<HTMLDivElement, BranchSwitcherProps>(
  function BranchSwitcher({ index, total, onPrev, onNext, className, ...rest }, ref) {
    const atStart = index <= 0;
    const atEnd = index >= total - 1;
    return (
      <div ref={ref} className={clsx('pd-branch-switcher', className)} {...rest}>
        <button
          type="button"
          className="pd-branch-arrow pd-focusable"
          aria-label="Previous version"
          disabled={atStart}
          onClick={onPrev}
        >
          <IconChevronLeft size={13} />
        </button>
        <span className="pd-branch-count">
          {index + 1} / {total}
        </span>
        <button
          type="button"
          className="pd-branch-arrow pd-focusable"
          aria-label="Next version"
          disabled={atEnd}
          onClick={onNext}
        >
          <IconChevronRight size={13} />
        </button>
      </div>
    );
  },
);
