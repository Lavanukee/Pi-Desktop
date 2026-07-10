import { clsx } from 'clsx';
import type { HTMLAttributes, KeyboardEvent, ReactNode } from 'react';
import { forwardRef } from 'react';
import { IconArrowUp } from './icons.tsx';
import { TextArea } from './input.tsx';

export interface ComposerProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onSubmit'> {
  value: string;
  onValueChange?: (value: string) => void;
  onSubmit?: () => void;
  placeholder?: string;
  disabled?: boolean;
  /**
   * Codex-only cmdk tray docked on top, fusing into the card (spec-composer
   * structural divergence #1). The claude app simply never passes it.
   */
  topTray?: ReactNode;
  /** Row of AttachmentPill. */
  attachments?: ReactNode;
  /** Toolbar left cluster (attach button, mode selector) — app config slot. */
  leading?: ReactNode;
  /** Toolbar right cluster (model picker, gauge, mic) — app config slot. */
  trailing?: ReactNode;
  /**
   * sendButtonAlwaysVisible flavor flag (spec-composer divergence #3): codex
   * shows the 28px send circle always; claude hides it while empty.
   */
  showSend?: boolean;
  canSend?: boolean;
  sendLabel?: string;
  inputLabel?: string;
}

/**
 * Composer — spec-composer.md. One card for both flavors: radius
 * --pd-radius-surface, translucency/blur tokens, hairline+shadow elevation,
 * claude-only focus-within border upgrade (CSS). Presentational — W3 wires
 * engine state into the slots.
 */
export const Composer = forwardRef<HTMLDivElement, ComposerProps>(function Composer(
  {
    value,
    onValueChange,
    onSubmit,
    placeholder = 'Message Pi…',
    disabled = false,
    topTray,
    attachments,
    leading,
    trailing,
    showSend = true,
    canSend,
    sendLabel = 'Send message',
    inputLabel = 'Message input',
    className,
    ...rest
  },
  ref,
) {
  const sendEnabled = canSend ?? value.trim().length > 0;

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (sendEnabled && !disabled) onSubmit?.();
    }
  };

  return (
    <div ref={ref} className={clsx('pd-composer-root', className)} {...rest}>
      {topTray !== undefined ? <div className="pd-composer-tray">{topTray}</div> : null}
      <div className="pd-composer">
        {attachments !== undefined ? (
          <div className="pd-composer-attachments">{attachments}</div>
        ) : null}
        <div className="pd-composer-editor pd-scroll">
          <TextArea
            autoGrow
            bare
            rows={1}
            value={value}
            placeholder={placeholder}
            disabled={disabled}
            aria-label={inputLabel}
            onChange={(event) => onValueChange?.(event.target.value)}
            onKeyDown={handleKeyDown}
          />
        </div>
        <div className="pd-composer-footer">
          {leading}
          <div className="pd-composer-footer-spacer" />
          {trailing}
          {showSend ? (
            <button
              type="button"
              className="pd-btn pd-btn--primary pd-icon-btn pd-btn--circle pd-composer-send"
              aria-label={sendLabel}
              disabled={disabled || !sendEnabled}
              onClick={() => onSubmit?.()}
            >
              <IconArrowUp size={14} />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
});

/** 1x16px toolbar divider (codex footer). */
export function ComposerDivider() {
  return <span className="pd-composer-divider" aria-hidden="true" />;
}
