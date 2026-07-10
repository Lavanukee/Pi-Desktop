/**
 * Minimal inline icon set (generic geometry, no copied assets). Glyphs are
 * decorative (aria-hidden); icon-only controls carry their own aria-labels.
 */

import { clsx } from 'clsx';
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
      // `.pd-icon` sets `stroke-width: var(--pd-icon-stroke)`; CSS beats this
      // presentation attribute (attrs have the lowest cascade priority), so the
      // token wins when styles are loaded and this stays a no-CSS fallback.
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={clsx('pd-icon', className)}
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export function IconChevronDown(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 6l4 4 4-4" />
    </Icon>
  );
}

export function IconChevronRight(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 4l4 4-4 4" />
    </Icon>
  );
}

export function IconChevronLeft(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M10 4l-4 4 4 4" />
    </Icon>
  );
}

export function IconCheck(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 8.5l3.5 3.5L13 4.5" />
    </Icon>
  );
}

export function IconClose(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </Icon>
  );
}

export function IconCopy(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="5.5" y="5.5" width="7" height="7" rx="1.5" />
      <path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" />
    </Icon>
  );
}

export function IconPlus(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 3v10M3 8h10" />
    </Icon>
  );
}

export function IconArrowUp(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" />
    </Icon>
  );
}

export function IconPencil(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M10.5 3l2.5 2.5L6 12.5l-3.2.7.7-3.2L10.5 3z" />
    </Icon>
  );
}

export function IconSearch(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M13.5 13.5L10.3 10.3" />
    </Icon>
  );
}

export function IconChat(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M13.5 8A5.5 5.5 0 1 1 8 2.5 5.5 5.5 0 0 1 13.5 8z" />
      <path d="M8 13.5L5.5 15v-2.5" />
    </Icon>
  );
}

export function IconSidebar(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2" y="3" width="12" height="10" rx="2" />
      <path d="M6 3v10" />
    </Icon>
  );
}

export function IconTerminal(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 4.5L6.5 8 3 11.5M8 12h5" />
    </Icon>
  );
}

export function IconFile(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9 2H4.5A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V6L9 2z" />
      <path d="M9 2v4h4" />
    </Icon>
  );
}

/** Thinking / duration glyph (clock). */
export function IconClock(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 4.8V8l2.2 1.6" />
    </Icon>
  );
}

/**
 * Settings glyph — a proper cog (toothed rim + center bore). Deliberately reads
 * as a GEAR, not a sun: the teeth sit on the perimeter with a hollow hub, so it
 * never collides with the light/dark sun toggle (IconSun's rays off a solid disc).
 */
export function IconSettings(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6.87 3.44 L7.08 1.87 L8.92 1.87 L9.13 3.44 L10.42 3.97 L11.68 3.01 L12.99 4.32 L12.03 5.58 L12.56 6.87 L14.13 7.08 L14.13 8.92 L12.56 9.13 L12.03 10.42 L12.99 11.68 L11.68 12.99 L10.42 12.03 L9.13 12.56 L8.92 14.13 L7.08 14.13 L6.87 12.56 L5.58 12.03 L4.32 12.99 L3.01 11.68 L3.97 10.42 L3.44 9.13 L1.87 8.92 L1.87 7.08 L3.44 6.87 L3.97 5.58 L3.01 4.32 L4.32 3.01 L5.58 3.97 Z" />
      <circle cx="8" cy="8" r="2.3" />
    </Icon>
  );
}

/** "Opens in canvas" glyph (box + arrow leaving to the corner). */
export function IconExternal(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 4H4.5A1.5 1.5 0 0 0 3 5.5v6A1.5 1.5 0 0 0 4.5 13h6a1.5 1.5 0 0 0 1.5-1.5V8" />
      <path d="M9 3.5h4v4M13 3.5 8 8.5" />
    </Icon>
  );
}

export function IconDiff(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 2.5v6M2.5 5.5H8" />
      <path d="M8.5 11h5" />
      <path d="M11 13.5A2.5 2.5 0 1 0 11 8.5" />
    </Icon>
  );
}

export function IconMic(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="6" y="2" width="4" height="7" rx="2" />
      <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.5" />
    </Icon>
  );
}

export function IconInfo(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 7.5v3.2" />
      <path d="M8 5.1v.2" />
    </Icon>
  );
}

export function IconRefresh(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12.8 8a4.8 4.8 0 1 1-1.4-3.4" />
      <path d="M12.8 3v2.6h-2.6" />
    </Icon>
  );
}

export function IconThumbUp(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.6 7.2 7 2.6a1 1 0 0 1 1.9.5V6h3a1 1 0 0 1 1 1.2l-.8 4.1a1 1 0 0 1-1 .8H4.6z" />
      <path d="M4.6 7.2H3v5.5h1.6z" />
    </Icon>
  );
}

export function IconThumbDown(props: IconProps) {
  return (
    <Icon {...props}>
      <g transform="rotate(180 8 8)">
        <path d="M4.6 7.2 7 2.6a1 1 0 0 1 1.9.5V6h3a1 1 0 0 1 1 1.2l-.8 4.1a1 1 0 0 1-1 .8H4.6z" />
        <path d="M4.6 7.2H3v5.5h1.6z" />
      </g>
    </Icon>
  );
}

export function IconShare(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 10V2.6M5.3 5.3 8 2.6l2.7 2.7" />
      <path d="M4 8.5v4a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-4" />
    </Icon>
  );
}

export function IconMore(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="3.6" cy="8" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12.4" cy="8" r="1.1" fill="currentColor" stroke="none" />
    </Icon>
  );
}

/** Context-fullness glyph (half-donut gauge + needle) for the msg action bar. */
export function IconGauge(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 11a5 5 0 0 1 10 0" />
      <path d="M8 11V6.2" />
    </Icon>
  );
}

/** Response-speed glyph (speedometer). */
export function IconSpeed(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.8 11.6a5.5 5.5 0 1 1 10.4 0" />
      <path d="M8 8.7 10.8 6.4" />
      <circle cx="8" cy="8.7" r="0.9" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function IconCamera(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.5 6a1.5 1.5 0 0 1 1.5-1.5h1L6 3h4l1 1.5h1A1.5 1.5 0 0 1 13.5 6v5.5A1.5 1.5 0 0 1 12 13H4a1.5 1.5 0 0 1-1.5-1.5z" />
      <circle cx="8" cy="8.5" r="2.1" />
    </Icon>
  );
}

export function IconImage(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2.5" y="3.5" width="11" height="9" rx="1.5" />
      <circle cx="5.8" cy="6.5" r="1" />
      <path d="M3 11.5 6.5 8l2.5 2.5L11 8.5l2.5 2.3" />
    </Icon>
  );
}

export function IconPaperclip(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 7.4 7.3 12a2.5 2.5 0 0 1-3.5-3.5l4.9-4.9a1.6 1.6 0 0 1 2.3 2.3l-4.8 4.8a.7.7 0 0 1-1-1l4.3-4.3" />
    </Icon>
  );
}

export function IconGithub(props: IconProps) {
  return (
    <Icon {...props}>
      <path
        d="M8 2a6 6 0 0 0-1.9 11.7c.3.05.4-.13.4-.29l-.01-1.02c-1.67.36-2.02-.71-2.02-.71-.27-.7-.67-.88-.67-.88-.55-.37.04-.37.04-.37.6.05.93.62.93.62.54.93 1.42.66 1.76.5.06-.39.21-.66.38-.81-1.34-.15-2.75-.67-2.75-2.99a2.34 2.34 0 0 1 .62-1.62c-.06-.15-.27-.77.06-1.6 0 0 .5-.16 1.65.62a5.6 5.6 0 0 1 3 0c1.14-.78 1.65-.62 1.65-.62.33.83.12 1.45.06 1.6a2.34 2.34 0 0 1 .62 1.62c0 2.33-1.42 2.84-2.77 2.99.22.19.41.55.41 1.11l-.01 1.65c0 .16.11.35.41.29A6 6 0 0 0 8 2z"
        fill="currentColor"
        stroke="none"
      />
    </Icon>
  );
}

/** Connector / extension glyph (plug). */
export function IconConnector(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 2.5V5M10 2.5V5" />
      <rect x="4.5" y="5" width="7" height="3.6" rx="1" />
      <path d="M8 8.6v2.4a2.5 2.5 0 0 0 2.5 2.5H12" />
    </Icon>
  );
}

export function IconPuzzle(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2.6" y="2.6" width="4.3" height="4.3" rx="1" />
      <rect x="9.1" y="2.6" width="4.3" height="4.3" rx="1" />
      <rect x="2.6" y="9.1" width="4.3" height="4.3" rx="1" />
      <path d="M11.2 9.3v3.9M9.3 11.2h3.9" />
    </Icon>
  );
}

export function IconGlobe(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M2.5 8h11" />
      <path d="M8 2.5c1.7 1.5 2.7 3.5 2.7 5.5S9.7 12 8 13.5C6.3 12 5.3 10 5.3 8S6.3 4 8 2.5z" />
    </Icon>
  );
}

export function IconSparkles(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M7.2 2.6 8.3 5.5l2.9 1.1-2.9 1.1-1.1 2.9-1.1-2.9L3.2 6.6l2.9-1.1z" />
      <path d="M11.8 9.6l.5 1.4 1.4.5-1.4.5-.5 1.4-.5-1.4-1.4-.5 1.4-.5z" />
    </Icon>
  );
}

export function IconFolderPlus(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.5 4.5a1 1 0 0 1 1-1h2.4l1.2 1.4h5.4a1 1 0 0 1 1 1v6.1a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1z" />
      <path d="M8 8v3.2M6.4 9.6h3.2" />
    </Icon>
  );
}

/*
 * Browser-action glyphs (round-10 #17): each browser tool step gets its own
 * icon so the activity chain reads "navigated / clicked / typed / viewed" at a
 * glance instead of the generic file sheet. Compass = navigate, pointer =
 * click, keyboard = type, eye = read/snapshot.
 */

/** Compass — browser navigate / goto / open / back / forward. */
export function IconCompass(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M10.6 5.4 9 9 5.4 10.6 7 7z" />
    </Icon>
  );
}

/** Arrow pointer — browser click / hover / select / scroll. */
export function IconCursor(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.5 2.8 3.5 12.4 6 10 7.6 13.4 9.4 12.6 7.8 9.3 11.2 9.2z" />
    </Icon>
  );
}

/** Keyboard — browser type / fill / press key. */
export function IconKeyboard(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="1.75" y="4.5" width="12.5" height="7.5" rx="1.5" />
      <path d="M4.2 7.3h.01M6.6 7.3h.01M9 7.3h.01M11.4 7.3h.01M5 9.7h6" />
    </Icon>
  );
}

/** Eye — browser read / snapshot / screenshot. */
export function IconEye(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M1.5 8S4 3.75 8 3.75 14.5 8 14.5 8 12 12.25 8 12.25 1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2" />
    </Icon>
  );
}
