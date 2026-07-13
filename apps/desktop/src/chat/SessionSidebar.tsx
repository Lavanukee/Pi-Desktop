/**
 * Session sidebar. Two shapes driven by `open`:
 *   - EXPANDED: the collapse toggle sits to the LEFT of a click-to-expand
 *     `CollapsibleSearch` (round-8 #1/#2), then New chat, the Workspace nav
 *     (Projects, Model management, Connectors, Scheduled, Skills — Artifacts +
 *     the redundant Settings entry removed, #4/#5), then the Chats history and
 *     the bottom-left profile button (round-12 #4: one button → a dropup with
 *     Settings / Toggle theme / the User–Power toggle).
 *   - COLLAPSED: a NARROW ICON RAIL (~64px) — the SVG icons stay visible; the
 *     search becomes just the magnifying glass; the same profile button (avatar
 *     only) pins to the bottom. Never fully hidden. Width + label-hiding live in
 *     global.css.
 * Sessions are read from the fs channels; mutations go through pi.
 */

import {
  CollapsibleSearch,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconChat,
  IconChevronDown,
  IconClock,
  IconConnector,
  IconFolderPlus,
  IconPencil,
  IconSearch,
  IconSettings,
  IconSidebar,
  IconSparkles,
  Kbd,
  SegmentedControl,
  Sidebar,
  SidebarRow,
  SidebarScroll,
  SidebarSection,
} from '@pi-desktop/ui';
import {
  type ComponentType,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { SessionSummary } from '../../electron/ipc-contract';
import type { UserMode } from '../../electron/settings/settings-contract';
import { IconCpu, IconMoon, IconSun } from '../settings/icons';
import type { SettingsSection } from '../settings/SettingsView';
import { listSessions, newSession, switchSession } from '../state/pi-connect';
import { usePiStore } from '../state/pi-slice';
import { setUserMode, useSettingsStore, useUserMode } from '../state/settings-store';
import { useThemeStore } from '../store/theme';
import { PROFILE_MENU_ACTIONS, USER_MODE_OPTIONS, userModeBlurb } from './profile-menu';

/** Nav destinations that don't have a real page yet — open a "coming soon" stub. */
export type SidebarStub = 'projects' | 'scheduled' | 'skills';

/**
 * Bottom-left profile control (round-12 #4). ONE compact button — the avatar
 * (rail) or the full "Pi Desktop · Local" row (expanded) — that opens a DROPUP
 * (side="top") holding, top→bottom: Settings, Toggle theme, a divider, and — at
 * the bottom — the User / Power-user segmented toggle. Replaces the old separate
 * settings-gear + theme-toggle controls. Rendered in both sidebar shapes so both
 * share one menu; the `open-settings` / `toggle-mode` testids move onto the menu
 * rows (probes open the menu first, then click them).
 */
function SidebarProfileMenu({
  variant,
  onOpenSettings,
}: {
  variant: 'full' | 'rail';
  onOpenSettings: (section: SettingsSection) => void;
}) {
  const mode = useThemeStore((s) => s.mode);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const userMode = useUserMode();

  const trigger =
    variant === 'rail' ? (
      <button
        type="button"
        className="pd-rail-btn pd-focusable"
        aria-label="Account, settings and theme"
        title="Account, settings and theme"
        data-testid="profile-button"
      >
        {/* Same --pd-icon-size centering box as the rail icons so the avatar
            sits on the identical x through the collapse (round-14 #7). */}
        <span className="pd-rail-btn-icon">
          <span className="pd-sidebar-avatar">P</span>
        </span>
      </button>
    ) : (
      <button
        type="button"
        data-testid="profile-button"
        aria-label="Account, settings and theme"
        className="pd-sidebar-footer pd-focusable min-w-0 flex-1 cursor-pointer rounded-lg border-0 bg-transparent text-left font-[inherit] text-text-primary hover:bg-bg-hover"
      >
        <span className="pd-sidebar-avatar">P</span>
        <span className="pd-sidebar-footer-name">
          Pi Desktop<span className="pd-sidebar-footer-plan"> · Local</span>
        </span>
        <IconChevronDown size={16} className="shrink-0 text-text-muted" />
      </button>
    );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={6}
        className="min-w-[240px]"
        data-testid="profile-menu"
      >
        {PROFILE_MENU_ACTIONS.map((action) =>
          action.id === 'settings' ? (
            <DropdownMenuItem
              key={action.id}
              data-testid={action.testid}
              icon={<IconSettings size={16} />}
              onSelect={() => onOpenSettings('personalization')}
            >
              {action.label}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              key={action.id}
              data-testid={action.testid}
              icon={mode === 'dark' ? <IconMoon size={16} /> : <IconSun size={16} />}
              hint={mode === 'dark' ? 'Dark' : 'Light'}
              // Keep the menu open on flip so the change is visible in place.
              onSelect={(e) => {
                e.preventDefault();
                void setTheme({ mode: mode === 'dark' ? 'light' : 'dark' });
              }}
            >
              {action.label}
            </DropdownMenuItem>
          ),
        )}

        <DropdownMenuSeparator />

        {/* Bottom: the User / Power-user experience toggle. A plain segmented
            control (not a menu item) so flipping it doesn't dismiss the dropup. */}
        <div className="px-2 pt-1 pb-1.5" data-testid="usermode-toggle">
          <div className="pd-menu-label px-0 pb-1">Mode</div>
          <SegmentedControl
            aria-label="Experience mode"
            className="w-full"
            value={userMode}
            onValueChange={(v) => void setUserMode(v as UserMode)}
            options={USER_MODE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          />
          <p className="mt-1.5 text-caption text-text-muted" data-testid="usermode-blurb">
            {userModeBlurb(userMode)}
          </p>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A 40×40 icon-only button for the collapsed rail (tooltip = its label). */
function RailButton({
  label,
  icon,
  onClick,
  testid,
}: {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  testid?: string;
}) {
  return (
    <button
      type="button"
      className="pd-rail-btn pd-focusable"
      aria-label={label}
      title={label}
      data-testid={testid}
      onClick={onClick}
    >
      {/* Round-14 #7: the glyph rides in the same --pd-icon-size centering box as
          an expanded row's icon (.pd-sidebar-row-icon), so its x is identical by
          construction in both flavors — no collapse "snap". */}
      <span className="pd-rail-btn-icon">{icon}</span>
    </button>
  );
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return 'now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

interface WorkspaceNavItem {
  id: string;
  label: string;
  icon: ComponentType<{ size?: number }>;
  onClick: () => void;
  testid: string;
}

export function SessionSidebar({
  open,
  onCollapse,
  onExpand,
  onTruncated,
  onOpenSettings,
  onOpenConnectors,
  onOpenStub,
}: {
  open: boolean;
  onCollapse: () => void;
  /** Expand the rail back to the full sidebar (round-8 rail). */
  onExpand: () => void;
  onTruncated: () => void;
  onOpenSettings: (section: SettingsSection) => void;
  /** Open the Codex-style connectors gallery (its own top-level view). */
  onOpenConnectors: () => void;
  onOpenStub: (stub: SidebarStub) => void;
}) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [query, setQuery] = useState('');
  const currentFile = usePiStore((s) => s.session?.sessionFile ?? null);
  const sessionId = usePiStore((s) => s.session?.sessionId ?? null);

  const refresh = useCallback(() => {
    void listSessions().then(setSessions);
  }, []);

  // Refresh on mount and whenever pi reports a session change (new turn/switch).
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId is a refresh trigger
  useEffect(() => {
    refresh();
  }, [refresh, sessionId]);

  // New chat starts a fresh session in the RUNNING pi (new_session RPC): it
  // resets the thread but does NOT dispose/respawn pi, so no "pi exited" crash
  // toast fires and nothing new bounces in the dock (the old restartPi path did
  // both). newSession() owns the store reset + custom-instructions re-arm.
  const onNewChat = useCallback(async () => {
    await newSession();
    refresh();
  }, [refresh]);

  const onOpen = async (file: string) => {
    const result = await switchSession(file);
    if (result.truncated) onTruncated();
    refresh();
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list =
      q.length === 0 ? sessions : sessions.filter((s) => s.title.toLowerCase().includes(q));
    return list.slice(0, 50);
  }, [sessions, query]);

  // Round-5 #22 / round-8 #4/#5: Workspace nav above the Chats list. Artifacts
  // removed; "Model management" routes to the settings model-manager surface
  // (section id `models` is the seam the parallel model-manager rework owns);
  // the redundant Settings entry is gone (it lives in the profile footer).
  const workspaceNav: WorkspaceNavItem[] = [
    {
      id: 'projects',
      label: 'Projects',
      icon: IconFolderPlus,
      onClick: () => onOpenStub('projects'),
      testid: 'nav-projects',
    },
    {
      id: 'models',
      label: 'Model management',
      icon: IconCpu,
      onClick: () => onOpenSettings('models'),
      testid: 'nav-model-management',
    },
    {
      id: 'connectors',
      label: 'Connectors',
      icon: IconConnector,
      onClick: onOpenConnectors,
      testid: 'nav-connectors',
    },
    {
      id: 'scheduled',
      label: 'Scheduled',
      icon: IconClock,
      onClick: () => onOpenStub('scheduled'),
      testid: 'nav-scheduled',
    },
    {
      id: 'skills',
      label: 'Skills',
      icon: IconSparkles,
      onClick: () => onOpenStub('skills'),
      testid: 'nav-skills',
    },
  ];

  // ── COLLAPSED: the narrow icon rail (round-8 #1/#3) ────────────────────────
  if (!open) {
    return (
      <Sidebar open={open} className="pd-sidebar--rail">
        {/* Traffic-light clearance strip (draggable); no button — the rail's own
            expand toggle sits just below it, clear of the macOS lights. */}
        <div className="pd-sidebar-tl h-[var(--pd-height-topbar)] shrink-0 [-webkit-app-region:drag]" />
        <div className="pd-rail">
          <RailButton
            label="Expand sidebar"
            testid="expand-sidebar"
            onClick={onExpand}
            icon={<IconSidebar size={16} />}
          />
          <RailButton label="Search chats" onClick={onExpand} icon={<IconSearch size={16} />} />
          <div className="pd-rail-sep" aria-hidden="true" />
          <RailButton
            label="New chat"
            testid="new-chat"
            onClick={() => void onNewChat()}
            icon={<IconPencil size={16} />}
          />
          <RailButton label="Chats" onClick={onExpand} icon={<IconChat size={16} />} />
          <RailButton
            label="Projects"
            testid="nav-projects"
            onClick={() => onOpenStub('projects')}
            icon={<IconFolderPlus size={16} />}
          />
          <RailButton
            label="Model management"
            testid="nav-model-management"
            onClick={() => onOpenSettings('models')}
            icon={<IconCpu size={16} />}
          />
          <RailButton
            label="Connectors"
            testid="nav-connectors"
            onClick={onOpenConnectors}
            icon={<IconConnector size={16} />}
          />
          {/* The rail runs the FULL sidebar height; this spacer pushes the
              profile button down to the foot, matching the expanded sidebar. */}
          <div className="pd-rail-spacer" aria-hidden="true" />
          <SidebarProfileMenu variant="rail" onOpenSettings={onOpenSettings} />
        </div>
      </Sidebar>
    );
  }

  // ── EXPANDED: the full sidebar ─────────────────────────────────────────────
  return (
    <Sidebar open={open}>
      {/* Traffic-light clearance strip (draggable). The collapse toggle now lives
          in the search row below (to the LEFT of the search), round-8 #1. */}
      <div className="pd-sidebar-tl h-[var(--pd-height-topbar)] shrink-0 [-webkit-app-region:drag]" />

      {/* Collapse toggle + click-to-expand search share one row; both align on
          the same 8px left inset as the rows below (img33). */}
      <div className="flex items-center gap-1 px-2 pb-2">
        <button
          type="button"
          aria-label="Collapse sidebar"
          data-testid="collapse-sidebar"
          onClick={onCollapse}
          className="pd-focusable flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-bg-hover"
        >
          <IconSidebar size={16} />
        </button>
        <div className="min-w-0 flex-1" data-testid="sidebar-search">
          <CollapsibleSearch placeholder="Search chats" value={query} onChange={setQuery} />
        </div>
      </div>

      <SidebarScroll>
        <SidebarRow
          icon={<IconPencil size={16} />}
          label="New chat"
          meta={<Kbd keys="⌘N" />}
          onClick={() => void onNewChat()}
          data-testid="new-chat"
        />

        <SidebarSection label="Workspace">
          {workspaceNav.map((item) => {
            const Icon = item.icon;
            return (
              <SidebarRow
                key={item.id}
                icon={<Icon size={16} />}
                label={item.label}
                onClick={item.onClick}
                data-testid={item.testid}
              />
            );
          })}
        </SidebarSection>

        <SidebarSection label="Chats">
          {filtered.length === 0 ? (
            <div className="px-2 py-1.5 text-footnote text-text-muted">
              {query.trim().length > 0 ? 'No matching chats.' : 'No sessions yet.'}
            </div>
          ) : (
            filtered.map((s) => (
              <SidebarRow
                key={s.file}
                icon={<IconChat size={16} />}
                label={s.title}
                meta={relativeTime(s.modifiedAt)}
                selected={currentFile === s.file}
                onClick={() => void onOpen(s.file)}
              />
            ))
          )}
        </SidebarSection>
      </SidebarScroll>

      {/* Bottom-left footer: ONE profile button that opens the dropup holding
          Settings, Toggle theme, and the User / Power-user toggle (round-12 #4).
          The `open-settings` / `toggle-mode` testids now live on the menu rows. */}
      <div className="m-1 mt-0 flex">
        <SidebarProfileMenu variant="full" onOpenSettings={onOpenSettings} />
      </div>
    </Sidebar>
  );
}
