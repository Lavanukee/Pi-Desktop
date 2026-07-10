import { clsx } from 'clsx';
import type { CSSProperties, HTMLAttributes, ReactNode } from 'react';
import { forwardRef } from 'react';
import {
  IconChat,
  IconFile,
  IconGlobe,
  IconSearch,
  IconSidebar,
  IconSparkles,
  IconTerminal,
} from './icons.tsx';
import { Slider } from './slider.tsx';

/**
 * Global floor for the icon stroke width, in SVG user units. 1.0 is the
 * thinnest weight that still reads as a hairline glyph; `.pd-icon` mirrors this
 * floor at render time via `max(1, …)`, so nothing draws thinner even if the
 * token is set out of band.
 */
export const ICON_STROKE_MIN = 1;
/** Upper bound of the stroke slider — heavy but not blobby at icon sizes. */
export const ICON_STROKE_MAX = 2.5;

/**
 * Clamp a stroke width into the sane `[ICON_STROKE_MIN, ICON_STROKE_MAX]` range.
 * Use before persisting or writing `--pd-icon-stroke` programmatically so a
 * stale/out-of-range value can never push icons below the 1.0 floor (or absurdly
 * thick). Non-finite input falls back to the minimum.
 */
export function clampIconStroke(
  value: number,
  min: number = ICON_STROKE_MIN,
  max: number = ICON_STROKE_MAX,
): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** A representative sample of stroked glyphs for the live preview row. */
const PREVIEW_ICONS = [
  IconChat,
  IconSearch,
  IconFile,
  IconTerminal,
  IconGlobe,
  IconSparkles,
  IconSidebar,
];

export interface IconStrokeControlProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange'> {
  /** Current icon stroke width, in SVG user units. */
  value: number;
  /** Fired with the new stroke width as the slider moves. */
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label?: ReactNode;
}

/**
 * Settings control for the global icon stroke width. Presentational: the host
 * binds `{value, onChange}` to persist and set `--pd-icon-stroke` on the
 * document root. The preview row scopes the token inline, so its glyphs
 * thin/thicken as the slider moves — a live readout before the host commits.
 */
export const IconStrokeControl = forwardRef<HTMLDivElement, IconStrokeControlProps>(
  function IconStrokeControl(
    {
      value,
      onChange,
      min = ICON_STROKE_MIN,
      max = ICON_STROKE_MAX,
      step = 0.25,
      label = 'Icon stroke width',
      className,
      ...rest
    },
    ref,
  ) {
    // Clamp the incoming value so a stale/programmatic out-of-range prop never
    // shows a sub-floor readout or renders the preview thinner than the floor.
    const safe = clampIconStroke(value, min, max);
    return (
      <div ref={ref} className={clsx('pd-icon-stroke-control', className)} {...rest}>
        <div className="pd-icon-stroke-control-header">
          <span className="pd-icon-stroke-control-label">{label}</span>
          <span className="pd-icon-stroke-control-value">{safe.toFixed(2)}</span>
        </div>
        <Slider
          min={min}
          max={max}
          step={step}
          value={safe}
          aria-label={typeof label === 'string' ? label : 'Icon stroke width'}
          onValueChange={(next) => onChange(clampIconStroke(next, min, max))}
        />
        <div
          className="pd-icon-stroke-control-preview"
          style={{ '--pd-icon-stroke': safe } as CSSProperties}
          aria-hidden="true"
        >
          {PREVIEW_ICONS.map((Glyph) => (
            <Glyph key={Glyph.name} size={22} />
          ))}
        </div>
      </div>
    );
  },
);
