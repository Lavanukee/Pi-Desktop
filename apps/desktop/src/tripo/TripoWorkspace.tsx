/**
 * Tripo-style 3D workspace — the full-app view mounted when the window URL
 * carries `?tripo=1` (dev override: PI_DESKTOP_TRIPO=1). UI ONLY: every
 * control is real and stateful, but nothing reaches pi, the engine, or the
 * main process — generation buttons are deliberate no-ops until the wiring
 * phase.
 *
 * Layout (mirroring the reference screenshots):
 *   top bar / left tool rail / generation panel / 3D viewport / right panel.
 */

import type { JSX } from 'react';
import { useEffect } from 'react';
import { GenPanel } from './GenPanel';
import { Rail } from './Rail';
import { RightPanel } from './RightPanel';
import { useTripoStore } from './store';
import { TopBar } from './TopBar';
import { Viewport } from './Viewport';
import './tripo.css';

export function TripoWorkspace(): JSX.Element {
  const closeMenus = useTripoStore((s) => s.closeMenus);

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
    <div className="tp" data-testid="tp-root">
      <TopBar />
      <div className="tp-body">
        <Rail />
        <GenPanel />
        <Viewport />
        <RightPanel />
      </div>
    </div>
  );
}
