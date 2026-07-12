import { clsx } from 'clsx';
import type { HTMLAttributes, ReactNode } from 'react';
import { forwardRef } from 'react';
import { Button, IconButton } from './button.tsx';
import { useCopyFeedback } from './copy-button.tsx';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from './dropdown-menu.tsx';
import {
  IconCheck,
  IconCopy,
  IconGauge,
  IconMore,
  IconPencil,
  IconRefresh,
  IconShare,
  IconSpeed,
  IconThumbDown,
  IconThumbUp,
} from './icons.tsx';
import { Tooltip } from './tooltip.tsx';

/*
 * Under-message action bar + footnotes (jedd round-1 feedback #6). A row of
 * hover-revealed message controls (Copy / feedback / Retry / Edit / Share /
 * Context token count / "…" overflow) and small assistant-message footnotes
 * (response speed, model name). Presentational — every action is opt-in via a
 * handler prop; drop the bar into MessageRow's `actions` slot for hover-reveal.
 */

/** 1240 -> "1.2k", 940 -> "940". */
function formatCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(Math.round(n));
}

export interface MessageActionsProps extends HTMLAttributes<HTMLDivElement> {
  onCopy?: () => void;
  onThumbsUp?: () => void;
  onThumbsDown?: () => void;
  onRetry?: () => void;
  /** User messages only. */
  onEdit?: () => void;
  onShare?: () => void;
  /** Token count consumed by this message; renders the Context chip when set. */
  tokenCount?: number;
  onContext?: () => void;
  /**
   * Response throughput (tok/s) for this message; renders the speed readout as a
   * bar item (jedd Wave B #2 — speed moved off the pinned footnote INTO the bar).
   */
  tokensPerSecond?: number;
  /** Prefix the speed value with "~" (default true). */
  approxSpeed?: boolean;
  /** Extra rows for the "…" overflow menu (DropdownMenuItem elements). */
  overflow?: ReactNode;
}

/**
 * The under-message action bar is scaled up ~1.5× (jedd Wave B #1: bigger touch
 * targets + glyphs). The button/chip geometry rides message-actions.css; icons
 * carry the matching 1.5× pixel size (14 → 21) so the SVG attrs stay in step
 * with the enlarged controls even before CSS loads.
 */
const BAR_ICON = 21;

export const MessageActions = forwardRef<HTMLDivElement, MessageActionsProps>(
  function MessageActions(
    {
      onCopy,
      onThumbsUp,
      onThumbsDown,
      onRetry,
      onEdit,
      onShare,
      tokenCount,
      onContext,
      tokensPerSecond,
      approxSpeed = true,
      overflow,
      className,
      ...rest
    },
    ref,
  ) {
    // Shared copy→check feedback (round-5 #21). The caller still owns the actual
    // clipboard write via onCopy; the hook just flips the glyph for ~2s.
    const { copied, copy } = useCopyFeedback();
    return (
      <div ref={ref} className={clsx('pd-msg-action-bar', className)} {...rest}>
        {onCopy !== undefined ? (
          <Tooltip label={copied ? 'Copied' : 'Copy'}>
            <IconButton
              size="sm"
              variant="ghostMuted"
              aria-label={copied ? 'Copied' : 'Copy message'}
              data-copied={copied}
              onClick={() => {
                onCopy();
                copy();
              }}
            >
              {copied ? <IconCheck size={BAR_ICON} /> : <IconCopy size={BAR_ICON} />}
            </IconButton>
          </Tooltip>
        ) : null}
        {onThumbsUp !== undefined ? (
          <Tooltip label="Good response">
            <IconButton
              size="sm"
              variant="ghostMuted"
              aria-label="Good response"
              onClick={onThumbsUp}
            >
              <IconThumbUp size={BAR_ICON} />
            </IconButton>
          </Tooltip>
        ) : null}
        {onThumbsDown !== undefined ? (
          <Tooltip label="Bad response">
            <IconButton
              size="sm"
              variant="ghostMuted"
              aria-label="Bad response"
              onClick={onThumbsDown}
            >
              <IconThumbDown size={BAR_ICON} />
            </IconButton>
          </Tooltip>
        ) : null}
        {onRetry !== undefined ? (
          <Tooltip label="Retry">
            <IconButton size="sm" variant="ghostMuted" aria-label="Retry" onClick={onRetry}>
              <IconRefresh size={BAR_ICON} />
            </IconButton>
          </Tooltip>
        ) : null}
        {onEdit !== undefined ? (
          <Tooltip label="Edit">
            <IconButton size="sm" variant="ghostMuted" aria-label="Edit message" onClick={onEdit}>
              <IconPencil size={BAR_ICON} />
            </IconButton>
          </Tooltip>
        ) : null}
        {onShare !== undefined ? (
          <Tooltip label="Share">
            <IconButton size="sm" variant="ghostMuted" aria-label="Share" onClick={onShare}>
              <IconShare size={BAR_ICON} />
            </IconButton>
          </Tooltip>
        ) : null}
        {tokensPerSecond !== undefined ? (
          <Tooltip label="Response speed">
            <span className="pd-msg-speed" data-testid="msg-speed">
              <span className="pd-msg-speed-icon">
                <IconSpeed size={BAR_ICON} />
              </span>
              {approxSpeed ? '~' : ''}
              {Math.round(tokensPerSecond)} tok/s
            </span>
          </Tooltip>
        ) : null}
        {tokenCount !== undefined ? (
          <Tooltip label="Tokens used by this message">
            <Button
              size="sm"
              variant="ghostMuted"
              className="pd-msg-context"
              onClick={onContext}
              disabled={onContext === undefined}
            >
              <IconGauge size={BAR_ICON} />
              {formatCount(tokenCount)}
            </Button>
          </Tooltip>
        ) : null}
        {overflow !== undefined ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton size="sm" variant="ghostMuted" aria-label="More actions">
                <IconMore size={BAR_ICON} />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">{overflow}</DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    );
  },
);

export interface MessageFootnoteProps extends HTMLAttributes<HTMLSpanElement> {
  icon?: ReactNode;
}

/** Small muted footnote under a message (base for speed/model footnotes). */
export const MessageFootnote = forwardRef<HTMLSpanElement, MessageFootnoteProps>(
  function MessageFootnote({ icon, className, children, ...rest }, ref) {
    return (
      <span ref={ref} className={clsx('pd-msg-footnote', className)} {...rest}>
        {icon !== undefined ? <span className="pd-msg-footnote-icon">{icon}</span> : null}
        {children}
      </span>
    );
  },
);

export interface ResponseSpeedProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  tokensPerSecond: number;
  /** Prefix the value with "~" (default true). */
  approx?: boolean;
}

/** Assistant-message response-speed footnote: "~180 tok/s" (ref img4). */
export const ResponseSpeed = forwardRef<HTMLSpanElement, ResponseSpeedProps>(function ResponseSpeed(
  { tokensPerSecond, approx = true, className, ...rest },
  ref,
) {
  return (
    <MessageFootnote
      ref={ref}
      className={clsx('pd-msg-footnote--speed', className)}
      icon={<IconSpeed size={12} />}
      {...rest}
    >
      {approx ? '~' : ''}
      {Math.round(tokensPerSecond)} tok/s
    </MessageFootnote>
  );
});

export interface ModelFootnoteProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  model: ReactNode;
}

/** Model-name footnote style under an assistant message. */
export const ModelFootnote = forwardRef<HTMLSpanElement, ModelFootnoteProps>(function ModelFootnote(
  { model, className, ...rest },
  ref,
) {
  return (
    <MessageFootnote ref={ref} className={clsx('pd-msg-footnote--model', className)} {...rest}>
      {model}
    </MessageFootnote>
  );
});
