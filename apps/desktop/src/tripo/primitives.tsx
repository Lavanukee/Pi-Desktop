/**
 * Small UI primitives for the Tripo workspace — anchored popover, switch,
 * segmented control, slider row, menu item. Hand-rolled (not @pi-desktop/ui)
 * so the workspace can match the reference's density/geometry exactly while
 * still drawing every color from the pd token set via tripo.css.
 *
 * Popovers and hint tooltips render through a PORTAL with fixed positioning
 * clamped to the viewport — an absolutely-positioned menu inside a scroll
 * container (panel scroll, dialogs) gets CLIPPED at the container edge (the
 * cut-off dropdowns/hover-text jedd hit); a portal escapes every overflow
 * ancestor by construction.
 */
import type { JSX, ReactNode } from 'react';
import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { IcCheck } from './icons';
import { useTripoStore } from './store';

type Placement =
  | 'bottom-start'
  | 'bottom-end'
  | 'bottom-center'
  | 'top-start'
  | 'top-end'
  | 'left-end'
  | 'right-start';

const VIEW_MARGIN = 8;

/** Fixed-position coordinates for `pop` next to `anchor` per `placement`,
 * clamped into the viewport (flips vertically when it would overflow). */
function placePopover(
  anchor: DOMRect,
  pop: { width: number; height: number },
  placement: Placement,
): { left: number; top: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left: number;
  let top: number;
  const below = anchor.bottom + 6;
  const above = anchor.top - 6 - pop.height;
  switch (placement) {
    case 'bottom-end':
      left = anchor.right - pop.width;
      top = below;
      break;
    case 'bottom-center':
      left = anchor.left + anchor.width / 2 - pop.width / 2;
      top = below;
      break;
    case 'top-start':
      left = anchor.left;
      top = above;
      break;
    case 'top-end':
      left = anchor.right - pop.width;
      top = above;
      break;
    case 'left-end':
      left = anchor.left - 6 - pop.width;
      top = anchor.bottom - pop.height;
      break;
    case 'right-start':
      left = anchor.right + 6;
      top = anchor.top;
      break;
    default: // bottom-start
      left = anchor.left;
      top = below;
  }
  // Flip vertically rather than clip when a bottom menu runs off-screen (and
  // vice versa) — the export-format dropdown bug.
  if (top + pop.height > vh - VIEW_MARGIN && placement.startsWith('bottom')) {
    top = Math.max(VIEW_MARGIN, anchor.top - 6 - pop.height);
  } else if (top < VIEW_MARGIN && placement.startsWith('top')) {
    top = Math.min(vh - VIEW_MARGIN - pop.height, anchor.bottom + 6);
  }
  left = Math.min(Math.max(left, VIEW_MARGIN), vw - VIEW_MARGIN - pop.width);
  top = Math.min(Math.max(top, VIEW_MARGIN), vh - VIEW_MARGIN - pop.height);
  return { left, top };
}

/**
 * Anchored popover: renders `menu` in a viewport-clamped PORTAL when the
 * store's single `openMenu` equals `id`. Outside-click dismissal is handled
 * globally by TripoWorkspace via the `data-tp-menu-root` marker (carried by
 * both the anchor and the portal content, so clicks inside either don't
 * dismiss).
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
  readonly placement?: Placement;
  readonly className?: string;
}): JSX.Element {
  const open = useTripoStore((s) => s.openMenu) === id;
  const anchorRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Position after the portal renders (we need its measured size to clamp).
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const anchor = anchorRef.current?.getBoundingClientRect();
    const pop = popRef.current;
    if (anchor === undefined || pop === null) return;
    setPos(placePopover(anchor, { width: pop.offsetWidth, height: pop.offsetHeight }, placement));
  }, [open, placement]);

  return (
    <div className={`tp-anchor ${className ?? ''}`} data-tp-menu-root ref={anchorRef}>
      {trigger}
      {open
        ? createPortal(
            <div
              ref={popRef}
              className="tp-popover tp-popover-portal"
              data-testid={`tp-menu-${id}`}
              data-tp-menu-root
              role="menu"
              style={
                pos === null
                  ? { position: 'fixed', left: 0, top: 0, visibility: 'hidden' }
                  : { position: 'fixed', left: pos.left, top: pos.top }
              }
            >
              {menu}
            </div>,
            document.body,
          )
        : null}
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

/** Hover tooltip, PORTALED so it never clips against scroll containers (the
 * cut-off hover text over the input tabs). Positioned per `side`, clamped. */
export function Hint({
  text,
  children,
  side = 'top',
}: {
  readonly text: string;
  readonly children: ReactNode;
  readonly side?: 'top' | 'bottom' | 'left' | 'right';
}): JSX.Element {
  const ref = useRef<HTMLSpanElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);

  const bubble =
    rect !== null
      ? (() => {
          const vw = window.innerWidth;
          const style: React.CSSProperties = { position: 'fixed', zIndex: 200 };
          if (side === 'bottom') {
            style.left = rect.left + rect.width / 2;
            style.top = rect.bottom + 7;
            style.transform = 'translateX(-50%)';
          } else if (side === 'left') {
            style.left = rect.left - 7;
            style.top = rect.top + rect.height / 2;
            style.transform = 'translate(-100%, -50%)';
          } else if (side === 'right') {
            style.left = rect.right + 7;
            style.top = rect.top + rect.height / 2;
            style.transform = 'translateY(-50%)';
          } else {
            // top — flip to bottom when there is no headroom (the clipped case).
            const flip = rect.top < 40;
            style.left = Math.min(Math.max(rect.left + rect.width / 2, 60), vw - 60);
            style.top = flip ? rect.bottom + 7 : rect.top - 7;
            style.transform = flip ? 'translateX(-50%)' : 'translate(-50%, -100%)';
          }
          return createPortal(
            <span className="tp-hint-bubble" style={style} aria-hidden="true">
              {text}
            </span>,
            document.body,
          );
        })()
      : null;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover-tooltip wrapper — the interactive control is the child
    <span
      ref={ref}
      className="tp-hint"
      onMouseEnter={() => setRect(ref.current?.getBoundingClientRect() ?? null)}
      onMouseLeave={() => setRect(null)}
      onFocus={() => setRect(ref.current?.getBoundingClientRect() ?? null)}
      onBlur={() => setRect(null)}
    >
      {children}
      {bubble}
    </span>
  );
}
