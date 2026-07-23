/**
 * Tripo workspace top bar: logo + workspace switcher, primary nav, and the
 * right-hand cluster (DCC Bridge, credits, Upgrade, notifications, language,
 * account) — each with its working dropdown/popover. All actions are local.
 */
import type { JSX } from 'react';
import { useState } from 'react';
import { DCC_BRIDGES, LANGUAGES, NOTIFICATIONS, WORKSPACE_MENU } from './data';
import { IcBell, IcBolt, IcBridge, IcCaretSmall, IcGlobe, IcRocket, IcUser } from './icons';
import { MenuAnchor, MenuItem } from './primitives';
import { useTripoStore } from './store';
import { LogoMark } from './thumbs';

const NAV = ['Home', 'Assets', 'Affiliate Program', 'Creator Program'] as const;

export function TopBar(): JSX.Element {
  const toggleMenu = useTripoStore((s) => s.toggleMenu);
  const closeMenus = useTripoStore((s) => s.closeMenus);
  const [nav, setNav] = useState<string>('Home');
  const [lang, setLang] = useState<string>('English');
  const [read, setRead] = useState(false);

  return (
    <header className="tp-topbar" data-testid="tp-topbar">
      <div className="tp-topbar-left">
        <div className="tp-logo">
          <LogoMark size={24} />
          <span className="tp-logo-word">TRIPO</span>
        </div>
        <MenuAnchor
          id="workspace"
          trigger={
            <button
              type="button"
              className="tp-workspace-btn"
              data-testid="tp-workspace-btn"
              onClick={() => toggleMenu('workspace')}
            >
              3D Workspace
              <IcCaretSmall size={14} />
            </button>
          }
          menu={WORKSPACE_MENU.map((w) => (
            <MenuItem key={w.id} label={w.label} checked={w.active} onClick={closeMenus} />
          ))}
        />
        <span className="tp-topbar-divider" />
        <nav className="tp-nav">
          {NAV.map((n) => (
            <button
              key={n}
              type="button"
              className="tp-nav-item"
              data-active={nav === n}
              onClick={() => setNav(n)}
            >
              {n}
            </button>
          ))}
        </nav>
      </div>

      <div className="tp-topbar-right">
        <MenuAnchor
          id="dcc"
          placement="bottom-end"
          trigger={
            <button
              type="button"
              className="tp-pill-btn"
              data-testid="tp-dcc-btn"
              onClick={() => toggleMenu('dcc')}
            >
              <IcBridge size={15} />
              DCC Bridge
              <span className="tp-badge-mt">MT</span>
            </button>
          }
          menu={
            <div className="tp-dcc-menu">
              <div className="tp-dcc-status">
                <span className="tp-dot tp-dot-idle" />
                Bridge not connected
              </div>
              <div className="tp-menu-heading">Install plugin</div>
              {DCC_BRIDGES.map((b) => (
                <MenuItem
                  key={b}
                  label={`Tripo for ${b}`}
                  hint="v1.4.2 · free"
                  onClick={closeMenus}
                />
              ))}
              <div className="tp-menu-sep" />
              <MenuItem label="Bridge documentation" onClick={closeMenus} />
            </div>
          }
        />
        <MenuAnchor
          id="credits"
          placement="bottom-end"
          trigger={
            <button
              type="button"
              className="tp-pill-btn tp-credits"
              data-testid="tp-credits-btn"
              onClick={() => toggleMenu('credits')}
            >
              <span className="tp-bolt">
                <IcBolt size={14} />
              </span>
              200
            </button>
          }
          menu={
            <div className="tp-credits-menu">
              <div className="tp-credits-big">
                <span className="tp-bolt">
                  <IcBolt size={16} />
                </span>
                200 credits
              </div>
              <div className="tp-credits-sub">Free daily credits · reset in 07:41:12</div>
              <div className="tp-menu-sep" />
              <MenuItem label="Earn +300 by sharing a model" onClick={closeMenus} />
              <MenuItem label="View usage" onClick={closeMenus} />
            </div>
          }
        />
        <button type="button" className="tp-upgrade-pill" data-testid="tp-upgrade-btn">
          <IcRocket size={14} />
          Upgrade
        </button>
        <MenuAnchor
          id="bell"
          placement="bottom-end"
          trigger={
            <button
              type="button"
              className="tp-iconbtn"
              data-testid="tp-bell-btn"
              aria-label="Notifications"
              onClick={() => toggleMenu('bell')}
            >
              <IcBell size={17} />
              {read ? null : <span className="tp-bell-count">3</span>}
            </button>
          }
          menu={
            <div className="tp-bell-menu">
              <div className="tp-bell-head">
                Notifications
                <button type="button" className="tp-linklike" onClick={() => setRead(true)}>
                  Mark all as read
                </button>
              </div>
              {NOTIFICATIONS.map((n) => (
                <div key={n.id} className="tp-notif" data-unread={n.unread && !read}>
                  <span className="tp-notif-dot" />
                  <div className="tp-notif-body">
                    <div className="tp-notif-title">{n.title}</div>
                    <div className="tp-notif-time">{n.time}</div>
                  </div>
                </div>
              ))}
            </div>
          }
        />
        <MenuAnchor
          id="lang"
          placement="bottom-end"
          trigger={
            <button
              type="button"
              className="tp-iconbtn"
              data-testid="tp-lang-btn"
              aria-label="Language"
              onClick={() => toggleMenu('lang')}
            >
              <IcGlobe size={17} />
            </button>
          }
          menu={LANGUAGES.map((l) => (
            <MenuItem
              key={l}
              label={l}
              checked={l === lang}
              onClick={() => {
                setLang(l);
                closeMenus();
              }}
            />
          ))}
        />
        <MenuAnchor
          id="account"
          placement="bottom-end"
          trigger={
            <button
              type="button"
              className="tp-avatar"
              data-testid="tp-avatar-btn"
              aria-label="Account"
              onClick={() => toggleMenu('account')}
            >
              <IcUser size={16} />
            </button>
          }
          menu={
            <div className="tp-account-menu">
              <div className="tp-account-head">
                <span className="tp-avatar tp-avatar-lg">
                  <IcUser size={18} />
                </span>
                <div>
                  <div className="tp-account-name">Pi Studio</div>
                  <div className="tp-account-plan">Free plan</div>
                </div>
              </div>
              <div className="tp-menu-sep" />
              <MenuItem label="Profile" onClick={closeMenus} />
              <MenuItem label="My subscription" onClick={closeMenus} />
              <MenuItem label="API keys" onClick={closeMenus} />
              <MenuItem label="Settings" onClick={closeMenus} />
              <div className="tp-menu-sep" />
              <MenuItem label="Sign out" danger onClick={closeMenus} />
            </div>
          }
        />
      </div>
    </header>
  );
}
