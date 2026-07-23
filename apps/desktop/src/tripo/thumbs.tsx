/**
 * SVG artwork for the Bobble 3D studio: the animation-preset mannequin pose
 * glyphs and the logo mark. Every fill/stroke resolves to a --pd-*-derived
 * custom property so the artwork re-tints with flavor + light/dark.
 * NOTE: asset thumbnails are NOT drawn here — the Assets grid shows real
 * rendered previews captured by the viewer (see Viewer3D captureThumb).
 */
import type { JSX } from 'react';

// ── shared palette handles (defined in tripo.css) ─────────────────────────
const C1 = 'var(--tp-clay-1)'; // lightest clay
const C2 = 'var(--tp-clay-2)';
const C3 = 'var(--tp-clay-3)'; // darkest clay
const ACC = 'var(--pd-accent-primary)';

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
