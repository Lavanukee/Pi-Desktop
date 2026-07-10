import { IconButton } from '@pi-desktop/ui';
import { type ReactNode, useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { Artifact } from './model.ts';
import { defaultSurfaceRegistry, type SurfaceRegistry } from './registry.ts';
import { ensureDefaultSurfaces } from './surfaces/register-builtins.tsx';
import { IconExpand } from './tab-icons.tsx';

/** Kinds that MAY live inline in the chat when small (everything else → canvas). */
const INLINE_ELIGIBLE_KINDS = new Set(['svg', 'html', 'widget']);
/** Default char budget before an inline-eligible artifact is pushed to canvas. */
const DEFAULT_MAX_INLINE_CHARS = 2000;

export interface ShouldGoToCanvasOptions {
  /** Character budget for an inline-eligible artifact before it moves to canvas. */
  maxInlineChars?: number;
}

/**
 * `shouldGoToCanvas` — the inline-vs-canvas routing helper (THEME 2). Returns
 * `true` for anything that belongs in the canvas: any non-simple kind, or a
 * simple svg/html/widget whose content exceeds the inline size budget. The app
 * calls this to decide whether to render an `InlineWidget` in the thread or to
 * `openTab` a canvas surface.
 */
export function shouldGoToCanvas(
  artifact: Artifact,
  options: ShouldGoToCanvasOptions = {},
): boolean {
  const max = options.maxInlineChars ?? DEFAULT_MAX_INLINE_CHARS;
  if (!INLINE_ELIGIBLE_KINDS.has(artifact.content.kind)) return true;
  return (artifact.content.text?.length ?? 0) > max;
}

export interface InlineWidgetProps {
  artifact: Artifact;
  /** Registry used to render the resolved surface (svg/html); default process-wide. */
  registry?: SurfaceRegistry;
  /** Height cap in px. Content beyond is NOT scrolled — the overflow affordance shows. */
  maxHeight?: number;
  /**
   * Emitted by the always-present "Move to canvas" button AND the overflow
   * "Open in canvas" affordance — the app opens the artifact as a NEW canvas tab.
   */
  onMoveToCanvas?: (artifact: Artifact) => void;
  /** Custom widget to render instead of the registry-resolved surface. */
  children?: ReactNode;
  className?: string;
}

/**
 * InlineWidget — the size-capped, NEVER-scrollable chat wrapper for simple
 * widgets (small svg/html). It caps height with `overflow: hidden` (no
 * scrollbar, ever); when the content overflows the cap it fades the bottom and
 * surfaces an "Open in canvas" button instead of scrolling. A "Move to canvas"
 * button is always present. Both emit `onMoveToCanvas(artifact)`.
 */
export function InlineWidget({
  artifact,
  registry,
  maxHeight = 320,
  onMoveToCanvas,
  children,
  className,
}: InlineWidgetProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  if (!registry) ensureDefaultSurfaces();
  const activeRegistry = registry ?? defaultSurfaceRegistry;

  const measure = useCallback(() => {
    const box = boxRef.current;
    if (!box) return;
    // overflow:hidden means scrollHeight is the full content height; clientHeight
    // is the capped box — taller content is what we must NOT scroll.
    setOverflowing(box.scrollHeight > box.clientHeight + 1);
  }, []);

  useLayoutEffect(() => {
    measure();
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(measure);
      if (boxRef.current) observer.observe(boxRef.current);
    }
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [measure]);

  let body: ReactNode = children;
  if (body === undefined) {
    const resolved = activeRegistry.resolve(artifact);
    if (resolved) {
      const Surface = resolved.component;
      body = <Surface content={artifact.content} streaming={false} />;
    }
  }

  const rootClass = ['pd-inline-widget', className].filter(Boolean).join(' ');
  return (
    <div className={rootClass} data-overflowing={overflowing || undefined}>
      <IconButton
        size="sm"
        className="pd-inline-widget-move"
        aria-label="Move to canvas"
        onClick={() => onMoveToCanvas?.(artifact)}
      >
        <IconExpand size={14} />
      </IconButton>
      <div ref={boxRef} className="pd-inline-widget-box" style={{ maxHeight, overflow: 'hidden' }}>
        {body}
      </div>
      {overflowing ? (
        <div className="pd-inline-widget-overflow">
          <button
            type="button"
            className="pd-btn pd-btn--secondary pd-btn--sm pd-inline-widget-open"
            onClick={() => onMoveToCanvas?.(artifact)}
          >
            Open in canvas
          </button>
        </div>
      ) : null}
    </div>
  );
}
