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

/** Film strip (video) — a frame with sprocket holes down each edge. */
export function IconFilm(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
      <path d="M5.5 3v10M10.5 3v10" />
      <path d="M2.5 6.3h3M2.5 9.7h3M10.5 6.3h3M10.5 9.7h3" />
    </Icon>
  );
}

/** Audio (a music note). */
export function IconAudio(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 12V4l7-1.5V10.5" />
      <circle cx="4.5" cy="12" r="1.5" />
      <circle cx="11.5" cy="10.5" r="1.5" />
    </Icon>
  );
}

/** Rich document (file glyph + text rules) — docx / pptx previews. */
export function IconDoc(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9 2H4.5A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V6L9 2z" />
      <path d="M9 2v4h4" />
      <path d="M5.5 8.5h5M5.5 10.5h5M5.5 12h3" />
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

/**
 * Pop out to a standalone window — a full rounded window box with a single notch
 * at the top-right corner where the arrow exits. The old glyph left the whole
 * top-right quadrant of the box open (both the top edge past x=7.5 and the right
 * edge above y=8.5), so it read as a half-drawn rectangle; this keeps the box
 * closed except the corner notch, matching the (verified) IconExternal anatomy.
 */
export function IconPopout(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 3H4.5A1.5 1.5 0 0 0 3 4.5v7A1.5 1.5 0 0 0 4.5 13h7A1.5 1.5 0 0 0 13 11.5V8" />
      <path d="M9.5 3H13v3.5" />
      <path d="M13 3 8 8" />
    </Icon>
  );
}

/**
 * Generic application glyph (launchpad-style 2×2 tiles) — the fallback icon for
 * the file "Open" split button + the "Open with" list when the app has not (yet)
 * supplied a real system icon (`iconDataUrl`).
 */
export function IconAppGeneric(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2.75" y="2.75" width="4.5" height="4.5" rx="1.2" />
      <rect x="8.75" y="2.75" width="4.5" height="4.5" rx="1.2" />
      <rect x="2.75" y="8.75" width="4.5" height="4.5" rx="1.2" />
      <rect x="8.75" y="8.75" width="4.5" height="4.5" rx="1.2" />
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

/** 3D object (isometric cube) — the TRELLIS 3D workspace tab. */
export function IconCube(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 2l5 2.75v6.5L8 14l-5-2.75v-6.5L8 2z" />
      <path d="M3 4.75 8 7.5l5-2.75M8 7.5V14" />
    </Icon>
  );
}

/** Org chart — the situation room tab (a root node fanning out to reports). */
export function IconSituation(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="6" y="2" width="4" height="3.4" rx="1" />
      <rect x="2" y="10.6" width="4" height="3.4" rx="1" />
      <rect x="10" y="10.6" width="4" height="3.4" rx="1" />
      <path d="M8 5.4v2.3M8 7.7H4v2.9M8 7.7h4v2.9" />
    </Icon>
  );
}
