/**
 * Bobble 3D workspace — the full-app view mounted from the sidebar Modalities
 * entry (or `?tripo=1` / PI_DESKTOP_TRIPO=1 in dev).
 *
 * Layout: top bar / left tool rail / stage panel / 3D viewport / right panel.
 * Dropping a 3D model file (.glb/.gltf/.obj/.stl) ANYWHERE in the workspace
 * imports it: it lands in the viewport immediately and its rendered preview
 * appears in the Assets grid (captured by the viewer on its first frame).
 */

import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { GenPanel } from './GenPanel';
import { ensureGen3dWired } from './gen3d-client';
import { IcUpload } from './icons';
import { Rail } from './Rail';
import { RightPanel } from './RightPanel';
import { useTripoStore } from './store';
import { TopBar } from './TopBar';
import { Viewport } from './Viewport';
import { addInputImages, importModelFile, isImageFile, isModelFile } from './viewer-io';
import './tripo.css';

export function TripoWorkspace(): JSX.Element {
  const closeMenus = useTripoStore((s) => s.closeMenus);
  const [dropActive, setDropActive] = useState(false);

  // Engine catalog + event wiring (idempotent).
  useEffect(() => {
    ensureGen3dWired();
  }, []);

  // One global dismiss layer for every popover/dropdown: any pointerdown
  // outside a menu anchor closes the open menu; Escape closes menus first,
  // then the open modal.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target;
      if (target instanceof Element && target.closest('[data-tp-menu-root]') !== null) return;
      closeMenus();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const s = useTripoStore.getState();
      if (s.openMenu !== null) {
        s.closeMenus();
      } else if (s.modal !== null) {
        s.set('modal', null);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [closeMenus]);

  // OS file drops, hardened at the DOCUMENT level (capture phase): without the
  // dragover preventDefault Chromium/Electron NAVIGATES the window to the
  // dropped file (the "drag and drop doesn't work" failure — the React handler
  // on the root div can be bypassed when a child swallows the event). The
  // capture listeners always see the drag, always cancel navigation, and route
  // any model file through the same import path.
  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer !== null && Array.from(e.dataTransfer.types).includes('Files')) {
        e.preventDefault();
        setDropActive(true);
      }
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      setDropActive(false);
      const files = e.dataTransfer === null ? [] : Array.from(e.dataTransfer.files);
      // A dropped model goes to the viewport; dropped images become image→3D
      // inputs (shown in the input card). Model wins if both are present.
      const model = files.find(isModelFile);
      if (model !== undefined) {
        void importModelFile(model);
        return;
      }
      const images = files.filter(isImageFile);
      if (images.length > 0) addInputImages(images);
    };
    const onDragLeave = (e: DragEvent) => {
      // Leaving the window entirely (relatedTarget null) clears the overlay.
      if (e.relatedTarget === null) setDropActive(false);
    };
    document.addEventListener('dragover', onDragOver, true);
    document.addEventListener('drop', onDrop, true);
    document.addEventListener('dragleave', onDragLeave, true);
    return () => {
      document.removeEventListener('dragover', onDragOver, true);
      document.removeEventListener('drop', onDrop, true);
      document.removeEventListener('dragleave', onDragLeave, true);
    };
  }, []);

  return (
    // Drops are handled by the document-level capture listeners above; the
    // root only carries the drop-overlay state attribute.
    <div className="tp" data-testid="tp-root" data-drop-active={dropActive}>
      <TopBar />
      <div className="tp-body">
        <Rail />
        <GenPanel />
        <Viewport />
        <RightPanel />
      </div>
      {dropActive ? (
        <div className="tp-drop-overlay" data-testid="tp-drop-overlay">
          <div className="tp-drop-card">
            <IcUpload size={26} />
            Drop a model (.glb · .obj · .stl) or an image (.png · .jpg)
          </div>
        </div>
      ) : null}
    </div>
  );
}
