import { Button, Spinner } from '@pi-desktop/ui';
import { useEffect, useReducer, useState } from 'react';
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
  /** Upper-cased media type ("PNG", "PDF", …); selects img vs. pdf iframe. */
  type: string;
  /** Index used for the default alt text ("Preview N"). */
  index?: number;
  alt?: string;
  /** Controlled status; when omitted the surface derives it from load events. */
  status?: MediaPreviewStatus;
  /**
   * Bump to force a fresh load of the SAME `src` — the operation bar's Refresh
   * increments this so a re-fetch (e.g. the file changed on disk) re-keys the
   * media element without changing `src`.
   */
  reloadNonce?: number;
  /** Fired when the in-body [Try again] retry runs (a refetch hint for the app). */
  onRefresh?: () => void;
  className?: string;
}

/**
 * MediaPreviewSurface — the image/pdf preview BODY. The header (name · TYPE,
 * "Download as …", refresh, expand, close) now lives in the per-tab
 * {@link CanvasOperationBar}; this surface runs the load state machine only: a
 * spinner while loading, the img/pdf when loaded, and a "Failed to load file
 * content" + [Try again] panel on error. Status is derived from the media
 * element's events unless `status` controls it, or `reloadNonce` forces a reload.
 */
export function MediaPreviewSurface({
  src,
  type,
  index = 1,
  alt,
  status: controlledStatus,
  reloadNonce = 0,
  onRefresh,
  className,
}: MediaPreviewSurfaceProps) {
  const [internalStatus, dispatch] = useReducer(mediaPreviewTransition, 'loading');
  // `attempt` re-keys the media element to force a fresh load on retry/reload.
  const [attempt, setAttempt] = useState(0);

  // Uncontrolled: derive from the element's events, but a missing src can never
  // fire `load`/`error`, so it resolves to `error` immediately (no dead spinner).
  const status = controlledStatus ?? (src ? internalStatus : 'error');
  const isPdf = type.toUpperCase() === 'PDF';

  // A new src OR a refresh nonce is a fresh load — both re-run trigger, not read
  // in the body.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on src/refresh.
  useEffect(() => {
    dispatch({ type: 'reload' });
    setAttempt((n) => n + 1);
  }, [src, reloadNonce]);

  const retry = (): void => {
    dispatch({ type: 'retry' });
    setAttempt((n) => n + 1);
    onRefresh?.();
  };

  const rootClass = ['pd-media', className].filter(Boolean).join(' ');
  return (
    <div className={rootClass}>
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
