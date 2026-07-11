import { clsx } from 'clsx';
import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useRef,
} from 'react';

export interface EffortSliderProps {
  /** Number of discrete detents (e.g. 4 for low/medium/high/max). */
  steps: number;
  /** The current explicit detent index (0..steps-1) — drives aria + keyboard. */
  value: number;
  /** Visual fill fraction (0..1). In Auto this is the active tier's level; in
   * an explicit level it is that level's position. Kept separate from `value`
   * so the app maps Auto ↔ tier without the component knowing about tiers. */
  fill: number;
  /** Auto mode: the readout shows `label` on the Auto affordance and a drag
   * flips to an explicit level. */
  auto: boolean;
  /** Active-mode readout text: "Auto · balanced" (auto) or "High" (level). */
  label: string;
  /** Screen-reader value text (defaults to `label`). */
  valueText?: string;
  /** Text for the Auto affordance when NOT active (default "Auto"). */
  autoLabel?: string;
  /** Fired with the detent index the user dragged/keyed to (flips to level). */
  onLevelChange: (index: number) => void;
  /** Fired when the user activates the leftmost Auto affordance. */
  onAuto: () => void;
  className?: string;
  'data-testid'?: string;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Map a 0..1 track fraction to the nearest detent index (0..steps-1). Pure so
 * the pointer-drag math is unit-testable without a DOM.
 */
export function pointerToIndex(fraction: number, steps: number): number {
  if (steps <= 1 || !Number.isFinite(fraction)) return 0;
  const idx = Math.round(clamp01(fraction) * (steps - 1));
  return Math.min(steps - 1, Math.max(0, idx));
}

/**
 * EffortSlider — the round-12 composer effort control (jedd #6): a chunky BLUE
 * fill-pill that fills left→right (least→most effort), a leftmost Auto
 * affordance, and a level readout. Purely presentational + controlled: the app
 * maps detents ↔ effort levels and Auto ↔ the active model tier, passing the
 * resolved `fill`/`label` in and taking `onLevelChange`/`onAuto` out.
 *
 * Accessible: the track is a `role="slider"` driven by arrows/Home/End as well
 * as pointer drag; the blue fill/thumb transitions honor reduced-motion (CSS).
 */
export function EffortSlider({
  steps,
  value,
  fill,
  auto,
  label,
  valueText,
  autoLabel = 'Auto',
  onLevelChange,
  onAuto,
  className,
  'data-testid': testId,
}: EffortSliderProps): ReactNode {
  const trackRef = useRef<HTMLDivElement>(null);
  const max = Math.max(1, steps - 1);
  const pct = `${clamp01(fill) * 100}%`;

  const setFromClientX = useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      if (el === null) return;
      const rect = el.getBoundingClientRect();
      const fraction = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
      onLevelChange(pointerToIndex(fraction, steps));
    },
    [onLevelChange, steps],
  );

  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setFromClientX(e.clientX);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    setFromClientX(e.clientX);
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    let next: number;
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowUp':
        next = Math.min(max, value + 1);
        break;
      case 'ArrowLeft':
      case 'ArrowDown':
        next = Math.max(0, value - 1);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = max;
        break;
      default:
        return;
    }
    e.preventDefault();
    onLevelChange(next);
  };

  return (
    <div
      className={clsx('pd-effort', className)}
      data-auto={auto ? '' : undefined}
      data-testid={testId}
    >
      <button
        type="button"
        className="pd-effort-auto"
        data-active={auto ? '' : undefined}
        aria-pressed={auto}
        onClick={onAuto}
        data-testid={testId !== undefined ? `${testId}-auto` : undefined}
      >
        {auto ? label : autoLabel}
      </button>
      <div
        ref={trackRef}
        className="pd-effort-track"
        role="slider"
        tabIndex={0}
        aria-label="Effort level"
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={valueText ?? label}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <div
          className="pd-effort-fill"
          style={{ width: pct, ['--pd-effort-heat' as string]: clamp01(fill) } as CSSProperties}
        >
          <span className="pd-effort-knob" aria-hidden="true" />
        </div>
      </div>
      {auto ? null : (
        <span
          className="pd-effort-value"
          data-testid={testId !== undefined ? `${testId}-value` : undefined}
        >
          {label}
        </span>
      )}
    </div>
  );
}
