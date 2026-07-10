/**
 * Canvas-local icons — the type/chrome glyphs the tab bar and surfaces need that
 * @pi-desktop/ui does not ship. Same 16×16 stroke anatomy as the ui icon set
 * (decorative, aria-hidden); icon-only controls carry their own aria-labels.
 * Reuse ui's IconGlobe/IconTerminal/IconFile/IconImage/IconRefresh/… where they
 * exist — these fill the gaps (pdf, subagent, expand, minimize, download, nav).
 */

import type { ReactNode, SVGProps } from 'react';

export type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 16, className, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      // `.pd-icon` resolves stroke-width from --pd-icon-stroke (CSS beats this
      // presentation attribute), so canvas glyphs honor the icon-thickness
      // setting; the 1.5 is only a no-CSS fallback.
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={['pd-icon', className].filter(Boolean).join(' ')}
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** PDF document (file glyph + text rules). */
export function IconPdf(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9 2H4.5A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V6L9 2z" />
      <path d="M9 2v4h4" />
      <path d="M5.5 9h4M5.5 11h2.5" />
    </Icon>
  );
}

/** Source file (angle brackets). */
export function IconCode(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 5L3 8l3 3M10 5l3 3-3 3" />
    </Icon>
  );
}

/** Markup preview (html/svg) — angle brackets with a slash. */
export function IconMarkup(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5.5 4.5L2.5 8l3 3.5M10.5 4.5L13.5 8l-3 3.5" />
      <path d="M9 3l-2 10" />
    </Icon>
  );
}

/** Subagents — a fan of worker nodes. */
export function IconSubagent(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="4" cy="4" r="1.6" />
      <circle cx="12" cy="4" r="1.6" />
      <circle cx="8" cy="12" r="1.6" />
      <path d="M4 5.6v1.4A1.5 1.5 0 0 0 5.5 8.5h5A1.5 1.5 0 0 0 12 7v-1.4M8 8.5v1.9" />
    </Icon>
  );
}

/** Fullscreen / expand (diagonal arrows out to the corners). */
export function IconExpand(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 3H3v3M13 6V3h-3M6 13H3v-3M10 13h3v-3" />
    </Icon>
  );
}

/**
 * Right-side panel toggle — ui's `IconSidebar` mirrored over the Y axis so the
 * divider sits on the RIGHT edge (this canvas docks on the right). Toggles the
 * canvas panel open/closed; the app owns the slide animation.
 */
export function IconPanelRight(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2" y="3" width="12" height="10" rx="2" />
      <path d="M10 3v10" />
    </Icon>
  );
}

/** Pop out to a standalone window (box with an arrow leaving the top-right). */
export function IconPopout(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12.5 8.5v3A1.5 1.5 0 0 1 11 13H4.5A1.5 1.5 0 0 1 3 11.5V5A1.5 1.5 0 0 1 4.5 3.5h3" />
      <path d="M10 3h3v3M13 3l-5 5" />
    </Icon>
  );
}

/** Minimize / collapse the canvas (double chevron toward the right edge). */
export function IconMinimize(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 4l4 4-4 4M9 4l4 4-4 4" />
    </Icon>
  );
}

/** Download (arrow into a tray). */
export function IconDownload(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 3v7M5 7.5L8 10.5l3-3" />
      <path d="M3.5 13h9" />
    </Icon>
  );
}

/** Browser back (left arrow). */
export function IconArrowLeft(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M10 4l-4 4 4 4" />
      <path d="M6 8h6.5" />
    </Icon>
  );
}

/** Browser forward (right arrow). */
export function IconArrowRight(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 4l4 4-4 4" />
      <path d="M10 8H3.5" />
    </Icon>
  );
}

/** A single folder. */
export function IconFolder(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.3a1 1 0 0 1 .7.3L7.7 4.5h4.8A1.5 1.5 0 0 1 14 6v5.5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5z" />
    </Icon>
  );
}

/** Two stacked folders — the file-tree panel toggle (img59). */
export function IconFolders(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2 9V4.5A1.5 1.5 0 0 1 3.5 3h2l1 1.2h4A1.5 1.5 0 0 1 12 5.7" />
      <path d="M4 6.5A1.5 1.5 0 0 1 5.5 5h2l1 1.2h4A1.5 1.5 0 0 1 14 7.7v3.8A1.5 1.5 0 0 1 12.5 13H5.5A1.5 1.5 0 0 1 4 11.5z" />
    </Icon>
  );
}
