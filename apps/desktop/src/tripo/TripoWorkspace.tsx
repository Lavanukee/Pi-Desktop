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
import { IcUpload } from './icons';
import { Rail } from './Rail';
import { RightPanel } from './RightPanel';
import { useTripoStore } from './store';
import { TopBar } from './TopBar';
import { Viewport } from './Viewport';
import { importModelFile, isModelFile } from './viewer-io';
import './tripo.css';

export function TripoWorkspace(): JSX.Element {
  const closeMenus = useTripoStore((s) => s.closeMenus);
  const [dropActive, setDropActive] = useState(false);

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

  return (
    // The workspace root is a drag-and-drop DROP TARGET only (no click
    // semantics) — file drops must land anywhere in the studio, and drop
    // targets are not focusable interactive elements.
    // biome-ignore lint/a11y/noStaticElementInteractions: drop target, not a clickable control
    <div
      className="tp"
      data-testid="tp-root"
      data-drop-active={dropActive}
      onDragOver={(e) => {
        // Only light up for file drags (not text/element drags).
        if (Array.from(e.dataTransfer.types).includes('Files')) {
          e.preventDefault();
          setDropActive(true);
        }
      }}
      onDragLeave={(e) => {
        // Ignore leave events fired by inner elements; only a true exit clears.
        if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) {
          setDropActive(false);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDropActive(false);
        const file = Array.from(e.dataTransfer.files).find(isModelFile);
        if (file !== undefined) void importModelFile(file);
      }}
    >
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
            Drop to import — .glb · .gltf · .obj · .stl
          </div>
        </div>
      ) : null}
    </div>
  );
}
