import type { ReactElement, ReactNode } from 'react';
import { ContextGauge, ProgressBar } from './indicators.tsx';
import { Tooltip } from './tooltip.tsx';

/** 73000 -> "73k", 940 -> "940". Compact, no decimals (Aside copy style). */
function formatTokens(n: number): string {
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(Math.round(n));
}

export interface ContextGaugeTooltipProps {
  /** Context fullness as a percentage (0..100). */
  percent: number;
  usedTokens: number;
  totalTokens: number;
  /** Compaction note line, e.g. "Pi automatically compacts its context". */
  note?: ReactNode;
  /**
   * Trigger element. Defaults to a ContextGauge donut driven by `percent`
   * (the composer-footer indicator this attaches to).
   */
  children?: ReactElement;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  delayDuration?: number;
  /** Force-open for galleries/screenshots. */
  open?: boolean;
  defaultOpen?: boolean;
}

/**
 * Context-fullness hover card (jedd round-1 feedback #1). On hover of the
 * context gauge it reveals an Aside-style compact card: fullness %, used/total
 * tokens, and an optional compaction note — reusing our Tooltip surface but
 * restyled to the overlay card look via `.pd-context-tooltip`.
 */
export function ContextGaugeTooltip({
  percent,
  usedTokens,
  totalTokens,
  note,
  children,
  side = 'top',
  align = 'end',
  delayDuration = 100,
  open,
  defaultOpen,
}: ContextGaugeTooltipProps) {
  const rounded = Math.round(percent);
  return (
    <Tooltip
      className="pd-context-tooltip"
      side={side}
      align={align}
      delayDuration={delayDuration}
      open={open}
      defaultOpen={defaultOpen}
      label={
        <span className="pd-context-card">
          <ProgressBar value={rounded} max={100} className="pd-context-card-bar" />
          <span className="pd-context-card-line">Context window: {rounded}% full</span>
          {/* Token counts only when the window is known — a percent-only source
           * (pi's own accounting on a remote/AFM model) has no token totals, so
           * the "0 / 0 tokens" line is suppressed rather than shown as a lie. */}
          {totalTokens > 0 ? (
            <span className="pd-context-card-line pd-context-card-line--muted">
              {formatTokens(usedTokens)} / {formatTokens(totalTokens)} tokens used
            </span>
          ) : null}
          {note !== undefined ? <span className="pd-context-card-note">{note}</span> : null}
        </span>
      }
    >
      {children ?? <ContextGauge value={rounded / 100} tabIndex={0} />}
    </Tooltip>
  );
}
