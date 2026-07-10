import { useCallback, useRef } from 'react';

export interface ContentSlotOptions {
  /**
   * Called with the slot element when it mounts and `null` when it unmounts —
   * the app uses this to attach/detach a native view (WebContentsView, xterm).
   */
  onMount?: (element: HTMLElement | null) => void;
  /**
   * Called with the slot's VIEWPORT-RELATIVE bounding rect on mount and on every
   * layout change (resize, scroll), and with `null` on unmount. The app converts
   * these client coordinates to window coordinates to position a native overlay.
   */
  onRectChange?: (rect: DOMRect | null) => void;
}

/**
 * `useContentSlot` — the CONTENT-SLOT / RECT contract that BrowserSurface and
 * TerminalSurface hand to the app. Returns a callback ref to spread onto the
 * slot element (`<div ref={slotRef} />`). On mount it fires `onMount(el)` and
 * `onRectChange(rect)`, then keeps the rect fresh via a ResizeObserver plus
 * capture-phase scroll/resize listeners. React 19 runs the returned cleanup on
 * unmount, which fires `onRectChange(null)` then `onMount(null)` so the app hides
 * (not necessarily destroys) its native view. Handlers are read through refs so
 * changing their identity never re-attaches the observer.
 */
export function useContentSlot({
  onMount,
  onRectChange,
}: ContentSlotOptions): (element: HTMLElement | null) => (() => void) | undefined {
  const onMountRef = useRef(onMount);
  const onRectRef = useRef(onRectChange);
  onMountRef.current = onMount;
  onRectRef.current = onRectChange;

  return useCallback((element: HTMLElement | null) => {
    if (!element) return;
    onMountRef.current?.(element);
    const emit = (): void => {
      onRectRef.current?.(element.getBoundingClientRect());
    };
    emit();
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(emit);
      observer.observe(element);
    }
    // Capture-phase catches scrolls in any ancestor container, not just window.
    window.addEventListener('scroll', emit, true);
    window.addEventListener('resize', emit);
    return () => {
      observer?.disconnect();
      window.removeEventListener('scroll', emit, true);
      window.removeEventListener('resize', emit);
      onRectRef.current?.(null);
      onMountRef.current?.(null);
    };
  }, []);
}
