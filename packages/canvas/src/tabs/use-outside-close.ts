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
): void {
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent): void => {
      if (!ref.current?.contains(event.target as Node)) close();
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open, close, ref]);
}
