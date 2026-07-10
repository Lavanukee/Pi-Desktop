import { IconGlobe } from '@pi-desktop/ui';
import { type ContentSlotOptions, useContentSlot } from './content-slot.ts';

export interface BrowserSurfaceProps extends ContentSlotOptions {
  /** Current URL; empty/undefined shows the "start browsing" empty state. */
  url?: string;
  /** Show the "model is driving" indicator (browser-use is live). */
  driving?: boolean;
  className?: string;
}

/**
 * BrowserSurface — the CONTENT for a live web tab. The URL bar + nav chrome now
 * live in the per-tab {@link CanvasOperationBar}; this surface renders only the
 * native content slot, the "Pi is browsing" driving indicator, and the empty
 * state. The page is a native WebContentsView the APP mounts and positions over
 * the slot: `onMount(el)` hands the app the slot element, and `onRectChange(rect)`
 * streams its viewport rect (both null on unmount → the app hides that view). The
 * slot always renders so the rect is available before a URL is set; the empty
 * state overlays it (pointer-events: none) until the model/user navigates.
 */
export function BrowserSurface({
  url,
  driving = false,
  onMount,
  onRectChange,
  className,
}: BrowserSurfaceProps) {
  const slotRef = useContentSlot({ onMount, onRectChange });
  const rootClass = ['pd-browser', className].filter(Boolean).join(' ');
  return (
    <div className={rootClass}>
      <div className="pd-browser-content">
        <div ref={slotRef} className="pd-browser-slot" data-native-slot="browser" />
        {driving ? (
          <span className="pd-browser-driving" title="The model is driving this browser">
            <span className="pd-browser-driving-dot" />
            Pi is browsing
          </span>
        ) : null}
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
