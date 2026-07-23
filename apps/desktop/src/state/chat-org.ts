/**
 * Chat organization — projects, pins, per-chat renames, and delete (B1/B2).
 *
 * State lives in DesktopSettings.chatOrg (persisted, keyed by session FILE path so
 * nothing touches the read-only session JSONL). Every mutator read-modify-writes
 * the whole `chatOrg` through settings-store.update; the sidebar reads the live
 * value via {@link useChatOrg} and groups the flat session list with {@link groupChats}.
 */
import type { SessionSummary } from '../../electron/ipc-contract';
import type { ChatOrganization, ChatProject } from '../../electron/settings/settings-contract';
import { useSettingsStore } from './settings-store';

const EMPTY: ChatOrganization = { projects: [], assignments: {}, pinned: [], titles: {} };

/** Reactive: the live chat-organization state. */
export function useChatOrg(): ChatOrganization {
  return useSettingsStore((s) => s.settings.chatOrg) ?? EMPTY;
}

function current(): ChatOrganization {
  return useSettingsStore.getState().settings.chatOrg ?? EMPTY;
}

function write(next: ChatOrganization): Promise<void> {
  return useSettingsStore.getState().update({ chatOrg: next });
}

function newId(): string {
  return typeof crypto?.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Create a project and return its id. */
export async function createProject(name: string): Promise<string> {
  const id = `proj-${newId()}`;
  const c = current();
  await write({
    ...c,
    projects: [...c.projects, { id, name: name.trim() || 'New project' }],
  });
  return id;
}

export async function renameProject(id: string, name: string): Promise<void> {
  const c = current();
  const trimmed = name.trim();
  if (trimmed.length === 0) return;
  await write({
    ...c,
    projects: c.projects.map((p) => (p.id === id ? { ...p, name: trimmed } : p)),
  });
}

/** Delete a project (its chats fall back to ungrouped — the chats themselves stay). */
export async function deleteProject(id: string): Promise<void> {
  const c = current();
  const assignments = { ...c.assignments };
  for (const [file, pid] of Object.entries(assignments)) {
    if (pid === id) delete assignments[file];
  }
  await write({ ...c, projects: c.projects.filter((p) => p.id !== id), assignments });
}

/** Assign a chat to a project, or pass null to un-assign (→ ungrouped). */
export async function assignChat(file: string, projectId: string | null): Promise<void> {
  const c = current();
  const assignments = { ...c.assignments };
  if (projectId === null) delete assignments[file];
  else assignments[file] = projectId;
  await write({ ...c, assignments });
}

/** Toggle a chat's pinned state. */
export async function togglePin(file: string): Promise<void> {
  const c = current();
  const pinned = c.pinned.includes(file) ? c.pinned.filter((f) => f !== file) : [...c.pinned, file];
  await write({ ...c, pinned });
}

/** Rename a chat (empty clears the override → falls back to the derived title). */
export async function renameChat(file: string, title: string): Promise<void> {
  const c = current();
  const titles = { ...c.titles };
  const trimmed = title.trim();
  if (trimmed.length === 0) delete titles[file];
  else titles[file] = trimmed;
  await write({ ...c, titles });
}

/** Forget everything this app tracked about a chat file (called after delete). */
export async function forgetChat(file: string): Promise<void> {
  const c = current();
  const assignments = { ...c.assignments };
  const titles = { ...c.titles };
  delete assignments[file];
  delete titles[file];
  await write({ ...c, assignments, titles, pinned: c.pinned.filter((f) => f !== file) });
}

/**
 * Delete a chat: remove its session file from disk AND forget its org state.
 * Returns the IPC result so the caller can surface a failure.
 */
export async function deleteChat(file: string): Promise<{ ok: boolean; error?: string }> {
  const res = await window.piDesktop.invoke('fs:delete-session', { file });
  if (res.ok) await forgetChat(file);
  return res;
}

/** The user rename for a chat, if any (overrides the derived title). */
export function displayTitle(summary: SessionSummary, org: ChatOrganization): string {
  return org.titles[summary.file] ?? summary.title;
}

export interface GroupedChats {
  projects: Array<{ project: ChatProject; chats: SessionSummary[] }>;
  /** Chats not assigned to any project. */
  ungrouped: SessionSummary[];
}

/** Pinned chats float to the top of their container; order is otherwise preserved. */
function pinnedFirst(chats: SessionSummary[], pinned: Set<string>): SessionSummary[] {
  if (pinned.size === 0) return chats;
  const pin: SessionSummary[] = [];
  const rest: SessionSummary[] = [];
  for (const c of chats) (pinned.has(c.file) ? pin : rest).push(c);
  return [...pin, ...rest];
}

/**
 * Partition the flat session list into project groups + ungrouped, honoring the
 * manual assignments and floating pinned chats to the top of each container. A
 * chat assigned to a project that no longer exists falls back to ungrouped.
 */
export function groupChats(sessions: SessionSummary[], org: ChatOrganization): GroupedChats {
  const pinned = new Set(org.pinned);
  const byProject = new Map<string, SessionSummary[]>();
  const ungrouped: SessionSummary[] = [];
  const known = new Set(org.projects.map((p) => p.id));
  for (const s of sessions) {
    const pid = org.assignments[s.file];
    if (pid !== undefined && known.has(pid)) {
      const arr = byProject.get(pid);
      if (arr === undefined) byProject.set(pid, [s]);
      else arr.push(s);
    } else {
      ungrouped.push(s);
    }
  }
  return {
    projects: org.projects.map((project) => ({
      project,
      chats: pinnedFirst(byProject.get(project.id) ?? [], pinned),
    })),
    ungrouped: pinnedFirst(ungrouped, pinned),
  };
}
