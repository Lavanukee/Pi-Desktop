import { Markdown } from '@pi-desktop/ui';
import { type ReactNode, useEffect, useRef } from 'react';
import type { ArtifactContent } from '../model.ts';
import type { FileViewMode } from '../tabs/tab-model.ts';
import { CodeSurface } from './code-surface.tsx';

/** Sensible default view for a file: markdown renders, everything else is raw. */
export function defaultFileViewMode(content: ArtifactContent): FileViewMode {
  return content.kind === 'markdown' ? 'rendered' : 'raw';
}

export interface FileSurfaceProps {
  content: ArtifactContent;
  filename?: string;
  /**
   * LIVE mode: the file is still being written. The underlying code viewer
   * reconciles appended text without resetting scroll, and the surface
   * auto-scrolls to the newest line on each delta.
   */
  streaming?: boolean;
  /**
   * Raw ↔ rendered view. `rendered` markdown goes through @pi-desktop/ui's
   * Markdown (katex + hex swatches + fenced code); everything else (and `raw`)
   * uses the CodeMirror source viewer. Defaults per file type via
   * {@link defaultFileViewMode}.
   */
  mode?: FileViewMode;
  /**
   * Show the filename header strip. Defaults to `true` for standalone use; the
   * tabbed canvas passes `false` because the operation-bar breadcrumb already
   * names the file (avoids a duplicate header — round-8 #12).
   */
  showFilename?: boolean;
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
  mode,
  showFilename = true,
  onCopy,
  children,
  className,
}: FileSurfaceProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const view = mode ?? defaultFileViewMode(content);
  // Rendered markdown → rich prose; raw markdown + all code → the source viewer.
  const rendered = view === 'rendered' && content.kind === 'markdown';

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
      {showFilename && filename ? <div className="pd-file-name">{filename}</div> : null}
      <div ref={bodyRef} className="pd-file-body">
        {rendered ? (
          <div className="pd-canvas-markdown pd-scroll">
            <Markdown>{content.text}</Markdown>
          </div>
        ) : (
          <CodeSurface content={content} streaming={streaming} onCopy={onCopy} />
        )}
      </div>
      {children}
    </div>
  );
}
