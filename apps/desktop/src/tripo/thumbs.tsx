/**
 * Decorative SVG artwork for the Tripo workspace: asset-grid thumbnails, the
 * animation-preset mannequin, the per-tool panel illustrations, and the logo
 * mark. Every fill/stroke resolves to a `--pd-*`-derived custom property
 * (`--tp-*`, defined in tripo.css via color-mix), so the artwork re-tints
 * with flavor + light/dark like the rest of the app. No raster assets.
 */
import type { JSX } from 'react';
import type { TripoAsset } from './data';

// ── shared palette handles (defined in tripo.css) ─────────────────────────
const C1 = 'var(--tp-clay-1)'; // lightest clay
const C2 = 'var(--tp-clay-2)';
const C3 = 'var(--tp-clay-3)'; // darkest clay
const ACC = 'var(--pd-accent-primary)';
const WARM = 'var(--pd-status-warning-fg)';

// ── asset thumbnails ──────────────────────────────────────────────────────
function BoyArt(): JSX.Element {
  return (
    <g>
      {/* t-pose character: hat + head + shirt + arms + trousers */}
      <ellipse cx="50" cy="88" rx="26" ry="4" fill={C3} opacity={0.5} />
      <path d="M31 33h38l-3-7a16 16 0 0 0-32 0z" fill={ACC} />
      <rect x="28" y="31" width="44" height="5" rx="2.5" fill={C3} />
      <circle cx="50" cy="42" r="10" fill={C1} />
      <circle cx="46" cy="41" r="1.4" fill={C3} />
      <circle cx="54" cy="41" r="1.4" fill={C3} />
      <rect x="40" y="52" width="20" height="18" rx="6" fill={C1} />
      <rect x="14" y="54" width="26" height="7" rx="3.5" fill={C1} />
      <rect x="60" y="54" width="26" height="7" rx="3.5" fill={C1} />
      <rect x="42" y="69" width="7" height="14" rx="3" fill={C2} />
      <rect x="51" y="69" width="7" height="14" rx="3" fill={C2} />
      <rect x="41" y="82" width="9" height="5" rx="2" fill={C3} />
      <rect x="50" y="82" width="9" height="5" rx="2" fill={C3} />
    </g>
  );
}
function CottageArt(): JSX.Element {
  return (
    <g>
      <ellipse cx="50" cy="86" rx="30" ry="5" fill={C3} opacity={0.5} />
      <rect x="28" y="48" width="44" height="34" rx="3" fill={C2} />
      <path d="M22 52L50 24l28 28z" fill={C3} />
      <rect x="60" y="30" width="7" height="12" rx="1.5" fill={C3} />
      <rect x="43" y="60" width="13" height="22" rx="6" fill={C3} />
      <circle cx="53" cy="71" r="1.3" fill={C1} />
      <rect x="31" y="56" width="9" height="9" rx="2" fill={C1} />
      <rect x="61" y="56" width="9" height="9" rx="2" fill={C1} />
      <path d="M25 52h50" stroke={C1} strokeWidth="2" strokeLinecap="round" />
    </g>
  );
}
function FireplaceArt(): JSX.Element {
  return (
    <g>
      <rect x="24" y="26" width="52" height="58" rx="4" fill={C3} />
      <rect x="20" y="22" width="60" height="7" rx="3" fill={C2} />
      <path d="M34 84V52a16 16 0 0 1 32 0v32z" fill="var(--pd-bg-inset)" />
      <path
        d="M50 76c-6 0-9-4-9-8 0-5 4-6 4-10 3 2 3 4 3 6 1-3 2-6 2-10 5 3 8 7 8 13s-3 9-8 9z"
        fill={WARM}
      />
      <circle cx="30" cy="38" r="2" fill={C1} opacity={0.7} />
      <circle cx="70" cy="38" r="2" fill={C1} opacity={0.7} />
      <rect x="26" y="84" width="48" height="4" rx="2" fill={C2} />
    </g>
  );
}
function DancerArt(): JSX.Element {
  return (
    <g>
      <ellipse cx="50" cy="88" rx="22" ry="4" fill={C3} opacity={0.5} />
      <circle cx="50" cy="26" r="7" fill={C1} />
      <circle cx="50" cy="17" r="3.5" fill={C2} />
      <rect x="45" y="33" width="10" height="12" rx="4" fill={C1} />
      <path d="M50 42L28 70h44z" fill={C1} opacity={0.92} />
      <path d="M44 55l-16 8M56 55l16 8" stroke={C1} strokeWidth="4.5" strokeLinecap="round" />
      <path d="M45 70v14M55 70v14" stroke={C2} strokeWidth="4" strokeLinecap="round" />
      <path d="M43 86h5M53 86h5" stroke={C3} strokeWidth="3.5" strokeLinecap="round" />
    </g>
  );
}
function SofaArt(): JSX.Element {
  return (
    <g>
      <rect x="16" y="34" width="68" height="30" rx="8" fill={C2} />
      <rect x="12" y="50" width="14" height="26" rx="6" fill={C3} />
      <rect x="74" y="50" width="14" height="26" rx="6" fill={C3} />
      <rect x="22" y="56" width="56" height="18" rx="5" fill={C1} />
      <path d="M50 56v18" stroke={C3} strokeWidth="1.6" />
      <circle cx="33" cy="45" r="1.3" fill={C3} />
      <circle cx="50" cy="45" r="1.3" fill={C3} />
      <circle cx="67" cy="45" r="1.3" fill={C3} />
      <path d="M24 76v6M76 76v6" stroke={C3} strokeWidth="4" strokeLinecap="round" />
    </g>
  );
}
function BustArt(): JSX.Element {
  return (
    <g>
      <rect x="34" y="76" width="32" height="8" rx="2.5" fill={C3} />
      <path d="M38 76c0-8 6-11 12-11s12 3 12 11z" fill={C2} />
      <path d="M36 62c4-4 8-4 14-4s10 0 14 4l-6 14H42z" fill={C1} />
      <circle cx="50" cy="42" r="12" fill={C1} />
      <path d="M38 40c0-9 5-14 12-14s12 5 12 14c-3-5-6-7-12-7s-9 2-12 7z" fill={C2} />
      <path
        d="M41 27l3-5 3 4 3-5 3 5 3-4 3 5"
        stroke={ACC}
        strokeWidth="2"
        fill="none"
        strokeLinejoin="round"
      />
      <circle cx="46" cy="42" r="1.2" fill={C3} />
      <circle cx="54" cy="42" r="1.2" fill={C3} />
    </g>
  );
}
function DioramaArt(): JSX.Element {
  return (
    <g>
      <ellipse cx="50" cy="80" rx="32" ry="9" fill={C3} />
      <ellipse cx="50" cy="77" rx="32" ry="9" fill={C2} />
      <path d="M34 74v-16a16 16 0 0 1 32 0v16" fill="none" stroke={C1} strokeWidth="7" />
      <rect x="30" y="42" width="5" height="30" rx="2" fill={C3} />
      <rect x="65" y="42" width="5" height="30" rx="2" fill={C3} />
      <path d="M24 44l26-14 26 14z" fill={C1} />
      <path d="M50 52v10" stroke={C3} strokeWidth="2" />
      <rect x="45" y="60" width="10" height="8" rx="2" fill={ACC} />
    </g>
  );
}
function MechArt(): JSX.Element {
  return (
    <g>
      <ellipse cx="50" cy="88" rx="26" ry="4" fill={C3} opacity={0.5} />
      <rect x="38" y="24" width="24" height="16" rx="5" fill={C1} />
      <rect x="44" y="30" width="12" height="5" rx="2.5" fill={ACC} />
      <rect x="34" y="42" width="32" height="24" rx="6" fill={C2} />
      <rect x="18" y="44" width="12" height="18" rx="5" fill={C3} />
      <rect x="70" y="44" width="12" height="18" rx="5" fill={C3} />
      <rect x="38" y="68" width="10" height="16" rx="4" fill={C3} />
      <rect x="52" y="68" width="10" height="16" rx="4" fill={C3} />
    </g>
  );
}

const ART: Record<TripoAsset['art'], () => JSX.Element> = {
  boy: BoyArt,
  cottage: CottageArt,
  fireplace: FireplaceArt,
  dancer: DancerArt,
  sofa: SofaArt,
  bust: BustArt,
  diorama: DioramaArt,
  mech: MechArt,
};

export function AssetThumb({ art }: { readonly art: TripoAsset['art'] }): JSX.Element {
  const Art = ART[art];
  return (
    <svg viewBox="0 0 100 100" className="tp-asset-art" aria-hidden="true">
      <Art />
    </svg>
  );
}

// ── animation mannequin ───────────────────────────────────────────────────
/** Limb endpoints: [elbow/knee, hand/foot], relative to shoulder (0,-22) /
 * hip (0,0). Hand-authored per preset so each card reads as its pose. */
interface Pose {
  readonly ra: readonly [readonly [number, number], readonly [number, number]];
  readonly la: readonly [readonly [number, number], readonly [number, number]];
  readonly rl: readonly [readonly [number, number], readonly [number, number]];
  readonly ll: readonly [readonly [number, number], readonly [number, number]];
  readonly head?: readonly [number, number];
}
const POSES: Record<string, Pose> = {
  angry_01: {
    ra: [
      [13, -34],
      [8, -45],
    ],
    la: [
      [-13, -34],
      [-8, -45],
    ],
    rl: [
      [6, 13],
      [8, 27],
    ],
    ll: [
      [-6, 13],
      [-8, 27],
    ],
  },
  afraid: {
    ra: [
      [10, -13],
      [-3, -9],
    ],
    la: [
      [-10, -13],
      [3, -7],
    ],
    rl: [
      [3, 13],
      [1, 27],
    ],
    ll: [
      [-3, 13],
      [-1, 27],
    ],
    head: [0, 2],
  },
  agree: {
    ra: [
      [12, -17],
      [21, -22],
    ],
    la: [
      [-8, -11],
      [-9, -1],
    ],
    rl: [
      [4, 13],
      [5, 27],
    ],
    ll: [
      [-4, 13],
      [-5, 27],
    ],
  },
  angry_02: {
    ra: [
      [14, -12],
      [6, -4],
    ],
    la: [
      [-14, -12],
      [-6, -4],
    ],
    rl: [
      [5, 13],
      [6, 27],
    ],
    ll: [
      [-5, 13],
      [-6, 27],
    ],
  },
  cheer: {
    ra: [
      [11, -33],
      [17, -44],
    ],
    la: [
      [-11, -33],
      [-17, -44],
    ],
    rl: [
      [7, 12],
      [10, 24],
    ],
    ll: [
      [-5, 13],
      [-6, 27],
    ],
  },
  clap: {
    ra: [
      [11, -14],
      [2, -19],
    ],
    la: [
      [-11, -14],
      [-2, -19],
    ],
    rl: [
      [4, 13],
      [5, 27],
    ],
    ll: [
      [-4, 13],
      [-5, 27],
    ],
  },
  dance_01: {
    ra: [
      [14, -30],
      [22, -38],
    ],
    la: [
      [-13, -12],
      [-20, -4],
    ],
    rl: [
      [8, 11],
      [15, 20],
    ],
    ll: [
      [-3, 13],
      [-4, 27],
    ],
  },
  hello: {
    ra: [
      [14, -29],
      [8, -40],
    ],
    la: [
      [-8, -11],
      [-9, -1],
    ],
    rl: [
      [4, 13],
      [5, 27],
    ],
    ll: [
      [-4, 13],
      [-5, 27],
    ],
  },
  idle: {
    ra: [
      [8, -12],
      [9, -2],
    ],
    la: [
      [-8, -12],
      [-9, -2],
    ],
    rl: [
      [4, 13],
      [5, 27],
    ],
    ll: [
      [-4, 13],
      [-5, 27],
    ],
  },
  jump: {
    ra: [
      [12, -32],
      [20, -40],
    ],
    la: [
      [-12, -32],
      [-20, -40],
    ],
    rl: [
      [7, 8],
      [3, 17],
    ],
    ll: [
      [-7, 8],
      [-3, 17],
    ],
  },
  kick: {
    ra: [
      [12, -16],
      [22, -12],
    ],
    la: [
      [-12, -16],
      [-22, -12],
    ],
    rl: [
      [13, 4],
      [26, -3],
    ],
    ll: [
      [-3, 13],
      [-4, 27],
    ],
  },
  point: {
    ra: [
      [12, -20],
      [25, -21],
    ],
    la: [
      [-8, -11],
      [-9, -1],
    ],
    rl: [
      [4, 13],
      [5, 27],
    ],
    ll: [
      [-4, 13],
      [-5, 27],
    ],
  },
  run: {
    ra: [
      [12, -14],
      [20, -24],
    ],
    la: [
      [-12, -26],
      [-18, -18],
    ],
    rl: [
      [10, 9],
      [20, 16],
    ],
    ll: [
      [-8, 12],
      [-4, 26],
    ],
  },
  sad_01: {
    ra: [
      [6, -11],
      [3, -1],
    ],
    la: [
      [-6, -11],
      [-3, -1],
    ],
    rl: [
      [3, 13],
      [3, 27],
    ],
    ll: [
      [-3, 13],
      [-3, 27],
    ],
    head: [0, 4],
  },
  walk: {
    ra: [
      [9, -13],
      [14, -5],
    ],
    la: [
      [-9, -13],
      [-14, -5],
    ],
    rl: [
      [7, 12],
      [12, 25],
    ],
    ll: [
      [-7, 12],
      [-12, 25],
    ],
  },
  wave: {
    ra: [
      [-8, -11],
      [-9, -1],
    ],
    la: [
      [14, -29],
      [8, -40],
    ],
    rl: [
      [4, 13],
      [5, 27],
    ],
    ll: [
      [-4, 13],
      [-5, 27],
    ],
  },
};

export function Mannequin({ pose }: { readonly pose: string }): JSX.Element {
  const p = POSES[pose] ?? POSES.idle;
  if (p === undefined) return <svg viewBox="-32 -52 64 84" aria-hidden="true" />;
  const sh: readonly [number, number] = [0, -22];
  const limb = (
    from: readonly [number, number],
    seg: readonly [readonly [number, number], readonly [number, number]],
    offY: number,
  ) => {
    const a = seg[0];
    const b = seg[1];
    return `M${from[0]},${from[1]} L${a[0]},${a[1] + offY} L${b[0]},${b[1] + offY}`;
  };
  const head = p.head ?? [0, 0];
  return (
    <svg viewBox="-32 -52 64 84" className="tp-mannequin" aria-hidden="true">
      <ellipse cx="0" cy="29" rx="15" ry="2.5" fill={C3} opacity={0.55} />
      <path
        d={limb(sh, p.ra, 0)}
        stroke={C2}
        strokeWidth="4.6"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d={limb(sh, p.la, 0)}
        stroke={C2}
        strokeWidth="4.6"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d={limb([0, 0], p.rl, 0)}
        stroke={C2}
        strokeWidth="5"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d={limb([0, 0], p.ll, 0)}
        stroke={C2}
        strokeWidth="5"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M0,-24 L0,1" stroke={C1} strokeWidth="7.5" strokeLinecap="round" />
      <circle cx={head[0]} cy={-31 + head[1]} r="5.6" fill={C1} />
      <path
        d="M-2.4,-14 l2.4,3 2.4,-3"
        stroke={ACC}
        strokeWidth="1.6"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ── panel illustrations ───────────────────────────────────────────────────
function PartsFigure({ exploded }: { readonly exploded: boolean }): JSX.Element {
  const d = exploded ? 7 : 0;
  return (
    <g>
      <circle cx={0} cy={-26 - d} r={9} fill="var(--pd-status-danger-fg)" opacity={0.9} />
      <rect
        x={-9}
        y={-16}
        width={18}
        height={20}
        rx={6}
        fill="var(--pd-status-warning-fg)"
        opacity={0.9}
      />
      <rect
        x={-22 - d}
        y={-14}
        width={10}
        height={16}
        rx={5}
        fill="var(--pd-status-success-fg)"
        opacity={0.9}
      />
      <rect
        x={12 + d}
        y={-14}
        width={10}
        height={16}
        rx={5}
        fill="var(--pd-status-success-fg)"
        opacity={0.9}
      />
      <rect
        x={-10 - d / 2}
        y={6 + d}
        width={9}
        height={18}
        rx={4.5}
        fill="var(--pd-status-info-fg)"
        opacity={0.9}
      />
      <rect
        x={1 + d / 2}
        y={6 + d}
        width={9}
        height={18}
        rx={4.5}
        fill="var(--pd-status-info-fg)"
        opacity={0.9}
      />
    </g>
  );
}
export function SegmentIllustration(): JSX.Element {
  return (
    <svg viewBox="0 0 240 100" className="tp-illustration" aria-hidden="true">
      <g transform="translate(58,52)">
        <PartsFigure exploded={false} />
      </g>
      <path
        d="M108 52h20m0 0l-6-5m6 5l-6 5"
        stroke={ACC}
        strokeWidth="3"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <g transform="translate(180,52)">
        <PartsFigure exploded />
      </g>
    </svg>
  );
}

function FigureSilhouette({ x, tone }: { readonly x: number; readonly tone: string }): JSX.Element {
  return (
    <g transform={`translate(${x},50)`}>
      <circle cx="0" cy="-28" r="8" fill={tone} />
      <path d="M-14 -18 h28 l-4 26 h-20z" fill={tone} />
      <path d="M-14 -16 l-9 20 M14 -16 l9 20" stroke={tone} strokeWidth="6" strokeLinecap="round" />
      <path d="M-7 8 l-3 24 M7 8 l3 24" stroke={tone} strokeWidth="7" strokeLinecap="round" />
    </g>
  );
}
export function RetopoIllustration(): JSX.Element {
  return (
    <svg viewBox="0 0 240 100" className="tp-illustration" aria-hidden="true">
      <defs>
        <clipPath id="tpRetopoL">
          <path
            d="M30 22a8 8 0 0 1 16 0v0c6 0 10 4 10 4l-4 26-3 30h-6l-3-24-3 24h-6l-3-30-4-26s4-4 10-4z"
            transform="translate(20,0)"
          />
        </clipPath>
      </defs>
      <FigureSilhouette x={58} tone={C3} />
      <g stroke={C1} strokeWidth="0.6" opacity={0.8}>
        {Array.from({ length: 12 }, (_, i) => `M${34 + i * 4} 14 l ${(i % 3) - 1} 72`).map((d) => (
          <path key={d} d={d} />
        ))}
        {Array.from({ length: 10 }, (_, i) => `M30 ${18 + i * 7} q 28 ${(i % 2) * 6 - 3} 56 0`).map(
          (d) => (
            <path key={d} d={d} />
          ),
        )}
      </g>
      <path
        d="M108 52h20m0 0l-6-5m6 5l-6 5"
        stroke={ACC}
        strokeWidth="3"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <FigureSilhouette x={180} tone={C2} />
      <g stroke="var(--pd-bg-inset)" strokeWidth="1.1" opacity={0.9}>
        {Array.from({ length: 6 }, (_, i) => `M${158 + i * 9} 16 v72`).map((d) => (
          <path key={d} d={d} />
        ))}
        {Array.from({ length: 7 }, (_, i) => `M154 ${20 + i * 10} h54`).map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
    </svg>
  );
}
export function TextureIllustration(): JSX.Element {
  return (
    <svg viewBox="0 0 240 100" className="tp-illustration" aria-hidden="true">
      <FigureSilhouette x={58} tone={C1} />
      <path
        d="M108 52h20m0 0l-6-5m6 5l-6 5"
        stroke={ACC}
        strokeWidth="3"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <FigureSilhouette x={180} tone={C3} />
      <g transform="translate(180,50)">
        <path d="M-14 -18 h28 l-2 12 h-24z" fill={ACC} opacity={0.85} />
        <circle cx="0" cy="-28" r="8" fill={C2} />
        <path d="M-8 -30 a8 8 0 0 1 16 0" fill="var(--pd-status-danger-fg)" opacity={0.8} />
        <path
          d="M-7 8 l-3 24 M7 8 l3 24"
          stroke={ACC}
          strokeWidth="7"
          strokeLinecap="round"
          opacity={0.75}
        />
      </g>
    </svg>
  );
}

export function QuadThumb(): JSX.Element {
  return (
    <svg viewBox="0 0 80 80" className="tp-unavail-art" aria-hidden="true">
      <path d="M28 14h24l6 10v32l-6 10H28l-6-10V24z" fill={C2} />
      <g stroke={C3} strokeWidth="1" opacity={0.75}>
        <path d="M28 14v52M40 12v56M52 14v52M22 26h36M22 40h36M22 54h36" />
      </g>
      <rect x="34" y="4" width="12" height="10" rx="2" fill={C3} />
    </svg>
  );
}
export function RiggedThumb(): JSX.Element {
  return (
    <svg viewBox="0 0 80 80" className="tp-unavail-art" aria-hidden="true">
      <FigureSilhouette x={40} tone={C3} />
      <g stroke={ACC} strokeWidth="1.6" opacity={0.95}>
        <path d="M40 14v34M40 32l-11 16M40 32l11 16M40 20l-12 10M40 20l12 10" />
      </g>
      <g fill={ACC}>
        <circle cx="40" cy="14" r="2.2" />
        <circle cx="40" cy="32" r="2.2" />
        <circle cx="28" cy="30" r="2" />
        <circle cx="52" cy="30" r="2" />
        <circle cx="29" cy="48" r="2" />
        <circle cx="51" cy="48" r="2" />
      </g>
    </svg>
  );
}

// ── logo mark ─────────────────────────────────────────────────────────────
/** Bobble 3D mark — a stylized isometric cube (three tonal faces). */
export function LogoMark({ size = 26 }: { readonly size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" className="tp-logomark">
      <path d="M24 6 L41 15 L24 24 L7 15 Z" fill="currentColor" opacity={0.95} />
      <path d="M7 15 L24 24 L24 43 L7 34 Z" fill="currentColor" opacity={0.55} />
      <path d="M41 15 L41 34 L24 43 L24 24 Z" fill="currentColor" opacity={0.75} />
    </svg>
  );
}
