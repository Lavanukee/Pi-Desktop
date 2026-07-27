/**
 * The card an image occupies while it is still being made — showing the REAL
 * denoise, not a stand-in for it.
 *
 * Three things happen here, in the order the user sees them:
 *
 *  1. MOUNT. The card opens out of its own top-left corner into the aspect
 *     ratio of the image being generated, ONCE, as it appears. Nothing pops in
 *     at full size.
 *  2. WAITING. Mage-Flow spends a MEASURED ~11 s loading before it can decode
 *     anything, so the empty card is not empty: a slow warp/weft drift with a
 *     travelling settle band, quiet enough to sit behind text and alive enough
 *     that the wait never reads as a hang.
 *  3. RESOLVING. Each real decoded step unravels in from the left over the one
 *     before it, while `--pd-dn-resolve` — driven on rAF from the cadence
 *     measured so far (denoise-preview.ts) — pulls blur, grain and colour
 *     continuously toward the finished picture BETWEEN those steps. Frames land
 *     ~1.3 s apart; without the tween the card would be motionless for most of
 *     every gap.
 *
 * ## Why the DOM is driven by hand
 * jedd saw two defects in the first cut, and they had one cause: React owned
 * the frames. Every arriving frame was a `setState`, so
 *   - the whole assistant group re-rendered (markdown included) five times per
 *     image, which flashed across the window; and
 *   - the frame elements were keyed by step, so each new frame UNMOUNTED the
 *     old one and mounted a fresh `<img>` — a moment with no image in the box
 *     at all, and a fresh element that paints before it is laid out.
 * Worse, a remount re-ran the mount animation, so the card kept collapsing back
 * into its top-left corner and re-opening on later steps — the entrance
 * animation firing at the end.
 *
 * So: the elements below are created exactly once and never replaced. A new
 * frame is DECODED first (`img.decode()`), then swapped into the existing
 * element, then revealed with an explicitly restarted Web Animations pass.
 * Nothing is ever painted outside the box that is already laid out, and no
 * frame reaches React at all. The component renders once and then holds still.
 *
 * The frames are UI-only: small inline data URIs, dropped when the card
 * unmounts. None of this reaches the tool result, the model's context, or the
 * session transcript — only the finished image does.
 *
 * NOT a copy of anyone else's loading card: no dot field, no pulsing blob, and
 * no purple (standing brief). Every colour is a `--pd-*` token, so all theme
 * flavors and both modes come out of the same rules.
 */

import { useEffect, useRef } from 'react';
import {
  type DenoiseState,
  EMPTY_DENOISE,
  noteDone,
  noteFrame,
  resolveAt,
  visibleFrames,
} from './denoise-preview';
import { subscribeToDenoise } from './useDenoisePreview';

/** Blur applied to a wholly unresolved frame, in px at the card's own scale. */
const MAX_BLUR_PX = 6;
/** The reveal, and the seam that travels with it. */
const UNRAVEL_MS = 620;
const EASE_ENTER = 'cubic-bezier(0.165, 0.84, 0.44, 1)';

export function ThreadImagePlaceholder({
  label = 'Generating an image',
}: {
  /** Announced to screen readers; also the caption under the card. */
  label?: string;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const currentRef = useRef<HTMLImageElement | null>(null);
  const previousRef = useRef<HTMLImageElement | null>(null);
  const edgeRef = useRef<HTMLDivElement | null>(null);
  const captionRef = useRef<HTMLDivElement | null>(null);
  const labelRef = useRef(label);
  labelRef.current = label;

  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    let live = true;
    let state: DenoiseState = EMPTY_DENOISE;
    // Frames are applied one at a time: a decode is async, and two overlapping
    // swaps could leave `previous` holding the newer of the two.
    let chain: Promise<void> = Promise.resolve();
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

    const setCaption = (): void => {
      const { current } = visibleFrames(state);
      const cap = captionRef.current;
      if (cap === null) return;
      cap.textContent =
        current === undefined
          ? labelRef.current
          : `${labelRef.current} — step ${Math.min(current.step + 1, current.totalSteps)} of ${current.totalSteps}`;
      root.setAttribute('aria-label', cap.textContent);
      root.setAttribute('data-phase', current === undefined ? 'waiting' : 'resolving');
      root.setAttribute('data-frames', String(state.frames.length));
    };

    /** Swap in one already-arrived frame, painting it only once it can be. */
    const applyFrame = async (dataUri: string): Promise<void> => {
      const cur = currentRef.current;
      const prev = previousRef.current;
      if (cur === null || prev === null) return;
      // DECODE FIRST. Assigning src and letting the element paint when it feels
      // like it is what made a frame appear before it was in place; by the time
      // the src below is assigned the bitmap is already in memory, so the swap
      // lands inside the laid-out box on the very next paint.
      const staged = new Image();
      staged.src = dataUri;
      try {
        await staged.decode();
      } catch {
        return; // a frame that will not decode is simply skipped
      }
      if (!live) return;
      // The outgoing frame slides underneath, so the unravel never reveals a
      // hole where an image used to be.
      if (cur.getAttribute('src') !== null) prev.src = cur.src;
      cur.src = dataUri;
      if (reduced) return; // frames are content and keep arriving; motion does not
      for (const a of cur.getAnimations()) a.cancel();
      cur.animate([{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0 0 0)' }], {
        duration: UNRAVEL_MS,
        easing: EASE_ENTER,
        fill: 'both',
      });
      const edge = edgeRef.current;
      if (edge !== null) {
        for (const a of edge.getAnimations()) a.cancel();
        edge.animate(
          [
            { left: '-26px', opacity: 0.15 },
            { opacity: 0.9, offset: 0.6 },
            { left: '100%', opacity: 0 },
          ],
          { duration: UNRAVEL_MS, easing: EASE_ENTER, fill: 'both' },
        );
      }
    };

    const unsubscribe = subscribeToDenoise({
      onFrame: (jobId, preview) => {
        if (!live) return;
        state = noteFrame(state, jobId, preview, performance.now());
        // The box takes the aspect ratio of the image actually being made. Set
        // once, from the first frame — changing it later would resize a card
        // the user is already looking at.
        if (state.frames.length === 1) {
          root.style.setProperty('--pd-dn-aspect', String(state.aspect));
        }
        setCaption();
        const uri = preview.dataUri;
        chain = chain.then(() => applyFrame(uri));
      },
      onDone: (jobId) => {
        if (!live) return;
        state = noteDone(state, jobId, performance.now());
      },
    });

    // The tween. Written straight onto the element as custom properties rather
    // than through React state: this runs at display rate, and re-rendering the
    // tree 120 times a second to move a blur radius would cost far more than
    // the animation it is driving.
    let raf = requestAnimationFrame(function tick(): void {
      const resolve = resolveAt(state, performance.now());
      root.style.setProperty('--pd-dn-resolve', resolve.toFixed(4));
      // Curved, not linear: most of the perceived "coming into focus" should
      // happen late, matching where a 4-step turbo model does its real work.
      root.style.setProperty(
        '--pd-dn-blur',
        `${(MAX_BLUR_PX * (1 - resolve) ** 1.6).toFixed(2)}px`,
      );
      raf = requestAnimationFrame(tick);
    });

    return () => {
      live = false;
      cancelAnimationFrame(raf);
      unsubscribe?.();
    };
  }, []);

  return (
    <div
      ref={rootRef}
      className="pd-denoise"
      data-testid="thread-image-placeholder"
      data-phase="waiting"
      data-frames="0"
      role="img"
      aria-label={label}
      aria-busy="true"
    >
      <div className="pd-denoise-plate">
        {/* The waiting texture. Left mounted underneath so the first frame
            unravels ONTO something rather than onto a hole. */}
        <div className="pd-denoise-weave" aria-hidden="true" />
        {/* Both frame layers exist from the first paint with no src. They are
            never replaced — only their src changes — so the box they occupy is
            laid out once and a new frame can never appear anywhere else.
            The wrapper carries the per-rAF filter so that the elements which
            ANIMATE (clip-path, below) are not the same elements being
            re-filtered 120 times a second — see .pd-denoise-frames. */}
        <div className="pd-denoise-frames" aria-hidden="true">
          <img
            ref={previousRef}
            className="pd-denoise-frame"
            data-role="previous"
            alt=""
            aria-hidden="true"
          />
          <img
            ref={currentRef}
            className="pd-denoise-frame"
            data-role="current"
            data-testid="denoise-frame"
            alt=""
            aria-hidden="true"
          />
        </div>
        {/* The unravel's leading edge, travelling with the reveal. */}
        <div ref={edgeRef} className="pd-denoise-edge" aria-hidden="true" />
        {/* Grain over everything, thinning as the tween resolves — this is what
            keeps moving between steps. */}
        <div className="pd-denoise-grain" aria-hidden="true" />
      </div>
      <div ref={captionRef} className="pd-denoise-caption">
        {label}
      </div>
    </div>
  );
}
