import { clsx } from 'clsx';
import type { HTMLAttributes, SVGProps } from 'react';
import { forwardRef } from 'react';

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
