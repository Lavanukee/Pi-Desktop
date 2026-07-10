/**
 * App-local icons for the Settings + Model Manager surfaces. The frozen
 * @pi-desktop/ui icon set (icons.tsx) deliberately ships only the glyphs the
 * chat spec book needed; these fill the gaps (download, trash, play, stop,
 * pause, cpu, warning, shield, key, check-circle) using the same
 * 16×16 / currentColor / aria-hidden convention so they compose identically.
 * (The settings GEAR now lives in @pi-desktop/ui as `IconSettings` — a proper
 * cog, shared by the sidebar — so it never reads as the sun toggle.)
 */
import type { SVGProps } from 'react';

export type LocalIconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...props }: LocalIconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export function IconDownload(props: LocalIconProps) {
  return (
    <Svg {...props}>
      <path d="M8 2v7.5" />
      <path d="M4.8 6.6 8 9.8l3.2-3.2" />
      <path d="M2.8 12.5h10.4" />
    </Svg>
  );
}

export function IconTrash(props: LocalIconProps) {
  return (
    <Svg {...props}>
      <path d="M2.8 4.3h10.4" />
      <path d="M6.3 4.3V3.1a1 1 0 0 1 1-1h1.4a1 1 0 0 1 1 1v1.2" />
      <path d="M4 4.3l.6 8.1a1 1 0 0 0 1 .9h4.8a1 1 0 0 0 1-.9l.6-8.1" />
      <path d="M6.6 7v3.6M9.4 7v3.6" />
    </Svg>
  );
}

export function IconPlay(props: LocalIconProps) {
  return (
    <Svg {...props}>
      <path d="M5 3.4v9.2l7.2-4.6z" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconStop(props: LocalIconProps) {
  return (
    <Svg {...props}>
      <rect x="4" y="4" width="8" height="8" rx="1.4" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconPause(props: LocalIconProps) {
  return (
    <Svg {...props}>
      <rect x="4.5" y="3.5" width="2.2" height="9" rx="0.7" fill="currentColor" stroke="none" />
      <rect x="9.3" y="3.5" width="2.2" height="9" rx="0.7" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconCpu(props: LocalIconProps) {
  return (
    <Svg {...props}>
      <rect x="4.3" y="4.3" width="7.4" height="7.4" rx="1.4" />
      <rect x="6.4" y="6.4" width="3.2" height="3.2" rx="0.6" />
      <path d="M6.1 2.4v1.9M9.9 2.4v1.9M6.1 11.7v1.9M9.9 11.7v1.9M2.4 6.1h1.9M2.4 9.9h1.9M11.7 6.1h1.9M11.7 9.9h1.9" />
    </Svg>
  );
}

export function IconWarning(props: LocalIconProps) {
  return (
    <Svg {...props}>
      <path d="M8 2.3 14 12.7a.8.8 0 0 1-.7 1.2H2.7a.8.8 0 0 1-.7-1.2z" />
      <path d="M8 6.2v3.1" />
      <path d="M8 11.2h.01" />
    </Svg>
  );
}

export function IconCheckCircle(props: LocalIconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="6" />
      <path d="M5.4 8.1 7.2 9.9l3.4-3.8" />
    </Svg>
  );
}

export function IconShield(props: LocalIconProps) {
  return (
    <Svg {...props}>
      <path d="M8 2.2 3 4v3.6c0 3 2.1 5.1 5 6.2 2.9-1.1 5-3.2 5-6.2V4z" />
    </Svg>
  );
}

export function IconKey(props: LocalIconProps) {
  return (
    <Svg {...props}>
      <circle cx="5.4" cy="10.6" r="2.6" />
      <path d="M7.3 8.8 13 3.1M11 5.1l1.5 1.5M9.6 6.5l1.4 1.4" />
    </Svg>
  );
}

export function IconSlider(props: LocalIconProps) {
  return (
    <Svg {...props}>
      <path d="M2.6 5h7M12.4 5h1M2.6 11h1M6.4 11h7" />
      <circle cx="10.4" cy="5" r="1.6" />
      <circle cx="4.6" cy="11" r="1.6" />
    </Svg>
  );
}

export function IconSun(props: LocalIconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.4v1.4M8 13.2v1.4M1.4 8h1.4M13.2 8h1.4M3.3 3.3l1 1M11.7 11.7l1 1M12.7 3.3l-1 1M4.3 11.7l-1 1" />
    </Svg>
  );
}

export function IconMoon(props: LocalIconProps) {
  return (
    <Svg {...props}>
      <path d="M13 9.3A5.4 5.4 0 0 1 6.7 3a5.4 5.4 0 1 0 6.3 6.3z" />
    </Svg>
  );
}
