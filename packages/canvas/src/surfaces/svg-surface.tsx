import { useEffect, useRef } from 'react';
import type { SurfaceProps } from '../registry.ts';
import { sanitizeSvg } from '../sanitize.ts';

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)
  );
}

/**
 * SVG surface — live-draw. While streaming, the growing (possibly incomplete)
 * SVG buffer is DOMPurify-sanitized and injected on a requestAnimationFrame,
 * coalescing bursts of deltas into at most one render per frame so partial SVG
 * draws progressively without thrashing. The final frame (and reduced-motion)
 * renders synchronously. Sanitization is the HARD trust boundary: this SVG is
 * injected INLINE into the app origin, so `<script>`/handlers must be stripped.
 */
export function SvgSurface({ content, streaming }: SurfaceProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const pendingRef = useRef<string>('');
  const frameRef = useRef<number | undefined>(undefined);
  const scheduledRef = useRef(false);

  useEffect(() => {
    pendingRef.current = content.text;

    const flush = (): void => {
      scheduledRef.current = false;
      frameRef.current = undefined;
      const host = hostRef.current;
      if (host) host.innerHTML = sanitizeSvg(pendingRef.current);
    };

    if (!streaming || prefersReducedMotion()) {
      if (scheduledRef.current && frameRef.current !== undefined) {
        cancelAnimationFrame(frameRef.current);
      }
      flush();
      return;
    }

    if (!scheduledRef.current) {
      scheduledRef.current = true;
      frameRef.current = requestAnimationFrame(flush);
    }
  }, [content.text, streaming]);

  useEffect(
    () => () => {
      if (scheduledRef.current && frameRef.current !== undefined) {
        cancelAnimationFrame(frameRef.current);
      }
    },
    [],
  );

  return <div ref={hostRef} className="pd-canvas-svg pd-scroll" />;
}
