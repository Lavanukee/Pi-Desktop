/**
 * Tripo workspace icon set — small stroke SVGs, all `currentColor`, sized via
 * a `size` prop (default 18). Local to the tripo module on purpose: the shared
 * `@pi-desktop/ui` icon file is owned by other threads, and these glyphs are
 * workspace-specific (rail tools, viewer chrome, DCC targets).
 */
import type { JSX, ReactNode } from 'react';

interface IconProps {
  readonly size?: number;
  readonly className?: string;
}

function make(children: ReactNode, viewBox = '0 0 24 24') {
  return function TripoIcon({ size = 18, className }: IconProps): JSX.Element {
    return (
      <svg
        width={size}
        height={size}
        viewBox={viewBox}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        aria-hidden="true"
      >
        {children}
      </svg>
    );
  };
}

// ── rail tools ────────────────────────────────────────────────────────────
export const IcImage = make(
  <>
    <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="M4 17.5l4.8-4.6a1.6 1.6 0 0 1 2.2 0l6 5.6" />
    <path d="M14.5 15.5l2.2-2a1.6 1.6 0 0 1 2.1 0L21 15.5" />
  </>,
);
export const IcSparkles = make(
  <>
    <path d="M12 3.5l1.7 4.6 4.6 1.7-4.6 1.7L12 16.1l-1.7-4.6-4.6-1.7 4.6-1.7z" />
    <path d="M18.8 15.5l.8 2.1 2.1.8-2.1.8-.8 2.1-.8-2.1-2.1-.8 2.1-.8z" />
  </>,
);
export const IcSegment = make(
  <>
    <path d="M12 3l7.5 4.2v3.3" />
    <path d="M12 3L4.5 7.2v3.3" />
    <path d="M12 3v5.2" />
    <path d="M8.8 13.2L4.5 15.6 12 20l-1-4.4z" />
    <path d="M15.2 13.2l4.3 2.4L12 20l1-4.4z" />
  </>,
);
export const IcRetopo = make(
  <>
    <path d="M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9z" />
    <path d="M12 3v18M4.2 7.5L19.8 16.5M19.8 7.5L4.2 16.5" opacity={0.55} />
    <path d="M12 8.2l3.3 1.9v3.8L12 15.8l-3.3-1.9v-3.8z" />
  </>,
);
export const IcTexture = make(
  <>
    <rect x="4" y="4" width="16" height="16" rx="2.5" />
    <path d="M4.5 14.5l5-5M8 19l8.5-8.5M13 19.5L19.5 13" opacity={0.75} />
  </>,
);
export const IcAnimate = make(
  <>
    <circle cx="12" cy="5" r="2" />
    <path d="M12 7.5v5M12 12.5l-3.5 6M12 12.5l3.5 6M6.5 9.5L12 8.7l5.5.8" />
  </>,
);
export const IcFillParts = make(
  <>
    <path d="M12 3.5l7.5 4.3v8.4L12 20.5l-7.5-4.3V7.8z" />
    <path d="M12 12v8.5M12 12L4.5 7.8M12 12l7.5-4.2" opacity={0.5} />
    <path d="M9.5 10.6l2.5 1.4 2.5-1.4" />
  </>,
);
export const IcEditPen = make(
  <>
    <path d="M14.5 4.5l5 5L8 21H3v-5z" />
    <path d="M12.5 6.5l5 5" />
  </>,
);
export const IcUpscale = make(
  <>
    <rect x="3.5" y="10.5" width="10" height="10" rx="2" />
    <path d="M13 4h7v7M20 4l-7.5 7.5" />
  </>,
);
export const IcPbr = make(
  <>
    <circle cx="12" cy="12" r="8.2" />
    <path d="M12 3.8A8.2 8.2 0 0 0 12 20.2z" fill="currentColor" stroke="none" opacity={0.4} />
    <path d="M12 3.8v16.4" />
  </>,
);

// ── generation panel ──────────────────────────────────────────────────────
export const IcUpload = make(
  <>
    <path d="M12 15V4.5M7.5 8.5L12 4l4.5 4.5" />
    <path d="M4.5 15.5v2.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-2.5" />
  </>,
);
export const IcCube = make(
  <>
    <path d="M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9z" />
    <path d="M12 12l7.8-4.5M12 12L4.2 7.5M12 12v9" />
  </>,
);
export const IcGallery = make(
  <>
    <rect x="3" y="7" width="14" height="13" rx="2" />
    <path d="M7 7V5.5A1.5 1.5 0 0 1 8.5 4H19a2 2 0 0 1 2 2v10.5a1.5 1.5 0 0 1-1.5 1.5H17" />
    <path d="M3.5 16.5l3.8-3.6a1.5 1.5 0 0 1 2 0l4.7 4.4" />
  </>,
);
export const IcPencil = make(<path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19z" />);
export const IcBulb = make(
  <>
    <path d="M9 18h6M10 21h4" />
    <path d="M12 3a6 6 0 0 1 3.5 10.9c-.8.6-1.2 1.3-1.3 2.1h-4.4c-.1-.8-.5-1.5-1.3-2.1A6 6 0 0 1 12 3z" />
  </>,
);
export const IcCrown = make(
  <>
    <path d="M4 17.5L3 7.5l5 3.5 4-6 4 6 5-3.5-1 10z" />
    <path d="M4.5 20.5h15" />
  </>,
);
export const IcBolt = make(
  <path d="M13 2.5L5 13.5h5.5L10 21.5l8-11h-5.5z" fill="currentColor" stroke="none" />,
);
export const IcGlobe = make(
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.5 12h17M12 3.5c2.6 2.3 3.9 5.1 3.9 8.5s-1.3 6.2-3.9 8.5c-2.6-2.3-3.9-5.1-3.9-8.5s1.3-6.2 3.9-8.5z" />
  </>,
);
export const IcLock = make(
  <>
    <rect x="5.5" y="10.5" width="13" height="9.5" rx="2" />
    <path d="M8.5 10.5V7.8a3.5 3.5 0 0 1 7 0v2.7" />
  </>,
);
export const IcSearch = make(
  <>
    <circle cx="10.5" cy="10.5" r="6" />
    <path d="M15.2 15.2L20 20" />
  </>,
);
export const IcChevronDown = make(<path d="M6 9.5l6 6 6-6" />);
export const IcChevronUp = make(<path d="M6 14.5l6-6 6 6" />);
export const IcChevronRight = make(<path d="M9.5 6l6 6-6 6" />);
export const IcCaretSmall = make(<path d="M7 10l5 5 5-5" fill="currentColor" stroke="none" />);
export const IcQuestion = make(
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M9.6 9.3a2.5 2.5 0 1 1 3.6 2.9c-.8.5-1.2 1-1.2 1.9" />
    <circle cx="12" cy="16.8" r="0.4" fill="currentColor" />
  </>,
);
export const IcCheck = make(<path d="M5 12.5l4.5 4.5L19 7.5" />);
export const IcClose = make(<path d="M6 6l12 12M18 6L6 18" />);
export const IcThumbsUp = make(
  <>
    <path d="M7.5 11.5l3.8-7.6a2 2 0 0 1 2.1 2v3.6h4.4a2 2 0 0 1 2 2.4l-1.1 5.7a2 2 0 0 1-2 1.6H7.5" />
    <rect x="3" y="11.5" width="4.5" height="8" rx="1" />
  </>,
);
export const IcDog = make(
  <>
    <path d="M5 17.5V9.5L3.5 6l3.7 1h5.2c.6-1.6 1.8-2.6 3.8-2.6l-.9 2.7 2.9 2.1-1.7 1.4h-2.2l-1.4 3.5v3.4" />
    <path d="M8.5 17.5v-3.2M15 20.5H4.8" />
  </>,
);

// ── top bar ───────────────────────────────────────────────────────────────
export const IcBell = make(
  <>
    <path d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2.5h-15z" />
    <path d="M10 20.5a2.2 2.2 0 0 0 4 0" />
  </>,
);
export const IcUser = make(
  <>
    <circle cx="12" cy="8" r="3.6" />
    <path d="M4.5 20.2a7.7 7.7 0 0 1 15 0" />
  </>,
);
export const IcBridge = make(
  <>
    <path d="M4 8.5h13M14 5l3.5 3.5L14 12" />
    <path d="M20 15.5H7M10 12l-3.5 3.5L10 19" />
  </>,
);
export const IcRocket = make(
  <>
    <path d="M12 15.5c4.5-3 6.5-7 6-11.5-4.5-.5-8.5 1.5-11.5 6L4 12.5l3 .5 4 4 .5 3z" />
    <circle cx="13.8" cy="10.2" r="1.6" />
    <path d="M6.5 17.5c-1.2.4-2 1.6-2.5 3.5 1.9-.5 3.1-1.3 3.5-2.5" />
  </>,
);

// ── viewer chrome ─────────────────────────────────────────────────────────
export const IcSun = make(
  <>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2.4M12 19.1v2.4M2.5 12h2.4M19.1 12h2.4M5.3 5.3L7 7M17 17l1.7 1.7M18.7 5.3L17 7M7 17l-1.7 1.7" />
  </>,
);
export const IcCamera = make(
  <>
    <path d="M4 8.5h3l1.6-2.5h6.8L17 8.5h3a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 20 19.5H4A1.5 1.5 0 0 1 2.5 18v-8A1.5 1.5 0 0 1 4 8.5z" />
    <circle cx="12" cy="13.5" r="3.4" />
  </>,
);
export const IcFrame = make(<path d="M8 3v18M16 3v18M3 8h18M3 16h18" opacity={0.9} />);
export const IcHistory = make(
  <>
    <path d="M4.5 5v4h4" />
    <path d="M4.8 9A8 8 0 1 1 4 12" />
    <path d="M12 8v4.5l3 1.8" />
  </>,
);
export const IcUndo = make(
  <>
    <path d="M8 6L4 10l4 4" />
    <path d="M4.5 10H15a5 5 0 0 1 0 10h-3" />
  </>,
);
export const IcRedo = make(
  <>
    <path d="M16 6l4 4-4 4" />
    <path d="M19.5 10H9a5 5 0 0 0 0 10h3" />
  </>,
);
export const IcGift = make(
  <>
    <rect x="4" y="10.5" width="16" height="10" rx="1.5" />
    <path d="M3.5 6.5h17v4h-17zM12 6.5v14" />
    <path d="M12 6.5C10 3 6.5 3.5 6.5 5.5S10 7 12 6.5zM12 6.5C14 3 17.5 3.5 17.5 5.5S14 7 12 6.5z" />
  </>,
);
export const IcPlanet = make(
  <>
    <circle cx="12" cy="12" r="6" />
    <path
      d="M3.5 14.5c2-.5 4.5-1.4 7.3-2.7 3.5-1.6 6.8-3.5 9.7-5.3M3.5 9.5c2 .5 4.6 1.4 7.3 2.7 3.5 1.6 6.7 3.4 9.7 5.3"
      opacity={0.7}
    />
  </>,
);
export const IcPrinter = make(
  <>
    <path d="M12 3.5l5.5 3v5.5l-5.5 3-5.5-3V6.5z" />
    <path d="M12 9.5v5.5M6.7 6.8L12 9.5l5.3-2.7" opacity={0.7} />
    <path d="M4 18.5h16M6.5 21h11" />
  </>,
);
export const IcStar = make(
  <path d="M12 3.5l2.5 5.4 5.9.7-4.4 4 1.2 5.9-5.2-3-5.2 3 1.2-5.9-4.4-4 5.9-.7z" />,
);
export const IcShare = make(
  <>
    <path d="M13 5.5c4.5.6 7.2 3.6 7.5 8.5-1.9-2.4-4.3-3.6-7.5-3.5v3.6L5 8.9l8-5z" />
    <path d="M4 14v4.5A1.5 1.5 0 0 0 5.5 20H17" opacity={0.7} />
  </>,
);
export const IcDownload = make(
  <>
    <path d="M12 4v10.5M7.5 10.5L12 15l4.5-4.5" />
    <path d="M4.5 15.5v2.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-2.5" />
  </>,
);
export const IcSliders = make(
  <>
    <path d="M5 6.5h14M5 12h14M5 17.5h14" opacity={0.6} />
    <circle cx="9" cy="6.5" r="1.8" fill="var(--pd-bg-raised)" />
    <circle cx="15" cy="12" r="1.8" fill="var(--pd-bg-raised)" />
    <circle cx="7.5" cy="17.5" r="1.8" fill="var(--pd-bg-raised)" />
  </>,
);
export const IcEye = make(
  <>
    <path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z" />
    <circle cx="12" cy="12" r="2.8" />
  </>,
);
export const IcEyeOff = make(
  <>
    <path d="M4 4l16 16" />
    <path d="M10 5.9a9.6 9.6 0 0 1 2-.1c6 0 9.5 6.2 9.5 6.2a17.6 17.6 0 0 1-3.2 3.9M6.6 6.8A17 17 0 0 0 2.5 12S6 18.2 12 18.2a9 9 0 0 0 3.4-.7" />
  </>,
);
export const IcDots = make(
  <>
    <circle cx="5" cy="12" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="19" cy="12" r="1.1" fill="currentColor" stroke="none" />
  </>,
);
export const IcInfo = make(
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5" />
    <circle cx="12" cy="7.8" r="0.5" fill="currentColor" />
  </>,
);
export const IcGrid4 = make(
  <>
    <circle cx="8" cy="8" r="1.7" fill="currentColor" stroke="none" />
    <circle cx="16" cy="8" r="1.7" fill="currentColor" stroke="none" />
    <circle cx="8" cy="16" r="1.7" fill="currentColor" stroke="none" />
    <circle cx="16" cy="16" r="1.7" fill="currentColor" stroke="none" />
  </>,
);
export const IcFilter = make(<path d="M4 6h16M7 12h10M10 18h4" />);
export const IcManage = make(
  <>
    <rect x="3.5" y="5" width="13" height="13" rx="2" />
    <path d="M7 11.5l2.5 2.5 4.5-5" />
    <path d="M20.5 8v8.5a3 3 0 0 1-3 3H9" opacity={0.6} />
  </>,
);
export const IcArmature = make(
  <>
    <rect x="3.5" y="3.5" width="5" height="5" rx="1" />
    <rect x="15.5" y="15.5" width="5" height="5" rx="1" />
    <path d="M8.5 8.5l7 7" />
    <circle cx="12" cy="12" r="0.6" fill="currentColor" />
  </>,
);
export const IcBoxNode = make(
  <>
    <path d="M12 4.5l6.5 3.7v7.6L12 19.5l-6.5-3.7V8.2z" />
    <path d="M12 12l6.5-3.8M12 12L5.5 8.2M12 12v7.5" opacity={0.6} />
  </>,
);
export const IcRootNode = make(
  <>
    <circle cx="12" cy="6" r="2.5" />
    <path d="M12 8.5v4M6.5 18.5c0-3 2.2-5.5 5.5-5.5s5.5 2.5 5.5 5.5" />
  </>,
);
export const IcRig = make(
  <>
    <path d="M4 4l5.5 2 6-1.5 4.5 3-2 5.5 1 5-5.5-1.5-5 2-3-4.5L4 9z" opacity={0.85} />
    <path
      d="M4 4l7 6.5M11 10.5l4.5-6M11 10.5l2.5 7.5M11 10.5l-5.5 3M18 12.5l-4.5 5.5"
      opacity={0.6}
    />
  </>,
);
export const IcMouse = make(
  <>
    <rect x="7" y="3.5" width="10" height="17" rx="5" />
    <path d="M12 7v3.5" />
  </>,
);
export const IcTrackpad = make(
  <>
    <rect x="3.5" y="6" width="17" height="12" rx="2.5" />
    <path d="M12 14v4M3.5 14h17" opacity={0.7} />
  </>,
);
export const IcTrash = make(
  <>
    <path d="M4.5 6.5h15M9.5 6V4.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V6" />
    <path d="M6.5 6.5l.8 12a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9l.8-12" />
    <path d="M10 10.5v6M14 10.5v6" />
  </>,
);
export const IcPlus = make(<path d="M12 5v14M5 12h14" />);
export const IcLayers = make(
  <>
    <path d="M12 3.5l9 4.7-9 4.7-9-4.7z" />
    <path d="M3.5 12.6L12 17l8.5-4.4M3.5 16.4L12 20.8l8.5-4.4" />
  </>,
);
