import { IconButton, IconGlobe, IconMore, IconRefresh } from '@pi-desktop/ui';
import { type FormEvent, useEffect, useState } from 'react';
import { IconArrowLeft, IconArrowRight } from '../tab-icons.tsx';
import { type ContentSlotOptions, useContentSlot } from './content-slot.ts';

export interface BrowserSurfaceProps extends ContentSlotOptions {
  /** Current URL; empty/undefined shows the "start browsing" empty state. */
  url?: string;
  loading?: boolean;
  canGoBack?: boolean;
  canGoForward?: boolean;
  /** Show the "model is driving" indicator (browser-use is live). */
  driving?: boolean;
  onNavigate?: (url: string) => void;
  onBack?: () => void;
  onForward?: () => void;
  onReload?: () => void;
  onMenu?: () => void;
  className?: string;
}

/**
 * BrowserSurface — the CHROME for a live web tab (URL bar, back/fwd/refresh, ⋮).
 * The actual page is a native WebContentsView the APP mounts and positions over
 * the content slot: `onMount(el)` hands the app the slot element, and
 * `onRectChange(rect)` streams its viewport rect so the app can size/place the
 * native view (both null on unmount → the app hides that tab's view). The slot
 * region always renders so the rect is available even before a URL is set; the
 * empty state overlays it (pointer-events: none) until the model/user navigates.
 */
export function BrowserSurface({
  url,
  loading = false,
  canGoBack = false,
  canGoForward = false,
  driving = false,
  onNavigate,
  onBack,
  onForward,
  onReload,
  onMenu,
  onMount,
  onRectChange,
  className,
}: BrowserSurfaceProps) {
  const slotRef = useContentSlot({ onMount, onRectChange });
  const [draft, setDraft] = useState(url ?? '');
  // Reflect app-driven navigation (browser-use) back into the URL bar.
  useEffect(() => {
    setDraft(url ?? '');
  }, [url]);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const value = draft.trim();
    if (value) onNavigate?.(value);
  };

  const rootClass = ['pd-browser', className].filter(Boolean).join(' ');
  return (
    <div className={rootClass}>
      <div className="pd-browser-toolbar">
        <div className="pd-browser-nav">
          <IconButton size="sm" aria-label="Back" disabled={!canGoBack} onClick={() => onBack?.()}>
            <IconArrowLeft size={16} />
          </IconButton>
          <IconButton
            size="sm"
            aria-label="Forward"
            disabled={!canGoForward}
            onClick={() => onForward?.()}
          >
            <IconArrowRight size={16} />
          </IconButton>
          <IconButton size="sm" aria-label="Refresh" onClick={() => onReload?.()}>
            <IconRefresh size={16} />
          </IconButton>
        </div>
        <form className="pd-browser-urlform" onSubmit={submit}>
          <input
            className="pd-browser-url"
            type="text"
            inputMode="url"
            placeholder="Enter a URL"
            aria-label="Address bar"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          {driving ? (
            <span className="pd-browser-driving" title="The model is driving this browser">
              <span className="pd-browser-driving-dot" />
              Pi is browsing
            </span>
          ) : null}
          {loading ? <span className="pd-browser-loading" aria-hidden="true" /> : null}
        </form>
        <IconButton size="sm" aria-label="Browser menu" onClick={() => onMenu?.()}>
          <IconMore size={16} />
        </IconButton>
      </div>
      <div className="pd-browser-content">
        <div ref={slotRef} className="pd-browser-slot" data-native-slot="browser" />
        {url ? null : (
          <div className="pd-browser-empty" aria-hidden="true">
            <IconGlobe size={48} />
            <p className="pd-browser-empty-title">Start browsing</p>
            <p className="pd-browser-empty-sub">Enter a URL to open a page</p>
          </div>
        )}
      </div>
    </div>
  );
}
