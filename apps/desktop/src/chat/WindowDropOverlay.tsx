/**
 * Fullscreen drop-anywhere overlay (round-3 #A8b). Files dropped ANYWHERE in the
 * window — not just over the composer — are attached. We listen on window-level
 * drag events (with a depth counter so nested dragenter/leave don't flicker),
 * show a covering drop hint while a file drag is in flight, and hand the dropped
 * files to the composer via `useDropStore`.
 */
import { FileDropZone } from '@pi-desktop/ui';
import { useEffect, useRef, useState } from 'react';
import { useDropStore } from './composer/drop-store';

/** True when the drag carries files (vs. text/element drags we should ignore). */
function dragHasFiles(e: DragEvent): boolean {
  const types = e.dataTransfer?.types;
  if (types === undefined) return false;
  return Array.from(types).includes('Files');
}

export function WindowDropOverlay() {
  const [active, setActive] = useState(false);
  const depth = useRef(0);

  useEffect(() => {
    const onEnter = (e: DragEvent) => {
      if (!dragHasFiles(e)) return;
      e.preventDefault();
      depth.current += 1;
      setActive(true);
    };
    const onOver = (e: DragEvent) => {
      if (dragHasFiles(e)) e.preventDefault();
    };
    const onLeave = (e: DragEvent) => {
      if (!dragHasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setActive(false);
    };
    const onDrop = (e: DragEvent) => {
      depth.current = 0;
      setActive(false);
      if (!dragHasFiles(e)) return;
      e.preventDefault();
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length > 0) useDropStore.getState().push(files);
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  if (!active) return null;

  return (
    <div className="pd-window-drop" data-testid="window-drop-overlay" aria-hidden>
      <div className="pd-window-drop-card">
        <FileDropZone
          active
          label="Drop files anywhere to attach"
          hint="Images and text files attach to your next message"
        />
      </div>
    </div>
  );
}
