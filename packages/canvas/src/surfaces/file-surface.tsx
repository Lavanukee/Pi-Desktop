import { type ReactNode, useEffect, useRef } from 'react';
import type { ArtifactContent } from '../model.ts';
import { CodeSurface } from './code-surface.tsx';
import { MarkdownSurface } from './markdown-surface.tsx';

export interface FileSurfaceProps {
  content: ArtifactContent;
  filename?: string;
  /**
   * LIVE mode: the file is still being written. The underlying code viewer
   * reconciles appended text without resetting scroll, and the surface
   * auto-scrolls to the newest line on each delta.
   */
  streaming?: boolean;
  onCopy?: (text: string) => void;
  /** Slot for future inline editing UI (overlaid below the viewer). */
  children?: ReactNode;
  className?: string;
}

/**
 * FileSurface — a file viewer that reuses the existing renderers: markdown files
 * render as Prose, everything else as the read-only CodeMirror viewer. It accepts
 * STREAMING content — a file tab can open empty and fill incrementally as the
 * model writes it (`controller.updateTab(id, { artifact, streaming })`) — and
 * while `streaming` it auto-scrolls its scroller to the newest content on each
 * delta. The `children` slot is reserved for the editing affordances a later
 * phase adds.
 */
export function FileSurface({
  content,
  filename,
  streaming = false,
  onCopy,
  children,
  className,
}: FileSurfaceProps) {
  const bodyRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to newest while streaming. Child effects (which apply the code
  // delta) run before this parent effect, so the scroller height is already
  // updated. The scroller is CodeMirror's `.cm-scroller` (code) or the markdown
  // container itself. `content.text` is a re-run trigger (the delta), read from
  // the DOM rather than the closure.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on each delta.
  useEffect(() => {
    if (!streaming) return;
    const body = bodyRef.current;
    if (!body) return;
    const scroller =
      body.querySelector<HTMLElement>('.cm-scroller') ??
      body.querySelector<HTMLElement>('.pd-canvas-markdown');
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [content.text, streaming]);

  const rootClass = ['pd-file', className].filter(Boolean).join(' ');
  return (
    <div className={rootClass}>
      {filename ? <div className="pd-file-name">{filename}</div> : null}
      <div ref={bodyRef} className="pd-file-body">
        {content.kind === 'markdown' ? (
          <MarkdownSurface content={content} streaming={streaming} onCopy={onCopy} />
        ) : (
          <CodeSurface content={content} streaming={streaming} onCopy={onCopy} />
        )}
      </div>
      {children}
    </div>
  );
}
