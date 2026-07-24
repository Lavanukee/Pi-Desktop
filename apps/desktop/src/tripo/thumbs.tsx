/**
 * SVG artwork for the Bobble 3D studio — just the logo mark now. Asset
 * thumbnails are real viewer-captured renders; animation preset previews are
 * real skeletal-animation videos (assets/anim-previews).
 */
import type { JSX } from 'react';

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
