/**
 * Session sidebar: floating (claude) / frosted (codex) panel that slides in/out
 * (round-3 #A6). Hosts the collapse control (just right of the traffic lights,
 * #A5), a search field, New chat, then the Workspace nav (Projects, Artifacts,
 * Connectors, Scheduled, Skills, Settings) ABOVE the Chats history (round-5 #22).
 * Connectors + Settings are wired to real destinations; the not-yet-built pages
 * open a "coming soon" stub (#A6 follow-up). Sessions are read from the fs
 * channels; mutations go through pi.
 */

import {
  IconButton,
  IconChat,
  IconClock,
  IconConnector,
  IconFile,
  IconFolderPlus,
  IconPencil,
  IconSettings,
  IconSidebar,
  IconSparkles,
  Kbd,
  SearchInput,
  Sidebar,
  SidebarRow,
  SidebarScroll,
  SidebarSection,
} from '@pi-desktop/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SessionSummary } from '../../electron/ipc-contract';
import { IconMoon, IconSun } from '../settings/icons';
import type { SettingsSection } from '../settings/SettingsView';
import { listSessions, newSession, switchSession } from '../state/pi-connect';
import { usePiStore } from '../state/pi-slice';
import { useSettingsStore } from '../state/settings-store';
import { useThemeStore } from '../store/theme';

/** Nav destinations that don't have a real page yet — open a "coming soon" stub. */
export type SidebarStub = 'projects' | 'artifacts' | 'scheduled' | 'skills';

/**
 * Light/dark quick-toggle glyph (round-5 #15, relocated to the sidebar footer in
 * round-7): a sun (dark mode) and moon (light mode) cross-fade + rotate on flip.
 * Reduced-motion drops the transition (CSS).
 */
function ThemeToggleIcon({ mode }: { mode: 'dark' | 'light' }) {
  return (
    <span className="pd-theme-toggle" data-mode={mode} aria-hidden>
      <IconSun className="pd-theme-toggle-sun" />
      <IconMoon className="pd-theme-toggle-moon" />
    </span>
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

export function SessionSidebar({
  open,
  onCollapse,
  onTruncated,
  onOpenSettings,
  onOpenStub,
}: {
  open: boolean;
  onCollapse: () => void;
  onTruncated: () => void;
  onOpenSettings: (section: SettingsSection) => void;
  onOpenStub: (stub: SidebarStub) => void;
}) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [query, setQuery] = useState('');
  const currentFile = usePiStore((s) => s.session?.sessionFile ?? null);
  const sessionId = usePiStore((s) => s.session?.sessionId ?? null);
  const mode = useThemeStore((s) => s.mode);
  const setTheme = useSettingsStore((s) => s.setTheme);

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
  const onNewChat = async () => {
    await newSession();
    refresh();
  };

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

  return (
    <Sidebar open={open}>
      {/* Traffic-light clearance strip. It shares the TOP BAR's height so the
          collapse control is vertically centered on the same band as the traffic
          lights + top-bar controls. Round-6 (img53): `.pd-sidebar-tl` pins the
          toggle to the SAME window-x (~80px) as the top-bar's re-open button in
          BOTH flavors — accounting for claude's 8px floating-panel margin — so it
          sits cleanly past the lights and never jumps on collapse/expand. */}
      <div className="pd-sidebar-tl flex h-[var(--pd-height-topbar)] shrink-0 items-center [-webkit-app-region:drag] pr-2">
        <button
          type="button"
          aria-label="Collapse sidebar"
          data-testid="collapse-sidebar"
          onClick={onCollapse}
          className="[-webkit-app-region:no-drag] pd-focusable flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-bg-hover"
        >
          <IconSidebar size={16} />
        </button>
      </div>

      {/* Search + the scroll list below share ONE 8px left inset (px-2 ==
          SidebarScroll's padding), so the search field, New chat, and the Chats
          rows all line their rounded boxes up on the same left edge (img33). */}
      <div className="px-2 pb-2">
        <SearchInput
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search chats"
          aria-label="Search chats"
          data-testid="sidebar-search"
        />
      </div>

      <SidebarScroll>
        <SidebarRow
          icon={<IconPencil size={16} />}
          label="New chat"
          meta={<Kbd keys="⌘N" />}
          onClick={() => void onNewChat()}
          data-testid="new-chat"
        />

        {/* Round-5 #22: the Workspace nav sits ABOVE the Chats/Recents list. */}
        <SidebarSection label="Workspace">
          <SidebarRow
            icon={<IconFolderPlus size={16} />}
            label="Projects"
            onClick={() => onOpenStub('projects')}
            data-testid="nav-projects"
          />
          <SidebarRow
            icon={<IconFile size={16} />}
            label="Artifacts"
            onClick={() => onOpenStub('artifacts')}
            data-testid="nav-artifacts"
          />
          <SidebarRow
            icon={<IconConnector size={16} />}
            label="Connectors"
            onClick={() => onOpenSettings('connectors')}
            data-testid="nav-connectors"
          />
          <SidebarRow
            icon={<IconClock size={16} />}
            label="Scheduled"
            onClick={() => onOpenStub('scheduled')}
            data-testid="nav-scheduled"
          />
          <SidebarRow
            icon={<IconSparkles size={16} />}
            label="Skills"
            onClick={() => onOpenStub('skills')}
            data-testid="nav-skills"
          />
          <SidebarRow
            icon={<IconSettings size={16} />}
            label="Settings"
            onClick={() => onOpenSettings('appearance')}
            data-testid="nav-settings"
          />
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

      {/* Bottom-left footer: the profile row (PRIMARY settings entry point,
          relocated from the top-bar gear) plus the light/dark quick-toggle
          (round-7: moved here from the top bar). `open-settings` + `toggle-mode`
          testids are kept so the existing probes still reach them. */}
      <div className="m-1 mt-0 flex items-center gap-1">
        <button
          type="button"
          data-testid="open-settings"
          aria-label="Open settings"
          onClick={() => onOpenSettings('personalization')}
          className="pd-sidebar-footer pd-focusable min-w-0 flex-1 cursor-pointer rounded-lg border-0 bg-transparent text-left font-[inherit] text-text-primary hover:bg-bg-hover"
        >
          <span className="pd-sidebar-avatar">P</span>
          <span className="pd-sidebar-footer-name">
            Pi Desktop<span className="pd-sidebar-footer-plan"> · Local</span>
          </span>
          <IconSettings size={16} className="shrink-0 text-text-muted" />
        </button>
        <IconButton
          aria-label={mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          data-testid="toggle-mode"
          className="shrink-0"
          onClick={() => void setTheme({ mode: mode === 'dark' ? 'light' : 'dark' })}
        >
          <ThemeToggleIcon mode={mode} />
        </IconButton>
      </div>
    </Sidebar>
  );
}
