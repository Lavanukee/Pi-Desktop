import {
  Button,
  IconButton,
  IconChevronDown,
  IconClose,
  IconRefresh,
  Spinner,
} from '@pi-desktop/ui';
import { useEffect, useReducer, useRef, useState } from 'react';
import { IconDownload, IconExpand } from '../tab-icons.tsx';
import type { MediaPreviewStatus } from '../tabs/tab-model.ts';

export type { MediaPreviewStatus };

export type MediaPreviewEvent =
  | { type: 'loaded' }
  | { type: 'error' }
  | { type: 'retry' }
  | { type: 'reload' };

/**
 * The media-preview state machine (pure, exported for unit tests):
 *   loading → loaded          (element fired `load`)
 *   loading → error           (element fired `error`)
 *   error   → loading         (`retry` — the [Try again] button)
 *   *       → loading         (`reload` — a new `src` / refresh)
 * `retry` is a no-op unless we're in `error`, so a stray retry can't yank a
 * healthy preview back to a spinner.
 */
export function mediaPreviewTransition(
  status: MediaPreviewStatus,
  event: MediaPreviewEvent,
): MediaPreviewStatus {
  switch (event.type) {
    case 'loaded':
      return 'loaded';
    case 'error':
      return 'error';
    case 'retry':
      return status === 'error' ? 'loading' : status;
    case 'reload':
      return 'loading';
  }
}

export interface MediaPreviewSurfaceProps {
  /** Source URL or data: URI. */
  src?: string;
  /** Upper-cased media type shown in the header ("PNG", "PDF", …). */
  type: string;
  /** "Preview N" index in the header (defaults to 1). */
  index?: number;
  alt?: string;
  /** Controlled status; when omitted the surface derives it from load events. */
  status?: MediaPreviewStatus;
  /** Formats offered in the download split-button's dropdown. */
  downloadFormats?: string[];
  onDownload?: (format: string) => void;
  onRefresh?: () => void;
  onExpand?: () => void;
  onClose?: () => void;
  className?: string;
}

/**
 * MediaPreviewSurface — the image/pdf preview (spec img17): a header
 * "Preview N · TYPE", a "Download as TYPE" split-button, and refresh/expand/close
 * controls, over a body that runs the load state machine: a spinner while
 * loading, the img/pdf when loaded, and a "Failed to load file content" +
 * [Try again] panel on error. The load status is derived from the media
 * element's events unless `status` controls it.
 */
export function MediaPreviewSurface({
  src,
  type,
  index = 1,
  alt,
  status: controlledStatus,
  downloadFormats,
  onDownload,
  onRefresh,
  onExpand,
  onClose,
  className,
}: MediaPreviewSurfaceProps) {
  const [internalStatus, dispatch] = useReducer(mediaPreviewTransition, 'loading');
  // `attempt` re-keys the media element to force a fresh load on retry/reload.
  const [attempt, setAttempt] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Uncontrolled: derive from the element's events, but a missing src can never
  // fire `load`/`error`, so it resolves to `error` immediately (no dead spinner).
  const status = controlledStatus ?? (src ? internalStatus : 'error');
  const isPdf = type.toUpperCase() === 'PDF';
  const formats = downloadFormats ?? [type];

  // A new src is a fresh load — `src` is a re-run trigger, not read in the body.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on src change.
  useEffect(() => {
    dispatch({ type: 'reload' });
    setAttempt((n) => n + 1);
  }, [src]);

  // Close the download menu on any outside pointer-down.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (event: MouseEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  const retry = (): void => {
    dispatch({ type: 'retry' });
    setAttempt((n) => n + 1);
    onRefresh?.();
  };
  const refresh = (): void => {
    dispatch({ type: 'reload' });
    setAttempt((n) => n + 1);
    onRefresh?.();
  };

  const rootClass = ['pd-media', className].filter(Boolean).join(' ');
  return (
    <div className={rootClass}>
      <div className="pd-media-header">
        <span className="pd-media-title">
          Preview {index} · <span className="pd-media-type">{type.toUpperCase()}</span>
        </span>
        <span className="pd-media-spacer" />
        <div ref={menuRef} className="pd-media-download">
          <Button size="sm" variant="secondary" onClick={() => onDownload?.(formats[0] ?? type)}>
            <IconDownload size={14} />
            Download as {(formats[0] ?? type).toUpperCase()}
          </Button>
          {formats.length > 1 ? (
            <>
              <IconButton
                size="sm"
                variant="secondary"
                aria-label="Download options"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((open) => !open)}
              >
                <IconChevronDown size={14} />
              </IconButton>
              {menuOpen ? (
                <div className="pd-media-menu" role="menu">
                  {formats.map((format) => (
                    <button
                      key={format}
                      type="button"
                      role="menuitem"
                      className="pd-media-menu-item"
                      onClick={() => {
                        setMenuOpen(false);
                        onDownload?.(format);
                      }}
                    >
                      {format.toUpperCase()}
                    </button>
                  ))}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
        <IconButton size="sm" aria-label="Refresh preview" onClick={refresh}>
          <IconRefresh size={16} />
        </IconButton>
        <IconButton size="sm" aria-label="Expand preview" onClick={() => onExpand?.()}>
          <IconExpand size={16} />
        </IconButton>
        <IconButton size="sm" aria-label="Close preview" onClick={() => onClose?.()}>
          <IconClose size={16} />
        </IconButton>
      </div>

      <div className="pd-media-body pd-scroll">
        {status === 'error' ? (
          <div className="pd-media-error" role="alert">
            <p className="pd-media-error-title">Failed to load file content</p>
            <Button size="sm" variant="secondary" onClick={retry}>
              Try again
            </Button>
          </div>
        ) : (
          <>
            {status === 'loading' ? (
              <div className="pd-media-status">
                <Spinner size={24} />
              </div>
            ) : null}
            {src && !isPdf ? (
              <img
                key={attempt}
                className="pd-media-image"
                src={src}
                alt={alt ?? `Preview ${index}`}
                data-status={status}
                hidden={status !== 'loaded'}
                onLoad={() => dispatch({ type: 'loaded' })}
                onError={() => dispatch({ type: 'error' })}
              />
            ) : null}
            {src && isPdf ? (
              <iframe
                key={attempt}
                className="pd-media-pdf"
                title={`Preview ${index}`}
                src={src}
                data-status={status}
                hidden={status !== 'loaded'}
                onLoad={() => dispatch({ type: 'loaded' })}
              />
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
