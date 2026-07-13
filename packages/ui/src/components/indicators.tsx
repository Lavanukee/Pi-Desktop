import { clsx } from 'clsx';
import type { HTMLAttributes, SVGProps } from 'react';
import { forwardRef } from 'react';
import { Spinner } from './spinner.tsx';

export interface ProgressBarProps extends HTMLAttributes<HTMLDivElement> {
  /** 0..max; omit (or null) for the indeterminate sweep. */
  value?: number | null;
  max?: number;
}

/** Inverted-monochrome fill on the --pd-bg-track family (design DNA). */
export const ProgressBar = forwardRef<HTMLDivElement, ProgressBarProps>(function ProgressBar(
  { value, max = 1, className, ...rest },
  ref,
) {
  const indeterminate = value === undefined || value === null;
  const fraction = indeterminate ? 0 : Math.min(1, Math.max(0, value / max));
  return (
    <div
      ref={ref}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={max}
      {...(indeterminate ? {} : { 'aria-valuenow': value })}
      className={clsx('pd-progress', indeterminate && 'pd-progress--indeterminate', className)}
      {...rest}
    >
      <div
        className="pd-progress-bar"
        style={indeterminate ? undefined : { width: `${fraction * 100}%` }}
      />
    </div>
  );
});

export interface ContextGaugeProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  /** Context fullness, 0..1. */
  value: number;
  /** Diameter in px — the codex composer donut renders at 16 (spec-model-picker). */
  size?: number;
  tone?: 'muted' | 'warn' | 'danger';
  /** Accessible label; defaults to "N% full" (the codex tooltip copy). */
  label?: string;
}

/**
 * Context-fullness ring, built from the real codex gauge evidence: a 16px SVG
 * donut in --pd-text-muted next to the model selector (spec-model-picker /
 * spec-composer). The tone escalation past ~80% is a Pi affordance, not
 * reference-evidenced — keep muted for parity.
 */
export const ContextGauge = forwardRef<SVGSVGElement, ContextGaugeProps>(function ContextGauge(
  { value, size = 16, tone = 'muted', label, className, ...rest },
  ref,
) {
  const clamped = Math.min(1, Math.max(0, value));
  const strokeWidth = Math.max(1.5, size / 8);
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const text = label ?? `${Math.round(clamped * 100)}% full`;
  return (
    <svg
      ref={ref}
      role="img"
      aria-label={text}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={clsx(
        'pd-gauge',
        tone === 'warn' && 'pd-gauge--warn',
        tone === 'danger' && 'pd-gauge--danger',
        className,
      )}
      {...rest}
    >
      <title>{text}</title>
      <circle
        className="pd-gauge-track"
        cx={size / 2}
        cy={size / 2}
        r={radius}
        strokeWidth={strokeWidth}
      />
      <circle
        className="pd-gauge-arc"
        cx={size / 2}
        cy={size / 2}
        r={radius}
        strokeWidth={strokeWidth}
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - clamped)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
});

export interface WorkingIndicatorProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * The animated status word/phrase ("Working", "Thinking", "Retrying (1/3)…").
   * Kept as a plain string so the tinted label can paint it legibly.
   */
  label: string;
  /**
   * A subtle, STATIC secondary phase word folded in beside the label
   * ("Classifying" / "Reviewing" / "Verifying" …). Rendered muted and un-animated
   * — it enriches the single live indicator with the harness lifecycle stage
   * without a second competing status element (jedd blind-test #1). Omit for none.
   */
  detail?: string;
  /** Elapsed seconds; renders the trailing "· 20s" counter when provided. */
  elapsedSeconds?: number;
  /** Spinner diameter in px (defaults to 12 — the footnote-scale caret loader). */
  spinnerSize?: number;
}

/**
 * Streaming "π working · 20s" indicator: the branded caret loader (Spinner), an
 * animated-tint status label, and an elapsed counter.
 *
 * jedd Wave B #3 — the label KEEPS its legibility while the tint animates. The
 * old streaming label rode the text-clip shimmer (color:transparent +
 * background-clip:text over a low-alpha base), which erased the glyphs as the
 * dim band swept through. Here the glyphs are painted at a solid, readable FLOOR
 * color and a brighter highlight band sweeps ACROSS them (a second,
 * position-pinned background layer holds the floor for the whole cycle), so the
 * tint still moves but letters never vanish. Reduced motion drops the sweep to a
 * static solid label (see .pd-working-label in indicators.css).
 */
export const WorkingIndicator = forwardRef<HTMLDivElement, WorkingIndicatorProps>(
  function WorkingIndicator(
    { label, detail, elapsedSeconds, spinnerSize = 12, className, ...rest },
    ref,
  ) {
    return (
      <div ref={ref} className={clsx('pd-working', className)} {...rest}>
        <Spinner size={spinnerSize} />
        <span className="pd-working-label">{label}</span>
        {detail !== undefined && detail.length > 0 ? (
          <span className="pd-working-detail">· {detail}</span>
        ) : null}
        {elapsedSeconds !== undefined ? (
          <span className="pd-working-elapsed">· {elapsedSeconds}s</span>
        ) : null}
      </div>
    );
  },
);
