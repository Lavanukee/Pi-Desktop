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
      min = 1,
      max = 2.5,
      step = 0.25,
      label = 'Icon stroke width',
      className,
      ...rest
    },
    ref,
  ) {
    return (
      <div ref={ref} className={clsx('pd-icon-stroke-control', className)} {...rest}>
        <div className="pd-icon-stroke-control-header">
          <span className="pd-icon-stroke-control-label">{label}</span>
          <span className="pd-icon-stroke-control-value">{value.toFixed(2)}</span>
        </div>
        <Slider
          min={min}
          max={max}
          step={step}
          value={value}
          aria-label={typeof label === 'string' ? label : 'Icon stroke width'}
          onValueChange={onChange}
        />
        <div
          className="pd-icon-stroke-control-preview"
          style={{ '--pd-icon-stroke': value } as CSSProperties}
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
