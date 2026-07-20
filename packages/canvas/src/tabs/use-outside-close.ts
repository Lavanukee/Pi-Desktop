import { type RefObject, useEffect } from 'react';

/**
 * Close a popover on any outside pointer-down while it's open. Shared by the
 * canvas menus (new-tab `+`, file "Open with" split button, project picker,
 * file-tree / media-download popovers) so they all dismiss identically.
 */
export function useOutsideClose(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  close: () => void,
  // Optional second element to treat as "inside" — e.g. a menu PORTALED out of
  // `ref`'s subtree (so a click on it isn't seen as an outside dismiss).
  ref2?: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent): void => {
      const target = event.target as Node;
      const inside = ref.current?.contains(target) === true || ref2?.current?.contains(target) === true;
      if (!inside) close();
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open, close, ref, ref2]);
}
