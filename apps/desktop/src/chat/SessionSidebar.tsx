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

import type { OrgNodeView } from '@pi-desktop/coordination';
import {
  Checkbox,
  CollapsibleSearch,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  IconChat,
  IconChevronDown,
  IconClock,
  IconConnector,
  IconFolderPlus,
  IconMore,
  IconPencil,
  IconPin,
  IconPlus,
  IconSearch,
  IconSettings,
  IconSidebar,
  IconSparkles,
  IconTrash,
  Kbd,
  SegmentedControl,
  Sidebar,
  SidebarRow,
  SidebarScroll,
  SidebarSection,
  Spinner,
} from '@pi-desktop/ui';
import {
  type ComponentType,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { SessionSummary } from '../../electron/ipc-contract';
import type { ChatProject, UserMode } from '../../electron/settings/settings-contract';
import { IconCpu, IconMoon, IconSun } from '../settings/icons';
import type { SettingsSection } from '../settings/SettingsView';
import {
  assignChat,
  createProject,
  deleteChat,
  deleteProject,
  displayTitle,
  groupChats,
  renameChat,
  renameProject,
  setProjectCwd,
  togglePin,
  useChatOrg,
} from '../state/chat-org';
import { useChildAgentStore, useChildrenByParent } from '../state/child-agent-store';
import { useCorpStore } from '../state/corp-store';
import { useModalityStore } from '../state/modality-store';
import { listSessions, newSession, restartPi, switchSession } from '../state/pi-connect';
import { useProjectStore } from '../state/project-store';
import { usePiStore } from '../state/pi-slice';
import { setUserMode, useSettingsStore, useUserMode } from '../state/settings-store';
import { useThemeStore } from '../store/theme';
import { PROFILE_MENU_ACTIONS, USER_MODE_OPTIONS, userModeBlurb } from './profile-menu';

/** Nav destinations that don't have a real page yet — open a "coming soon" stub. */
export type SidebarStub = 'projects' | 'scheduled' | 'skills';

/**
 * Bottom-left profile control (round-12 #4). ONE compact button — the avatar
 * (rail) or the full "Bobble · Local" row (expanded) — that opens a DROPUP
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
          <span className="pd-sidebar-avatar">B</span>
        </span>
      </button>
    ) : (
      <button
        type="button"
        data-testid="profile-button"
        aria-label="Account, settings and theme"
        className="pd-sidebar-footer pd-focusable min-w-0 flex-1 cursor-pointer rounded-lg border-0 bg-transparent text-left font-[inherit] text-text-primary hover:bg-bg-hover"
      >
        <span className="pd-sidebar-avatar">B</span>
        <span className="pd-sidebar-footer-name">
          Bobble<span className="pd-sidebar-footer-plan"> · Local</span>
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

/** Stable empty-nodes reference so the corp-nodes selector never thrashes zustand. */
const NO_CORP_NODES: readonly OrgNodeView[] = [];

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

/** Stylized isometric cube — the 3D Studio modality glyph. */
function ModalityCube({ size = 16 }: { size?: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 3 L20 7.5 L12 12 L4 7.5 Z" fill="currentColor" opacity={0.9} />
      <path d="M4 7.5 L12 12 L12 21 L4 16.5 Z" fill="currentColor" opacity={0.5} />
      <path d="M20 7.5 L20 16.5 L12 21 L12 12 Z" fill="currentColor" opacity={0.7} />
    </svg>
  );
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
  // Fields for the optimistic row a brand-new chat needs before its file lands.
  const cwd = usePiStore((s) => s.session?.cwd ?? '');
  const windowTitle = usePiStore((s) => s.windowTitle);
  const messageCount = usePiStore((s) => s.messages.length);
  const firstUserText = usePiStore((s) => {
    const first = s.messages.find((m) => m.kind === 'user');
    return first !== undefined && first.kind === 'user' ? first.text : null;
  });
  // Fork branches are shown IN-THREAD via the ‹/› BranchSwitcher, never as their
  // own sidebar rows. pi:fork writes a real branch session file to disk, so without
  // this every edit-and-save would add a duplicate chat. Map each non-base branch
  // file → its group's base (files[0]); base files map to themselves.
  const branches = usePiStore((s) => s.branches);
  const { branchToBase, nonBaseBranchFiles } = useMemo(() => {
    const toBase = new Map<string, string>();
    const nonBase = new Set<string>();
    for (const group of Object.values(branches)) {
      const base = group.files[0];
      if (base === null || base === undefined) continue;
      group.files.forEach((f, i) => {
        if (f === null || i === 0) return;
        nonBase.add(f);
        toBase.set(f, base);
      });
    }
    return { branchToBase: toBase, nonBaseBranchFiles: nonBase };
  }, [branches]);
  // When viewing a branch, the BASE chat's row is the one that highlights / spins.
  const effectiveCurrentFile =
    currentFile !== null ? (branchToBase.get(currentFile) ?? currentFile) : null;

  // Is the (single, active) chat working? — the same signal the composer reads.
  // The app runs one pi session at a time, so only the active chat's row can show
  // a live spinner; when it goes idle we pop a per-row notice (see below).
  const isStreaming = usePiStore((s) => s.agent.isStreaming);
  const promptInFlight = usePiStore((s) => s.promptInFlight);
  const corpRunning = useCorpStore((s) => s.corpRunning);
  const busy = isStreaming || promptInFlight || corpRunning;
  // A chat generating in the BACKGROUND (the user is viewing another): its row —
  // not the viewed one — shows the spinner + gets the unread dot when it finishes.
  const bgRun = usePiStore((s) => s.bgRun);
  // Per-chat "unread" markers (blue = finished, orange = needs-input) shown as a dot
  // on the row until the user opens that chat. Only BACKGROUND chats get one — the
  // chat you're looking at needs no marker.
  const unread = usePiStore((s) => s.unread);
  const markUnread = usePiStore((s) => s.markUnread);
  const prevBgStreaming = useRef(false);

  // Child agents (subagents / roles running as their own pi instances) grouped by
  // their parent chat, for the nested dropdown. Expanded by default so a running
  // child is visible; a caret collapses it.
  const childrenByParent = useChildrenByParent();
  const viewedChildId = useChildAgentStore((s) => s.viewedChildId);
  const setViewedChild = useChildAgentStore((s) => s.setViewedChild);
  // A child that finished while unviewed leaves a blue dot on its row until opened.
  const childUnread = useChildAgentStore((s) => s.unread);
  // Running corp/hierarchy roles appear in the SAME nested dropdown under the chat
  // hosting the run; clicking one pins it so corp's own inline view shows it.
  // Default to a STABLE empty array OUTSIDE the selector — a `?? []` inside would
  // return a fresh reference every render and thrash zustand's snapshot.
  const corpNodes = useCorpStore((s) => s.situation?.chart.nodes) ?? NO_CORP_NODES;
  const pinnedNode = useCorpStore((s) => s.pinnedNode);
  const selectCorpNode = useCorpStore((s) => s.selectNode);
  const [collapsedParents, setCollapsedParents] = useState<Set<string>>(new Set());
  const toggleParent = (file: string) =>
    setCollapsedParents((prev) => {
      const next = new Set(prev);
      if (next.has(file)) next.delete(file);
      else next.add(file);
      return next;
    });

  // The "Modalities" dropdown — full-window studios reached from the sidebar.
  const setModalityView = useModalityStore((s) => s.setView);
  const [modalitiesOpen, setModalitiesOpen] = useState(true);

  // Chat organization (B1/B2): projects, pins, renames, delete — persisted state.
  const org = useChatOrg();
  const hideDeleteConfirm = useSettingsStore((s) => s.settings.hideDeleteChatConfirm);
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set());
  const toggleProject = (id: string) =>
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  // Inline-rename targets (a chat file or a project id) + the live draft text.
  const [renamingFile, setRenamingFile] = useState<string | null>(null);
  const [renamingProject, setRenamingProject] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  // The chat pending a delete confirmation (null = dialog closed).
  const [deleteTarget, setDeleteTarget] = useState<SessionSummary | null>(null);
  const [dontAskDelete, setDontAskDelete] = useState(false);

  const refresh = useCallback(() => {
    void listSessions().then(setSessions);
  }, []);

  // Refresh on mount and whenever pi reports a session change (new turn/switch).
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId is a refresh trigger
  useEffect(() => {
    refresh();
  }, [refresh, sessionId]);

  // A brand-new chat's session file is only written on its first turn, so re-list
  // when a turn starts/ends: the real disk row appears (replacing the optimistic
  // one) and its timestamp updates. `busy` is the trigger.
  // biome-ignore lint/correctness/useExhaustiveDependencies: busy is a refresh trigger
  useEffect(() => {
    refresh();
  }, [refresh, busy]);

  // A background chat finished (bgRun.streaming true→false) → mark ITS row unread so
  // a dot sits there until the user opens it. needs-input is marked when the request
  // arrives (see UiRequestHost), so it isn't downgraded here.
  useEffect(() => {
    const streaming = bgRun?.streaming === true;
    if (prevBgStreaming.current && !streaming && bgRun !== null) {
      markUnread(bgRun.sessionFile, 'finished');
    }
    prevBgStreaming.current = streaming;
  }, [bgRun, markUnread]);

  // New chat starts a fresh session in the RUNNING pi (new_session RPC): it
  // resets the thread but does NOT dispose/respawn pi, so no "pi exited" crash
  // toast fires and nothing new bounces in the dock (the old restartPi path did
  // both). newSession() owns the store reset + custom-instructions re-arm.
  const onNewChat = useCallback(async () => {
    await newSession();
    refresh();
  }, [refresh]);

  // Start a fresh chat that belongs to a project, ROOTED at the project's working
  // folder (or, when it has none, a stable shared sandbox named after the project —
  // so all its projectless chats share files while the user only sees the project
  // name). newSession() first (it handles the streaming/capture + pointer sync);
  // then re-root that fresh session at the target folder (the selectPath pattern:
  // restartPi with the same sessionPath, an existing cwd wins in resolveSessionCwd).
  // The new session's file is only written on its first turn, but the assignment
  // persists against that path, so it appears under the project once it has content.
  const newChatInProject = useCallback(
    async (project: ChatProject) => {
      await newSession();
      const file = usePiStore.getState().session?.sessionFile;

      let cwd = project.cwd;
      if (cwd === undefined || cwd.length === 0) {
        const res = await window.piDesktop
          .invoke('project:project-sandbox', { id: project.id })
          .catch(() => null);
        cwd = res?.path ?? undefined;
      }
      if (typeof cwd === 'string' && cwd.length > 0) {
        await restartPi({
          cwd,
          ...(typeof file === 'string' && file.length > 0 ? { sessionPath: file } : {}),
        });
      }

      if (typeof file === 'string' && file.length > 0) await assignChat(file, project.id);
      // Keep the electron project (composer chip / canvas file-tree root) in step
      // for a real folder; a projectless project stays on the sandbox and the chip
      // shows the project name instead (see ComposerBar).
      if (project.cwd !== undefined && project.cwd.length > 0) {
        await window.piDesktop.invoke('project:set', { path: project.cwd }).catch(() => null);
        await useProjectStore
          .getState()
          .load()
          .catch(() => {});
      }
      refresh();
    },
    [refresh],
  );

  // Attach a working folder to a project (native picker → persisted on the
  // ChatProject). New chats in it then root there instead of the shared sandbox.
  const setWorkingFolder = useCallback(
    async (project: ChatProject) => {
      const res = await window.piDesktop.invoke('project:pick-folder', undefined).catch(() => null);
      const picked = res?.path ?? null;
      if (picked === null) return;
      await setProjectCwd(project.id, picked);
      refresh();
    },
    [refresh],
  );

  // Drop a project's working folder → its chats fall back to the shared sandbox.
  const useSharedSandbox = useCallback(
    async (project: ChatProject) => {
      await setProjectCwd(project.id, null);
      refresh();
    },
    [refresh],
  );

  const onOpen = async (file: string) => {
    const result = await switchSession(file);
    if (result.truncated) onTruncated();
    refresh();
  };

  // Optimistic row: a brand-new chat has no `.jsonl` until its first write, so it
  // wouldn't list. The instant it has content, show it immediately (jedd: "appear
  // as soon as the first message is sent, that snappy") from the live session
  // pointer; the real disk row replaces it (same file key) on the next refresh.
  const displaySessions = useMemo(() => {
    // Hide fork-branch files (they belong to a base chat's ‹/› switcher).
    let list =
      nonBaseBranchFiles.size > 0
        ? sessions.filter((s) => !nonBaseBranchFiles.has(s.file))
        : sessions;
    const now = new Date().toISOString();
    const optimisticRow = (file: string, title: string): SessionSummary => ({
      file,
      id: file === effectiveCurrentFile ? (sessionId ?? '') : '',
      cwd,
      cwdLabel: '',
      startedAt: now,
      modifiedAt: now,
      messageCount: file === effectiveCurrentFile ? messageCount : 0,
      firstUserText: file === effectiveCurrentFile ? firstUserText : null,
      title,
    });
    // A chat generating in the BACKGROUND that has no disk file yet (a new chat
    // still on its first turn) would otherwise vanish from the sidebar until its
    // reply lands — keep it visible + spinning via an optimistic row.
    if (
      bgRun !== null &&
      bgRun.streaming &&
      !list.some((s) => s.file === bgRun.sessionFile) &&
      bgRun.sessionFile !== effectiveCurrentFile
    ) {
      list = [optimisticRow(bgRun.sessionFile, bgRun.title ?? 'New chat'), ...list];
    }
    // Optimistic row for the VIEWED brand-new chat (has content, no disk row yet) —
    // shows the moment its first message is sent (jedd: "that snappy").
    if (
      effectiveCurrentFile !== null &&
      messageCount > 0 &&
      !list.some((s) => s.file === effectiveCurrentFile)
    ) {
      list = [
        optimisticRow(effectiveCurrentFile, windowTitle ?? firstUserText ?? 'New chat'),
        ...list,
      ];
    }
    return list;
  }, [
    sessions,
    nonBaseBranchFiles,
    effectiveCurrentFile,
    sessionId,
    cwd,
    messageCount,
    firstUserText,
    windowTitle,
    bgRun,
  ]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list =
      q.length === 0
        ? displaySessions
        : displaySessions.filter((s) => displayTitle(s, org).toLowerCase().includes(q));
    return list.slice(0, 50);
  }, [displaySessions, query, org]);

  // Partition the flat list into project groups + ungrouped (pinned float to top).
  const grouped = useMemo(() => groupChats(filtered, org), [filtered, org]);

  // ── Inline rename + delete helpers (B2) ────────────────────────────────────
  const beginRenameChat = (s: SessionSummary) => {
    setRenamingProject(null);
    setRenamingFile(s.file);
    setRenameDraft(displayTitle(s, org));
  };
  const commitRenameChat = () => {
    if (renamingFile !== null) void renameChat(renamingFile, renameDraft);
    setRenamingFile(null);
  };
  const beginRenameProject = (id: string, name: string) => {
    setRenamingFile(null);
    setRenamingProject(id);
    setRenameDraft(name);
  };
  const commitRenameProject = () => {
    if (renamingProject !== null) void renameProject(renamingProject, renameDraft);
    setRenamingProject(null);
  };
  // Delete: skip the dialog when the user chose "don't ask again".
  const requestDeleteChat = (s: SessionSummary) => {
    if (hideDeleteConfirm) {
      void deleteChat(s.file).then(refresh);
      return;
    }
    setDontAskDelete(false);
    setDeleteTarget(s);
  };
  const confirmDeleteChat = async () => {
    if (deleteTarget === null) return;
    if (dontAskDelete) await useSettingsStore.getState().update({ hideDeleteChatConfirm: true });
    await deleteChat(deleteTarget.file);
    setDeleteTarget(null);
    refresh();
  };
  const createProjectAndAssign = async (file?: string) => {
    const id = await createProject('New project');
    if (file !== undefined) await assignChat(file, id);
    beginRenameProject(id, 'New project');
  };

  /** One chat row: the A4 icon-swap row + its hover 3-dot menu (B2) + the nested
   * agent dropdown (A3/A4). Shared by the project groups and the ungrouped list. */
  const renderChat = (s: SessionSummary): ReactNode => {
    const running =
      (busy && bgRun === null && effectiveCurrentFile === s.file) ||
      (bgRun?.streaming === true && bgRun.sessionFile === s.file);
    const unreadKind = unread[s.file];
    const kids = childrenByParent.get(s.file) ?? [];
    const corpKids = corpRunning && effectiveCurrentFile === s.file ? corpNodes : [];
    const hasKids = kids.length > 0 || corpKids.length > 0;
    const expanded = hasKids && !collapsedParents.has(s.file);
    const isFocused = effectiveCurrentFile === s.file && viewedChildId === null;
    const title = displayTitle(s, org);
    const pinned = org.pinned.includes(s.file);
    const assignedTo = org.assignments[s.file];

    // Editing → the row becomes an inline rename input.
    if (renamingFile === s.file) {
      return (
        <div key={s.file} className="px-2 py-0.5">
          <input
            className="pd-chat-rename-input pd-focusable"
            data-testid={`chat-rename-input-${title}`}
            ref={(el) => el?.focus()}
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRenameChat();
              else if (e.key === 'Escape') setRenamingFile(null);
            }}
            onBlur={commitRenameChat}
          />
        </div>
      );
    }

    return (
      <div key={s.file} className="pd-chatrow">
        <SidebarRow
          // No caret by default; a chat with agents swaps its bubble for a fold
          // caret ON HOVER (CSS) so nothing shifts (jedd A4).
          icon={
            hasKids ? (
              <span className="pd-chat-icon-swap">
                <IconChat size={16} className="pd-chat-icon-bubble" />
                <IconChevronDown
                  size={14}
                  className={`pd-chat-icon-caret ${expanded ? '' : '-rotate-90'}`}
                />
              </span>
            ) : (
              <IconChat size={16} />
            )
          }
          label={title}
          // Priority: needs-input dot > running spinner > finished dot > pin glyph > time.
          meta={
            unreadKind === 'needs-input' ? (
              <span className="pd-chat-dot pd-chat-dot--needs-input" />
            ) : running ? (
              <Spinner size={14} />
            ) : unreadKind === 'finished' ? (
              <span className="pd-chat-dot pd-chat-dot--finished" />
            ) : pinned ? (
              <IconPin size={13} className="text-text-muted" />
            ) : (
              relativeTime(s.modifiedAt)
            )
          }
          selected={isFocused}
          data-testid={`chat-row-${title}`}
          onClick={() => {
            if (isFocused && hasKids) {
              toggleParent(s.file);
              return;
            }
            setViewedChild(null);
            void onOpen(s.file);
          }}
        />
        {/* Hover-revealed 3-dot menu. A SIBLING of the row button (not nested) so
            it's valid HTML; :focus-within keeps it up while the menu is open. */}
        <div className="pd-chatrow-actions">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="pd-chatrow-dots pd-focusable"
                aria-label="Chat actions"
                data-testid={`chat-menu-${title}`}
              >
                <IconMore size={16} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="bottom" sideOffset={4} className="min-w-[190px]">
              <DropdownMenuItem icon={<IconPencil size={16} />} onSelect={() => beginRenameChat(s)}>
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem
                icon={<IconPin size={16} />}
                onSelect={() => void togglePin(s.file)}
              >
                {pinned ? 'Unpin' : 'Pin'}
              </DropdownMenuItem>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger icon={<IconFolderPlus size={16} />}>
                  Add to project
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="min-w-[180px]">
                  {org.projects.length === 0 ? (
                    <DropdownMenuItem disabled>No projects yet</DropdownMenuItem>
                  ) : (
                    org.projects.map((p) => (
                      <DropdownMenuItem
                        key={p.id}
                        hint={assignedTo === p.id ? '✓' : undefined}
                        onSelect={() => void assignChat(s.file, p.id)}
                      >
                        {p.name}
                      </DropdownMenuItem>
                    ))
                  )}
                  {assignedTo !== undefined ? (
                    <DropdownMenuItem onSelect={() => void assignChat(s.file, null)}>
                      Remove from project
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    icon={<IconPlus size={16} />}
                    onSelect={() => void createProjectAndAssign(s.file)}
                  >
                    New project…
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                danger
                icon={<IconTrash size={16} />}
                onSelect={() => requestDeleteChat(s)}
              >
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {expanded ? (
          <div className="pd-child-rows" data-testid="child-rows">
            {kids.map((c) => (
              <button
                type="button"
                key={c.childId}
                className="pd-child-row pd-focusable"
                data-testid={`child-row-${c.childId}`}
                data-selected={viewedChildId === c.childId || undefined}
                onClick={() => setViewedChild(c.childId)}
              >
                <span className="pd-child-row-icon">
                  <IconChat size={13} />
                </span>
                <span className="pd-child-row-label">{c.title}</span>
                {c.running ? (
                  <Spinner size={12} />
                ) : childUnread[c.childId] !== undefined ? (
                  <span className="pd-chat-dot pd-chat-dot--finished" />
                ) : null}
              </button>
            ))}
            {corpKids.map((node) => (
              <button
                type="button"
                key={`corp:${node.id}`}
                className="pd-child-row pd-focusable"
                data-testid={`corp-row-${node.id}`}
                data-selected={pinnedNode?.id === node.id || undefined}
                onClick={() => {
                  setViewedChild(null);
                  selectCorpNode(node);
                }}
              >
                <span className="pd-child-row-icon">
                  <IconChat size={13} />
                </span>
                <span className="pd-child-row-label">{node.name}</span>
                {node.state === 'working' ? <Spinner size={12} /> : null}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    );
  };

  // Round-5 #22 / round-8 #4/#5: Workspace nav above the Chats list. Artifacts
  // removed; "Model management" routes to the settings model-manager surface
  // (section id `models` is the seam the parallel model-manager rework owns);
  // the redundant Settings entry is gone (it lives in the profile footer).
  const workspaceNav: WorkspaceNavItem[] = [
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

        {/* Modalities — full-window studios (3D now; image/video/audio later). A
            fold-down dropdown so more can be added without crowding the rail. */}
        <div className="pd-sidebar-section" data-testid="modalities">
          <button
            type="button"
            className="pd-sidebar-row pd-focusable"
            data-testid="modalities-toggle"
            aria-expanded={modalitiesOpen}
            onClick={() => setModalitiesOpen((o) => !o)}
          >
            <span className="pd-sidebar-row-icon">
              <ModalityCube size={16} />
            </span>
            <span className="pd-sidebar-row-label">Modalities</span>
            <span className="pd-sidebar-row-meta">
              <IconChevronDown size={14} className={modalitiesOpen ? '' : '-rotate-90'} />
            </span>
          </button>
          {modalitiesOpen ? (
            <div className="pd-child-rows" data-testid="modality-rows">
              <button
                type="button"
                className="pd-child-row pd-focusable"
                data-testid="modality-3d"
                onClick={() => setModalityView('3d')}
              >
                <span className="pd-child-row-icon">
                  <ModalityCube size={13} />
                </span>
                <span className="pd-child-row-label">3D Studio</span>
              </button>
            </div>
          ) : null}
        </div>

        {/* Projects (B1) — Codex-style named groups; each folds to reveal its
            chats. The "+" adds a project (then opens it for inline rename). */}
        <SidebarSection
          label="Projects"
          actions={
            <button
              type="button"
              className="pd-section-action pd-focusable"
              aria-label="New project"
              data-testid="new-project"
              onClick={() => void createProjectAndAssign()}
            >
              <IconPlus size={14} />
            </button>
          }
        >
          {grouped.projects.length === 0 ? (
            <div className="px-2 py-1.5 text-footnote text-text-muted">No projects yet.</div>
          ) : (
            grouped.projects.map(({ project, chats, auto }) => {
              const pExpanded = !collapsedProjects.has(project.id);
              if (renamingProject === project.id) {
                return (
                  <div key={project.id} className="px-2 py-0.5">
                    <input
                      className="pd-chat-rename-input pd-focusable"
                      data-testid={`project-rename-input-${project.id}`}
                      ref={(el) => el?.focus()}
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRenameProject();
                        else if (e.key === 'Escape') setRenamingProject(null);
                      }}
                      onBlur={commitRenameProject}
                    />
                  </div>
                );
              }
              return (
                <div key={project.id}>
                  {/* Auto (directory-derived) folders have no menu — they re-derive
                      from the working dir. Only user-made projects rename/delete. */}
                  <div className={auto ? '' : 'pd-chatrow'}>
                    <SidebarRow
                      icon={
                        <span className="pd-chat-icon-swap">
                          <IconFolderPlus size={16} className="pd-chat-icon-bubble" />
                          <IconChevronDown
                            size={14}
                            className={`pd-chat-icon-caret ${pExpanded ? '' : '-rotate-90'}`}
                          />
                        </span>
                      }
                      label={project.name}
                      meta={
                        <span className="text-text-muted">
                          {chats.length > 0 ? chats.length : ''}
                        </span>
                      }
                      data-testid={`project-row-${project.id}`}
                      onClick={() => toggleProject(project.id)}
                    />
                    {auto ? null : (
                      <div className="pd-chatrow-actions">
                        <button
                          type="button"
                          className="pd-chatrow-dots pd-focusable"
                          aria-label="New chat in this project"
                          title="New chat in this project"
                          data-testid={`project-new-chat-${project.id}`}
                          onClick={() => void newChatInProject(project)}
                        >
                          <IconPlus size={16} />
                        </button>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              type="button"
                              className="pd-chatrow-dots pd-focusable"
                              aria-label="Project actions"
                              data-testid={`project-menu-${project.id}`}
                            >
                              <IconMore size={16} />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" side="bottom" sideOffset={4}>
                            <DropdownMenuItem
                              icon={<IconPencil size={16} />}
                              onSelect={() => beginRenameProject(project.id, project.name)}
                            >
                              Rename project
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              icon={<IconFolderPlus size={16} />}
                              onSelect={() => void setWorkingFolder(project)}
                            >
                              {project.cwd ? 'Change working folder…' : 'Set working folder…'}
                            </DropdownMenuItem>
                            {project.cwd ? (
                              <DropdownMenuItem onSelect={() => void useSharedSandbox(project)}>
                                Use shared sandbox
                              </DropdownMenuItem>
                            ) : null}
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              danger
                              icon={<IconTrash size={16} />}
                              onSelect={() => void deleteProject(project.id)}
                            >
                              Delete project
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    )}
                  </div>
                  {pExpanded ? (
                    <div className="pd-project-chats" data-testid={`project-chats-${project.id}`}>
                      {chats.length === 0 ? (
                        <div className="px-2 py-1 text-footnote text-text-muted">Empty</div>
                      ) : (
                        chats.map(renderChat)
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </SidebarSection>

        <SidebarSection label="Chats">
          {filtered.length === 0 ? (
            <div className="px-2 py-1.5 text-footnote text-text-muted">
              {query.trim().length > 0 ? 'No matching chats.' : 'No sessions yet.'}
            </div>
          ) : grouped.ungrouped.length === 0 ? (
            <div className="px-2 py-1.5 text-footnote text-text-muted">
              All chats are in projects.
            </div>
          ) : (
            grouped.ungrouped.map(renderChat)
          )}
        </SidebarSection>
      </SidebarScroll>

      {/* Delete-chat confirmation (B2), skippable via "Don't ask again". */}
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(o) => {
          if (!o) setDeleteTarget(null);
        }}
      >
        <DialogContent data-testid="delete-chat-dialog" className="max-w-[400px]">
          <DialogHeader>
            <DialogTitle>Delete chat?</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <p className="text-body text-text-secondary">
              “{deleteTarget !== null ? displayTitle(deleteTarget, org) : ''}” will be permanently
              deleted. This can’t be undone.
            </p>
            <label
              htmlFor="delete-chat-dontask"
              className="mt-3 flex cursor-pointer items-center gap-2 text-footnote text-text-muted"
            >
              <Checkbox
                id="delete-chat-dontask"
                checked={dontAskDelete}
                onCheckedChange={(v) => setDontAskDelete(v === true)}
                data-testid="delete-chat-dontask"
              />
              Don’t ask again
            </label>
          </DialogBody>
          <DialogFooter>
            <button
              type="button"
              className="pd-btn-ghost pd-focusable"
              onClick={() => setDeleteTarget(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="pd-btn-danger pd-focusable"
              data-testid="delete-chat-confirm"
              onClick={() => void confirmDeleteChat()}
            >
              Delete
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bottom-left footer: ONE profile button that opens the dropup holding
          Settings, Toggle theme, and the User / Power-user toggle (round-12 #4).
          The `open-settings` / `toggle-mode` testids now live on the menu rows. */}
      <div className="m-1 mt-0 flex">
        <SidebarProfileMenu variant="full" onOpenSettings={onOpenSettings} />
      </div>
    </Sidebar>
  );
}
