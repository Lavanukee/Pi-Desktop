/**
 * A generated image shown INLINE in the thread (round-5 #7). It renders a
 * bounded thumbnail; clicking opens a FULLSCREEN lightbox (click anywhere or
 * press Escape to dismiss). This deliberately diverges from the reference apps,
 * which route generated images to the canvas — jedd wants them inline with a
 * click-to-fullscreen preview. Reduced-motion drops the open animation (CSS).
 */
import { useEffect, useState } from 'react';

export function ThreadImage({ src, alt = 'Generated image' }: { src: string; alt?: string }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        className="pd-thread-image pd-focusable"
        data-testid="thread-image"
        aria-label="Open image full screen"
        onClick={() => setOpen(true)}
      >
        <img src={src} alt={alt} className="pd-thread-image-thumb" />
      </button>

      {open ? (
        // The whole backdrop is the dismiss target (a button, so Enter/Space +
        // click both close and the a11y rules are satisfied without a shim).
        <button
          type="button"
          className="pd-image-lightbox"
          data-testid="image-lightbox"
          aria-label="Close image preview"
          onClick={() => setOpen(false)}
        >
          <img src={src} alt={alt} className="pd-image-lightbox-img" />
        </button>
      ) : null}
    </>
  );
}
