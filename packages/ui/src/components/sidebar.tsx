import { clsx } from 'clsx';
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
import { forwardRef } from 'react';

/*
 * Sidebar family — spec-sidebar.md. Claude's parametric row system, tokenized:
 * codex = {row 30px, pill radius, 240px}, claude = {row 32px, 8px, 288px} with
 * zero component branching. Presentational — W3 wires session state.
 */

export interface SidebarProps extends HTMLAttributes<HTMLElement> {
  /**
   * Slide the sidebar in (true, default) or out (false). Drives the token-based
   * floating (claude) / frosted (codex) treatment's slide transition; the host
   * shell should clip the collapsed panel.
   */
  open?: boolean;
}

export const Sidebar = forwardRef<HTMLElement, SidebarProps>(function Sidebar(
  { open = true, className, ...rest },
  ref,
) {
  return <aside ref={ref} className={clsx('pd-sidebar', className)} data-open={open} {...rest} />;
});

export const SidebarScroll = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function SidebarScroll({ className, ...rest }, ref) {
    return (
      <div
        ref={ref}
        className={clsx('pd-sidebar-scroll pd-scroll pd-scroll-fade-y', className)}
        {...rest}
      />
    );
  },
);

export interface SidebarSectionProps extends HTMLAttributes<HTMLDivElement> {
  label?: ReactNode;
  /** Hover-revealed header actions (collapse-all / add — codex pattern). */
  actions?: ReactNode;
}

export const SidebarSection = forwardRef<HTMLDivElement, SidebarSectionProps>(
  function SidebarSection({ label, actions, className, children, ...rest }, ref) {
    return (
      <div ref={ref} className={clsx('pd-sidebar-section', className)} {...rest}>
        {label !== undefined ? (
          <div className="pd-sidebar-section-header">
            <span>{label}</span>
            {actions !== undefined ? (
              <span className="pd-sidebar-section-actions">{actions}</span>
            ) : null}
          </div>
        ) : null}
        {children}
      </div>
    );
  },
);

export interface SidebarRowProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: ReactNode;
  label: ReactNode;
  /** Trailing resting meta (timestamp / kbd hint) — hides on hover when
   * `controls` exist (the shared claude "…" / codex Pin+Archive mechanism). */
  meta?: ReactNode;
  /** Hover-revealed trailing controls. */
  controls?: ReactNode;
  selected?: boolean;
}

/** The row atom shared by nav items and session rows. */
export const SidebarRow = forwardRef<HTMLButtonElement, SidebarRowProps>(function SidebarRow(
  { icon, label, meta, controls, selected = false, className, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={clsx('pd-sidebar-row', className)}
      data-selected={selected || undefined}
      {...rest}
    >
      {icon !== undefined ? <span className="pd-sidebar-row-icon">{icon}</span> : null}
      <span className="pd-sidebar-row-label">{label}</span>
      {meta !== undefined ? <span className="pd-sidebar-row-meta">{meta}</span> : null}
      {controls !== undefined ? <span className="pd-sidebar-row-controls">{controls}</span> : null}
    </button>
  );
});

export interface SidebarFooterProps extends HTMLAttributes<HTMLDivElement> {
  avatar?: ReactNode;
  name?: ReactNode;
  plan?: ReactNode;
}

export const SidebarFooter = forwardRef<HTMLDivElement, SidebarFooterProps>(function SidebarFooter(
  { avatar, name, plan, className, children, ...rest },
  ref,
) {
  return (
    <div ref={ref} className={clsx('pd-sidebar-footer', className)} {...rest}>
      {avatar !== undefined ? <span className="pd-sidebar-avatar">{avatar}</span> : null}
      {name !== undefined ? (
        <span className="pd-sidebar-footer-name">
          {name}
          {plan !== undefined ? <span className="pd-sidebar-footer-plan"> · {plan}</span> : null}
        </span>
      ) : null}
      {children}
    </div>
  );
});
