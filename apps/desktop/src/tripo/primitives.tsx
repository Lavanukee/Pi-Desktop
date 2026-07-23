/**
 * Small UI primitives for the Tripo workspace — anchored popover, switch,
 * segmented control, slider row, menu item. Hand-rolled (not @pi-desktop/ui)
 * so the workspace can match the reference's density/geometry exactly while
 * still drawing every color from the pd token set via tripo.css.
 */
import type { JSX, ReactNode } from 'react';
import { IcCheck } from './icons';
import { useTripoStore } from './store';

/**
 * Anchored popover: renders `menu` under (or beside) its trigger when the
 * store's single `openMenu` equals `id`. Outside-click dismissal is handled
 * globally by TripoWorkspace via the `data-tp-menu-root` marker.
 */
export function MenuAnchor({
  id,
  trigger,
  menu,
  placement = 'bottom-start',
  className,
}: {
  readonly id: string;
  readonly trigger: ReactNode;
  readonly menu: ReactNode;
  readonly placement?:
    | 'bottom-start'
    | 'bottom-end'
    | 'bottom-center'
    | 'top-start'
    | 'top-end'
    | 'left-end'
    | 'right-start';
  readonly className?: string;
}): JSX.Element {
  const open = useTripoStore((s) => s.openMenu) === id;
  return (
    <div className={`tp-anchor ${className ?? ''}`} data-tp-menu-root>
      {trigger}
      {open ? (
        <div
          className={`tp-popover tp-place-${placement}`}
          data-testid={`tp-menu-${id}`}
          role="menu"
        >
          {menu}
        </div>
      ) : null}
    </div>
  );
}

export function MenuItem({
  label,
  hint,
  icon,
  checked,
  danger,
  badge,
  onClick,
  testid,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly icon?: ReactNode;
  readonly checked?: boolean;
  readonly danger?: boolean;
  readonly badge?: string;
  readonly onClick?: () => void;
  readonly testid?: string;
}): JSX.Element {
  return (
    <button
      type="button"
      className={`tp-menu-item ${danger ? 'tp-menu-item-danger' : ''}`}
      onClick={onClick}
      data-testid={testid}
      role="menuitem"
    >
      {icon !== undefined ? <span className="tp-menu-item-icon">{icon}</span> : null}
      <span className="tp-menu-item-body">
        <span className="tp-menu-item-label">{label}</span>
        {hint !== undefined ? <span className="tp-menu-item-hint">{hint}</span> : null}
      </span>
      {badge !== undefined ? <span className="tp-badge-soft">{badge}</span> : null}
      {checked === true ? (
        <span className="tp-menu-item-check">
          <IcCheck size={14} />
        </span>
      ) : null}
    </button>
  );
}

export function Toggle({
  on,
  onChange,
  disabled,
  testid,
}: {
  readonly on: boolean;
  readonly onChange: (next: boolean) => void;
  readonly disabled?: boolean;
  readonly testid?: string;
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      data-testid={testid}
      className="tp-toggle"
      data-on={on}
      onClick={() => onChange(!on)}
    >
      <span className="tp-toggle-knob" />
    </button>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  size = 'md',
  testid,
}: {
  readonly options: readonly { readonly id: T; readonly label: ReactNode }[];
  readonly value: T;
  readonly onChange: (id: T) => void;
  readonly size?: 'sm' | 'md';
  readonly testid?: string;
}): JSX.Element {
  return (
    <div className={`tp-segmented tp-segmented-${size}`} data-testid={testid} role="tablist">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="tab"
          aria-selected={value === o.id}
          className="tp-segment"
          data-active={value === o.id}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function SliderRow({
  label,
  value,
  display,
  min,
  max,
  onChange,
}: {
  readonly label: string;
  readonly value: number;
  readonly display: string;
  readonly min: number;
  readonly max: number;
  readonly onChange: (v: number) => void;
}): JSX.Element {
  return (
    <div className="tp-slider-row">
      <div className="tp-slider-head">
        <span>{label}</span>
        <span className="tp-slider-value">{display}</span>
      </div>
      <input
        type="range"
        className="tp-slider"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

/** Tiny hover tooltip via data attribute (CSS-only, no portal). */
export function Hint({
  text,
  children,
  side = 'top',
}: {
  readonly text: string;
  readonly children: ReactNode;
  readonly side?: 'top' | 'bottom' | 'left' | 'right';
}): JSX.Element {
  return (
    <span className="tp-hint" data-hint={text} data-hint-side={side}>
      {children}
    </span>
  );
}
