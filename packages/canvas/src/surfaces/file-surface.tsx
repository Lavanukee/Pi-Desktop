import { Markdown } from '@pi-desktop/ui';
import { type ReactNode, type RefObject, useCallback, useEffect, useRef } from 'react';
import type { ArtifactContent } from '../model.ts';
import type { FileViewMode } from '../tabs/tab-model.ts';
import { CodeSurface } from './code-surface.tsx';
import { HtmlSurface } from './html-surface.tsx';
import { SvgSurface } from './svg-surface.tsx';

/** Content kinds that have a real RENDERED form (vs. raw source) — a file of one
 * of these gets the rendered↔raw toggle and defaults to Rendered (jedd). */
function isRenderableKind(kind: ArtifactContent['kind']): boolean {
  return kind === 'markdown' || kind === 'html' || kind === 'svg';
}

/** Sensible default view for a file: renderable kinds (md/html/svg) render,
 * everything else is raw. */
export function defaultFileViewMode(content: ArtifactContent): FileViewMode {
  return isRenderableKind(content.kind) ? 'rendered' : 'raw';
}

/**
 * Stick-to-bottom that RESPECTS the user (round-9 free-scroll). While `active`
 * (the file is streaming in), the scroller is pinned to the newest line on each
 * delta — but ONLY when the user is already parked at the bottom. Any upward
 * intent (wheel up, ArrowUp/PageUp/Home, a downward touch-drag) releases the pin
 * so a burst of write deltas can never yank the reader back down; returning to
 * the bottom re-arms it. Mirrors ChatThread's app-side fix for canvas surfaces.
 *
 * Wheel/key/touch bubble to the stable `bodyRef` container, so one listener set
 * covers whichever scroller is mounted (CodeMirror's `.cm-scroller` or the
 * markdown pane); the non-bubbling `scroll` event is caught in the capture phase.
 */
function useStickToBottom(
  bodyRef: RefObject<HTMLDivElement | null>,
  active: boolean,
  deltaKey: unknown,
): void {
  const pinnedRef = useRef(true);

  const getScroller = useCallback((): HTMLElement | null => {
    const body = bodyRef.current;
    if (!body) return null;
    return (
      body.querySelector<HTMLElement>('.cm-scroller') ??
      body.querySelector<HTMLElement>('.pd-canvas-markdown')
    );
  }, [bodyRef]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const release = (): void => {
      pinnedRef.current = false;
    };
    const onWheel = (e: WheelEvent): void => {
      if (e.deltaY < 0) release();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'Home') release();
    };
    let lastY = 0;
    const onTouchStart = (e: TouchEvent): void => {
      lastY = e.touches[0]?.clientY ?? 0;
    };
    const onTouchMove = (e: TouchEvent): void => {
      const y = e.touches[0]?.clientY ?? 0;
      if (y > lastY + 1) release(); // finger drags down → content moves up
      lastY = y;
    };
    // Re-arm only when the CURRENT scroller is genuinely back at the bottom (tight
    // threshold so scrolling even slightly up stays released).
    const onScroll = (e: Event): void => {
      const el = e.target as HTMLElement | null;
      if (el === null || typeof el.scrollHeight !== 'number') return;
      pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 16;
    };
    body.addEventListener('wheel', onWheel, { passive: true });
    body.addEventListener('keydown', onKey);
    body.addEventListener('touchstart', onTouchStart, { passive: true });
    body.addEventListener('touchmove', onTouchMove, { passive: true });
    // `scroll` doesn't bubble → listen in the capture phase on the container.
    body.addEventListener('scroll', onScroll, true);
    return () => {
      body.removeEventListener('wheel', onWheel);
      body.removeEventListener('keydown', onKey);
      body.removeEventListener('touchstart', onTouchStart);
      body.removeEventListener('touchmove', onTouchMove);
      body.removeEventListener('scroll', onScroll, true);
    };
  }, [bodyRef]);

  // Keep the newest content in view on each delta — ONLY while pinned. Child
  // effects (which apply the code/markdown delta) run before this parent effect,
  // so the scroller height already reflects the new content. `deltaKey`
  // (content.text) is the per-delta re-run trigger.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on each delta.
  useEffect(() => {
    if (!active || !pinnedRef.current) return;
    const scroller = getScroller();
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [deltaKey, active, getScroller]);
}

export interface FileSurfaceProps {
  content: ArtifactContent;
  filename?: string;
  /**
   * LIVE mode: the file is still being written. The underlying code viewer
   * reconciles appended text without resetting scroll, and the surface
   * auto-scrolls to the newest line on each delta WHILE the user is at the
   * bottom (see {@link useStickToBottom}).
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
  /**
   * Make the raw/code view an EDITABLE buffer (round-9 write-back). Ignored for
   * the rendered-markdown view (prose is not edited in place). Only enable for a
   * real, finalized on-disk file — pair with {@link onSave}.
   */
  editable?: boolean;
  /** Persist the edited buffer (⌘/Ctrl-S in the raw editor). */
  onSave?: (text: string) => void;
  /** Slot for future inline editing UI (overlaid below the viewer). */
  children?: ReactNode;
  className?: string;
  /**
   * Live line-diff counts (a corp worker writing this file NOW): a small +N/−N
   * badge overlays the surface. Both unset/zero → no badge (an ordinary chat file
   * tab shows nothing), so this stays inert outside a corp run.
   */
  addedLines?: number;
  removedLines?: number;
}

/** The +N/−N diff badge shown while a file streams in (corp file tabs). Renders
 * nothing when there is no line delta to report. */
function FileDiffBadge({ added, removed }: { added?: number; removed?: number }) {
  const a = added ?? 0;
  const r = removed ?? 0;
  if (a <= 0 && r <= 0) return null;
  return (
    <div className="pd-file-diff-badge" data-testid="file-diff-badge" aria-hidden="true">
      {a > 0 ? <span className="pd-file-diff-add">+{a}</span> : null}
      {r > 0 ? <span className="pd-file-diff-del">−{r}</span> : null}
    </div>
  );
}

/**
 * FileSurface — a file viewer that reuses the existing renderers: markdown files
 * render as Prose, everything else as the CodeMirror viewer. It accepts STREAMING
 * content — a file tab can open empty and fill incrementally as the model writes
 * it (`controller.updateTab(id, { artifact, streaming })`) — and while
 * `streaming` it sticks to the newest content on each delta only while the user
 * is parked at the bottom (free-scroll). In `raw` view an on-disk file can be
 * made {@link editable} for save-back.
 */
export function FileSurface({
  content,
  filename,
  streaming = false,
  mode,
  showFilename = true,
  onCopy,
  editable = false,
  onSave,
  children,
  className,
  addedLines,
  removedLines,
}: FileSurfaceProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const view = mode ?? defaultFileViewMode(content);
  // Rendered view for the renderable kinds: markdown → rich prose, html → the
  // sandboxed live frame (same surface + containment as an html artifact tab),
  // svg → the sanitized inline draw. Raw (and every non-renderable kind, e.g. a
  // .ts file) → the CodeMirror source viewer. (jedd: html/svg files get the same
  // rendered↔raw toggle markdown already had; images stay always-rendered — they
  // never route here, they open on the media surface.)
  const rendered = view === 'rendered' && isRenderableKind(content.kind);

  useStickToBottom(bodyRef, streaming, content.text);

  const rootClass = ['pd-file', className].filter(Boolean).join(' ');
  return (
    <div className={rootClass}>
      <FileDiffBadge added={addedLines} removed={removedLines} />
      {showFilename && filename ? <div className="pd-file-name">{filename}</div> : null}
      <div ref={bodyRef} className="pd-file-body">
        {rendered ? (
          content.kind === 'html' ? (
            <HtmlSurface content={content} streaming={streaming} />
          ) : content.kind === 'svg' ? (
            <SvgSurface content={content} streaming={streaming} />
          ) : (
            <div className="pd-canvas-markdown pd-scroll">
              <Markdown>{content.text}</Markdown>
            </div>
          )
        ) : (
          <CodeSurface
            content={content}
            streaming={streaming}
            onCopy={onCopy}
            // Editing is only meaningful on a static buffer — never mid-write.
            editable={editable && !streaming}
            onSave={onSave}
          />
        )}
      </div>
      {children}
    </div>
  );
}
