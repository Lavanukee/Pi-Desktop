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
  /** Whether Auto is active: lights the "Auto" toggle; a drag flips to a pinned
   * level. The fill/knob position is always driven by `fill`, not this flag. */
  auto: boolean;
  /** The header readout shown accent-lit at the top of the panel:
   * "Effort · Auto" (auto) or "Effort · High" (a pinned level). */
  label: string;
  /** Screen-reader value text (defaults to `label`). */
  valueText?: string;
  /** Text for the Auto toggle (default "Auto"). */
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
 * EffortSlider — the composer effort control (jedd #6), restyled round-16 to the
 * Claude "thinking effort" look: a titled popover panel with the active readout
 * accent-lit up top beside a "?" help affordance, a horizontal track carrying a
 * dithered/textured heat fill (cool blue → hot near Max) and a clean white knob,
 * flanked by "Faster" / "Smarter" end labels, with a subtle "Auto" toggle below.
 *
 * Purely presentational + controlled: the app maps detents ↔ effort levels and
 * Auto ↔ the active model tier, passing the resolved `fill`/`label` in and taking
 * `onLevelChange`/`onAuto` out — the value logic is unchanged by the restyle.
 *
 * Accessible: the track is a `role="slider"` driven by arrows/Home/End as well
 * as pointer drag; the fill/knob transitions honor reduced-motion (CSS).
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
      {/* Header: the active readout (accent-lit) + a "?" help affordance. */}
      <div className="pd-effort-head">
        <span
          className="pd-effort-name"
          data-testid={testId !== undefined ? `${testId}-value` : undefined}
        >
          {label}
        </span>
        <button
          type="button"
          className="pd-effort-help"
          aria-label="How effort works"
          title="Higher effort spends more time reasoning before answering. Auto matches the effort to each request."
        >
          ?
        </button>
      </div>

      {/* Scale: Faster ── track ── Smarter. */}
      <div className="pd-effort-scale">
        <span className="pd-effort-flank" aria-hidden="true">
          Faster
        </span>
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
        <span className="pd-effort-flank" aria-hidden="true">
          Smarter
        </span>
      </div>

      {/* Footer: the Auto ↔ pinned-level toggle (lit while Auto is active). */}
      <div className="pd-effort-foot">
        <button
          type="button"
          className="pd-effort-auto"
          data-active={auto ? '' : undefined}
          aria-pressed={auto}
          onClick={onAuto}
          data-testid={testId !== undefined ? `${testId}-auto` : undefined}
        >
          {autoLabel}
        </button>
      </div>
    </div>
  );
}
