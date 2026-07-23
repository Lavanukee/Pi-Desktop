/**
 * Bobble 3D top bar — deliberately minimal (no promos, credits, accounts, or
 * nav ballast): back-to-chat, the Bobble 3D mark, a workspace label, and the
 * two things a local studio actually needs up top — Send To (real DCC app
 * logos, exports a GLB named for the target) and Export (opens the dialog).
 */
import type { JSX } from 'react';
import { exitModality } from '../state/modality-store';
import { IcCaretSmall, IcDownload, IcShare } from './icons';
import { DCC_LOGOS, DccLogoIcon } from './logos';
import { MenuAnchor } from './primitives';
import { useTripoStore } from './store';
import { LogoMark } from './thumbs';
import { requestSendTo } from './viewer-io';

export function TopBar(): JSX.Element {
  const toggleMenu = useTripoStore((s) => s.toggleMenu);
  const closeMenus = useTripoStore((s) => s.closeMenus);
  const set = useTripoStore((s) => s.set);
  const loadedAssetId = useTripoStore((s) => s.loadedAssetId);
  const hasModel = loadedAssetId !== null;

  return (
    <header className="tp-topbar" data-testid="tp-topbar">
      <div className="tp-topbar-left">
        <button
          type="button"
          className="tp-back-btn"
          data-testid="tp-back"
          aria-label="Back to chat"
          title="Back to chat"
          onClick={() => exitModality()}
        >
          <IcCaretSmall size={16} className="tp-back-caret" />
          Chat
        </button>
        <button
          type="button"
          className="tp-logo"
          data-testid="tp-home"
          onClick={() => exitModality()}
          title="Bobble 3D"
        >
          <LogoMark size={22} />
          <span className="tp-logo-word">Bobble 3D</span>
        </button>
        <span className="tp-workspace-label" data-testid="tp-workspace-label">
          3D Workspace
        </span>
      </div>

      <div className="tp-topbar-right">
        <MenuAnchor
          id="sendto"
          placement="bottom-end"
          trigger={
            <button
              type="button"
              className="tp-pill-btn"
              data-testid="tp-sendto-btn"
              disabled={!hasModel}
              onClick={() => toggleMenu('sendto')}
            >
              <IcShare size={14} />
              Send To
              <IcCaretSmall size={12} />
            </button>
          }
          menu={
            <div className="tp-sendto-menu" data-testid="tp-sendto-menu">
              {DCC_LOGOS.map((logo) => (
                <button
                  key={logo.id}
                  type="button"
                  className="tp-menu-item"
                  data-testid={`tp-sendto-${logo.id}`}
                  title={`Exports a GLB for ${logo.label}`}
                  onClick={() => {
                    requestSendTo(logo.id);
                    closeMenus();
                  }}
                >
                  <DccLogoIcon logo={logo} size={16} />
                  <span className="tp-menu-item-label">{logo.label}</span>
                </button>
              ))}
            </div>
          }
        />
        <button
          type="button"
          className="tp-export-cta"
          data-testid="tp-export-btn"
          disabled={!hasModel}
          onClick={() => set('modal', 'export')}
        >
          <IcDownload size={15} />
          Export
        </button>
      </div>
    </header>
  );
}
