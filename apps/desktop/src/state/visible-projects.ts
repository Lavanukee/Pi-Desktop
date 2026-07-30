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
import { groupChats, useChatOrg } from './chat-org';
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
