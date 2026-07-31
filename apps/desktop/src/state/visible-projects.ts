/**
 * THE project list — the one the sidebar shows, and therefore the only one the
 * composer's picker may offer.
 *
 * They were two different lists. The sidebar shows manual projects plus folders
 * derived from chats that actually exist ({@link groupChats}); the picker showed
 * every working folder the app had ever been pointed at, from the electron
 * project store. After a day of probe runs jedd opened the dropdown and found
 * `unify-plan6`, `unify-plan5`, `unify-plan4`, `unify-plan3`, `unify-plan2`,
 * `unify-plan`, `unify-display`, `unify-smoke` — eight throwaway directories, not
 * one of which appeared in his sidebar. His rule: "nothing should be in this
 * dropdown if it isn't in the left sidebar."
 *
 * Filtering one list to match the other would drift again the first time either
 * changed. So there is one derivation, here, and both surfaces read it.
 *
 * The session list is fetched once and shared: the sidebar was already loading
 * it, and a second component doing its own IPC round-trip for the same answer is
 * how the two got to disagree in the first place.
 */

import { useEffect } from 'react';
import { create } from 'zustand';
import type { SessionSummary } from '../../electron/ipc-contract';
import { AUTO_PROJECT_PREFIX, groupChats, useChatOrg } from './chat-org';
import { listSessions } from './pi-connect';

interface SessionListState {
  sessions: SessionSummary[];
  loaded: boolean;
  set: (sessions: SessionSummary[]) => void;
}

/** The shared session list. One fetch, every reader. */
export const useSessionListStore = create<SessionListState>((set) => ({
  sessions: [],
  loaded: false,
  set: (sessions) => set({ sessions, loaded: true }),
}));

let inFlight: Promise<void> | undefined;

/** Fetch the session list if nobody has yet; concurrent callers share the trip. */
export async function ensureSessionList(): Promise<void> {
  if (useSessionListStore.getState().loaded) return;
  if (inFlight !== undefined) return await inFlight;
  inFlight = listSessions()
    .then((sessions) => useSessionListStore.getState().set(sessions as SessionSummary[]))
    .catch(() => useSessionListStore.getState().set([]))
    .finally(() => {
      inFlight = undefined;
    });
  return await inFlight;
}

/** Push a freshly-loaded list in (the sidebar already polls; share its answer). */
export function publishSessionList(sessions: SessionSummary[]): void {
  useSessionListStore.getState().set(sessions);
}

/** One selectable project, as both the sidebar and the picker understand it. */
export interface VisibleProject {
  readonly id: string;
  readonly name: string;
  /** A directory-derived folder rather than a project the user made. */
  readonly auto: boolean;
}

/** Pure: the projects the sidebar would render, in the sidebar's own order. */
export function visibleProjectsOf(
  sessions: readonly SessionSummary[],
  org: ReturnType<typeof useChatOrg>,
): VisibleProject[] {
  return groupChats([...sessions], org).projects.map((g) => ({
    id: g.project.id,
    name: g.project.name,
    auto: g.auto,
  }));
}

/** One directory, one spelling: trailing slashes off (a lone `/` stays `/`), so
 * the folder pi was rooted at compares equal to the folder a chat recorded. Main
 * cleans project paths the same way (project-main.ts `projectFor`). */
function normalizeDir(dir: string | null | undefined): string | null {
  if (dir === null || dir === undefined || dir.length === 0) return null;
  return dir.replace(/\/+$/, '') || '/';
}

/** The working folder behind a directory-derived entry, or null for a project the
 * user made — those are identified by id, and never by a path. */
export function autoProjectPath(project: VisibleProject): string | null {
  if (!project.auto || !project.id.startsWith(AUTO_PROJECT_PREFIX)) return null;
  return normalizeDir(project.id.slice(AUTO_PROJECT_PREFIX.length));
}

/**
 * Which entry is SELECTED — answered in this list's own id space, which is the
 * whole reason this lives next to the list.
 *
 * The rows are {@link visibleProjectsOf} ids: a project the user made (a chatOrg
 * id) or a folder derived from the chats in it (`cwd:<path>`). The active working
 * folder, though, is tracked by the ELECTRON project store, whose ids are path
 * hashes (`p_1a2b`) belonging to neither. The composer chip compared those two
 * spaces, so picking a folder set the working directory and then nothing could
 * find it again: no check mark, and a chip still reading "No project" — the click
 * looked like it had done nothing at all. Paths are the one thing both spaces
 * agree on, so that is what the folder match uses.
 *
 * A chat that lives in a project the user made keeps that as its selection (the
 * chip's "this chat's project" meaning); otherwise the folder pi is rooted at
 * wins. Pass `workingPath: null` when the conversation is running in a sandbox —
 * nothing is selected then.
 */
export function activeVisibleProjectId(
  visible: readonly VisibleProject[],
  opts: { orgProjectId?: string | null; workingPath?: string | null },
): string | null {
  const org = opts.orgProjectId ?? null;
  if (org !== null && visible.some((p) => p.id === org)) return org;
  const path = normalizeDir(opts.workingPath);
  if (path === null) return null;
  return visible.find((p) => autoProjectPath(p) === path)?.id ?? null;
}

/**
 * The projects a user can pick — exactly what their sidebar lists. Loads the
 * session list on first use, so a picker mounted before the sidebar still agrees
 * with it.
 */
export function useVisibleProjects(): VisibleProject[] {
  const sessions = useSessionListStore((s) => s.sessions);
  const org = useChatOrg();
  useEffect(() => {
    void ensureSessionList();
  }, []);
  return visibleProjectsOf(sessions, org);
}
